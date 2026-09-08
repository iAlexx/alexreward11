import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { computeMembershipBonusAtomic, computeQuotedRewardAtomic } from './arithmetic.js';
import {
  releaseMembershipBonusBudgetReservation,
  reserveMembershipBonusBudget,
} from './bonus-budgets.js';
import { releaseRewardBudgetReservation, reserveRewardBudget } from './budgets.js';
import { withLedgerTransaction, type LedgerDb } from './db.js';
import { RewardDomainError } from './errors.js';
import {
  assertNewQuotesAllowed,
  isMembershipBonusPaused,
  requireBonusUnavailablePolicy,
} from './guardrails.js';
import { insertOutboxEvent } from './outbox.js';
import { resolveRewardRule } from './rules.js';
import { markSimulatedSourceStarted } from './simulated.js';
import {
  ELIGIBLE_REWARD_BONUS_CODE,
  type AppliedEconomics,
  type CreateRewardQuoteCommand,
  type MembershipBonusUnavailablePolicy,
  type RewardQuoteResult,
} from './types.js';

interface BonusResolution {
  readonly membershipId: string | null;
  readonly entitlementRuleVersionId: string | null;
  readonly bonusRuleVersion: number | null;
  readonly bonusBps: number | null;
  readonly bonusAmountAtomic: bigint;
  readonly bonusUnavailablePolicy: MembershipBonusUnavailablePolicy | null;
}

async function resolveMembershipBonus(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly baseAmountAtomic: bigint;
    readonly evaluateMembershipBonus: boolean;
    readonly policy: MembershipBonusUnavailablePolicy | null;
    readonly environment: 'LOCAL' | 'STAGING' | 'PRODUCTION';
    readonly asOf: Date;
    readonly membershipBonusBudgetPeriodId?: string | null;
  },
): Promise<BonusResolution> {
  const empty: BonusResolution = {
    membershipId: null,
    entitlementRuleVersionId: null,
    bonusRuleVersion: null,
    bonusBps: null,
    bonusAmountAtomic: 0n,
    bonusUnavailablePolicy: input.policy,
  };

  if (!input.evaluateMembershipBonus) {
    return { ...empty, bonusUnavailablePolicy: null };
  }

  const policy = requireBonusUnavailablePolicy(true, input.policy);
  const paused = await isMembershipBonusPaused(client, input.environment);

  const membership = await client.query<{
    id: string;
    membership_plan_id: string;
  }>(
    `SELECT um.id, um.membership_plan_id
     FROM user_memberships um
     WHERE um.user_id = $1::uuid
       AND um.status = 'ACTIVE'
       AND (um.expires_at IS NULL OR um.expires_at > $2::timestamptz)
     ORDER BY um.granted_at ASC
     LIMIT 1`,
    [input.userId, input.asOf.toISOString()],
  );
  const membershipRow = membership.rows[0];
  if (membershipRow === undefined) {
    return { ...empty, bonusUnavailablePolicy: policy };
  }

  const benefit = await client.query<{
    rule_version_id: string;
    rule_version: number;
    value_bps: number | null;
  }>(
    `SELECT mpe.rule_version_id, mbr.rule_version, mbr.value_bps
     FROM membership_plan_entitlements mpe
     JOIN entitlements e ON e.id = mpe.entitlement_id
     JOIN membership_benefit_rule_versions mbr ON mbr.id = mpe.rule_version_id
     WHERE mpe.membership_plan_id = $1::uuid
       AND e.code = $2
       AND mpe.status = 'ACTIVE'
       AND mbr.status = 'ACTIVE'
       AND mpe.valid_from <= $3::timestamptz
       AND (mpe.valid_to IS NULL OR mpe.valid_to > $3::timestamptz)
       AND mbr.effective_from <= $3::timestamptz
       AND (mbr.effective_to IS NULL OR mbr.effective_to > $3::timestamptz)
     ORDER BY mbr.rule_version DESC
     LIMIT 2`,
    [membershipRow.membership_plan_id, ELIGIBLE_REWARD_BONUS_CODE, input.asOf.toISOString()],
  );

  const benefitRow = benefit.rows[0];
  if (benefit.rows.length !== 1 || benefitRow === undefined || benefitRow.value_bps === null) {
    if (policy === 'BLOCK_QUOTE_BEFORE_START') {
      throw new RewardDomainError(
        'BONUS_BLOCKED',
        'membership bonus unavailable under BLOCK_QUOTE_BEFORE_START',
        { details: { reason: 'ENTITLEMENT_MISSING' } },
      );
    }
    return {
      ...empty,
      membershipId: membershipRow.id,
      bonusUnavailablePolicy: policy,
    };
  }

  const bonusBps: number = benefitRow.value_bps;
  if (
    paused ||
    input.membershipBonusBudgetPeriodId === undefined ||
    input.membershipBonusBudgetPeriodId === null
  ) {
    if (policy === 'BLOCK_QUOTE_BEFORE_START') {
      throw new RewardDomainError(
        'BONUS_BLOCKED',
        'membership bonus unavailable under BLOCK_QUOTE_BEFORE_START',
        {
          details: {
            reason: paused ? 'MEMBERSHIP_BONUS_PAUSE' : 'BONUS_BUDGET_MISSING',
          },
        },
      );
    }
    return {
      membershipId: membershipRow.id,
      entitlementRuleVersionId: benefitRow.rule_version_id,
      bonusRuleVersion: benefitRow.rule_version,
      bonusBps,
      bonusAmountAtomic: 0n,
      bonusUnavailablePolicy: policy,
    };
  }

  const bonusAmount = computeMembershipBonusAtomic({
    baseAmountAtomic: input.baseAmountAtomic,
    bonusBps,
  });

  if (bonusAmount === 0n) {
    return {
      membershipId: membershipRow.id,
      entitlementRuleVersionId: benefitRow.rule_version_id,
      bonusRuleVersion: benefitRow.rule_version,
      bonusBps,
      bonusAmountAtomic: 0n,
      bonusUnavailablePolicy: policy,
    };
  }

  return {
    membershipId: membershipRow.id,
    entitlementRuleVersionId: benefitRow.rule_version_id,
    bonusRuleVersion: benefitRow.rule_version,
    bonusBps,
    bonusAmountAtomic: bonusAmount,
    bonusUnavailablePolicy: policy,
  };
}

async function createRewardQuoteOnClient(
  client: PoolClient,
  command: CreateRewardQuoteCommand,
): Promise<RewardQuoteResult> {
  const asOf = command.asOf ?? new Date();
  const environment = command.environment ?? 'LOCAL';
  const evaluateMembershipBonus = command.evaluateMembershipBonus === true;

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      command.sourceId,
    )
  ) {
    throw new RewardDomainError('VALIDATION', 'sourceId must be a UUID');
  }

  const rule = await resolveRewardRule(client, asOf, {
    sourceType: command.sourceType,
    assetId: command.assetId,
    providerId: command.providerId ?? null,
    countryGroup: command.countryGroup ?? null,
  });

  const baseAmount = computeQuotedRewardAtomic({
    fixedRewardAtomic: rule.fixedRewardAtomic,
    estimatedEcpmAtomic: rule.estimatedEcpmAtomic,
    userShareBps: rule.userShareBps,
    safetyFactorBps: rule.safetyFactorBps,
    minRewardAtomic: rule.minRewardAtomic,
    maxRewardAtomic: rule.maxRewardAtomic,
  });

  const guardrails = await assertNewQuotesAllowed(client, {
    environment,
    assetId: command.assetId,
    rule,
    baseAmountAtomic: baseAmount,
    providerId: command.providerId ?? null,
    countryGroup: command.countryGroup ?? null,
    asOf,
  });

  const bonus = await resolveMembershipBonus(client, {
    userId: command.userId,
    baseAmountAtomic: baseAmount,
    evaluateMembershipBonus,
    policy: command.bonusUnavailablePolicy ?? null,
    environment,
    asOf,
    membershipBonusBudgetPeriodId: command.membershipBonusBudgetPeriodId ?? null,
  });

  if (command.budgetPeriodId === undefined || command.budgetPeriodId === null) {
    throw new RewardDomainError(
      'BUDGET_NOT_FOUND',
      'budgetPeriodId is required for quote creation',
    );
  }

  const quoteTtlSeconds = rule.quoteTtlSeconds > 0 ? rule.quoteTtlSeconds : 300;
  const expiresAt = new Date(asOf.getTime() + quoteTtlSeconds * 1000);
  const quoteId = randomUUID();
  const totalAmount = baseAmount + bonus.bonusAmountAtomic;
  const quoteCreatedAt = asOf.toISOString();

  const appliedEconomics: AppliedEconomics = {
    rewardRuleId: rule.id,
    ruleVersion: rule.ruleVersion,
    ruleCode: rule.code,
    formulaInputs: {
      estimatedEcpmAtomic: rule.estimatedEcpmAtomic,
      userShareBps: rule.userShareBps,
      safetyFactorBps: rule.safetyFactorBps,
      minRewardAtomic: rule.minRewardAtomic,
      maxRewardAtomic: rule.maxRewardAtomic,
      fixedRewardAtomic: rule.fixedRewardAtomic,
    },
    baseAmountAtomic: amountAtomicToString(baseAmount),
    membershipBonusAmountAtomic: amountAtomicToString(bonus.bonusAmountAtomic),
    membershipId: bonus.membershipId,
    entitlementRuleVersionId: bonus.entitlementRuleVersionId,
    bonusRuleVersion: bonus.bonusRuleVersion,
    bonusBps: bonus.bonusBps,
    budgetPeriodIds: [
      command.budgetPeriodId,
      ...(command.membershipBonusBudgetPeriodId ? [command.membershipBonusBudgetPeriodId] : []),
    ],
    exposureLimitVersionIds: guardrails.exposureLimitVersionIds,
    bonusUnavailablePolicy: bonus.bonusUnavailablePolicy,
    quoteCreatedAt,
    sourceType: command.sourceType,
    sourceId: command.sourceId,
  };

  await client.query(
    `INSERT INTO reward_quotes (
       id, user_id, source_type, source_id, provider_id, asset_id,
       reward_rule_id, rule_version, base_amount_atomic, membership_bonus_amount_atomic,
       amount_atomic, membership_id, status, expires_at,
       applied_economics, bonus_unavailable_policy, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::reward_source_type, $4::uuid, $5::uuid, $6::uuid,
       $7::uuid, $8, $9::bigint, $10::bigint, $11::bigint, $12::uuid, 'OPEN', $13::timestamptz,
       $14::jsonb, $15, $16::timestamptz
     )`,
    [
      quoteId,
      command.userId,
      command.sourceType,
      command.sourceId,
      command.providerId ?? null,
      command.assetId,
      rule.id,
      rule.ruleVersion,
      amountAtomicToString(baseAmount),
      amountAtomicToString(bonus.bonusAmountAtomic),
      amountAtomicToString(totalAmount),
      bonus.membershipId,
      expiresAt.toISOString(),
      JSON.stringify(appliedEconomics),
      bonus.bonusUnavailablePolicy,
      quoteCreatedAt,
    ],
  );

  const baseReservation = await reserveRewardBudget(client, {
    budgetPeriodId: command.budgetPeriodId,
    rewardQuoteId: quoteId,
    amountAtomic: baseAmount,
  });

  let bonusReservationId: string | null = null;
  if (
    bonus.bonusAmountAtomic > 0n &&
    bonus.membershipId !== null &&
    bonus.entitlementRuleVersionId !== null &&
    bonus.bonusRuleVersion !== null &&
    command.membershipBonusBudgetPeriodId
  ) {
    const bonusReservation = await reserveMembershipBonusBudget(client, {
      budgetPeriodId: command.membershipBonusBudgetPeriodId,
      userMembershipId: bonus.membershipId,
      rewardQuoteId: quoteId,
      entitlementRuleVersionId: bonus.entitlementRuleVersionId,
      bonusRuleVersion: bonus.bonusRuleVersion,
      amountAtomic: bonus.bonusAmountAtomic,
    });
    bonusReservationId = bonusReservation.id;
  }

  await insertOutboxEvent(client, {
    aggregateType: 'reward_quote',
    aggregateId: quoteId,
    eventType: 'reward_quote.created',
    dedupeKey: `reward-quote-created/${quoteId}`,
    payload: {
      quoteId,
      userId: command.userId,
      baseAmountAtomic: amountAtomicToString(baseAmount),
      membershipBonusAmountAtomic: amountAtomicToString(bonus.bonusAmountAtomic),
    },
  });

  return {
    quoteId,
    status: 'OPEN',
    baseAmountAtomic: amountAtomicToString(baseAmount),
    membershipBonusAmountAtomic: amountAtomicToString(bonus.bonusAmountAtomic),
    amountAtomic: amountAtomicToString(totalAmount),
    rewardRuleId: rule.id,
    ruleVersion: rule.ruleVersion,
    expiresAt: expiresAt.toISOString(),
    membershipId: bonus.membershipId,
    appliedEconomics,
    baseReservationId: baseReservation.id,
    bonusReservationId,
  };
}

export async function createRewardQuote(
  db: LedgerDb,
  command: CreateRewardQuoteCommand,
): Promise<RewardQuoteResult> {
  return withLedgerTransaction(db, (client) => createRewardQuoteOnClient(client, command));
}

/**
 * Expire an OPEN quote and release reservations exactly once.
 * Idempotent. Skips release when source_started_at is set (protected start).
 */
export async function expireRewardQuote(
  db: LedgerDb,
  quoteId: string,
  asOf: Date = new Date(),
): Promise<{ quoteId: string; status: string; released: boolean }> {
  return withLedgerTransaction(db, async (client) => {
    const quote = await client.query<{
      id: string;
      status: string;
      source_started_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, status::text AS status, source_started_at, expires_at
       FROM reward_quotes WHERE id = $1 FOR UPDATE`,
      [quoteId],
    );
    const row = quote.rows[0];
    if (row === undefined) {
      throw new RewardDomainError('QUOTE_NOT_FOUND', 'reward quote not found', {
        details: { quoteId },
      });
    }
    if (row.status === 'EXPIRED' || row.status === 'CANCELLED' || row.status === 'CONSUMED') {
      return { quoteId, status: row.status, released: false };
    }
    if (row.status !== 'OPEN') {
      throw new RewardDomainError('QUOTE_NOT_OPEN', 'quote cannot be expired', {
        details: { status: row.status },
      });
    }
    if (row.source_started_at !== null) {
      return { quoteId, status: row.status, released: false };
    }
    if (row.expires_at.getTime() > asOf.getTime()) {
      throw new RewardDomainError('VALIDATION', 'quote has not expired yet', {
        details: { expiresAt: row.expires_at.toISOString(), asOf: asOf.toISOString() },
      });
    }

    const baseReservation = await client.query<{ id: string; state: string }>(
      `SELECT id, state::text AS state FROM reward_budget_reservations
       WHERE reward_quote_id = $1 FOR UPDATE`,
      [quoteId],
    );
    if (baseReservation.rows[0]?.state === 'ACTIVE') {
      await releaseRewardBudgetReservation(client, baseReservation.rows[0].id);
    }

    const bonusReservation = await client.query<{ id: string; state: string }>(
      `SELECT id, state::text AS state FROM membership_bonus_budget_reservations
       WHERE reward_quote_id = $1 FOR UPDATE`,
      [quoteId],
    );
    if (bonusReservation.rows[0]?.state === 'ACTIVE') {
      await releaseMembershipBonusBudgetReservation(client, bonusReservation.rows[0].id);
    }

    await client.query(
      `UPDATE reward_quotes
       SET status = 'EXPIRED', cancelled_at = $2::timestamptz, updated_at = now()
       WHERE id = $1`,
      [quoteId, asOf.toISOString()],
    );
    await insertOutboxEvent(client, {
      aggregateType: 'reward_quote',
      aggregateId: quoteId,
      eventType: 'reward_quote.expired',
      dedupeKey: `reward-quote-expired/${quoteId}`,
      payload: { quoteId },
    });
    return { quoteId, status: 'EXPIRED', released: true };
  });
}

export { markSimulatedSourceStarted };
