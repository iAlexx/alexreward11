import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { amountAtomicToString } from '@alex-rewards/ledger';

import { computeMembershipBonusAtomic, computeQuotedRewardAtomic } from './arithmetic.js';
import {
  assertPerUserBonusCap,
  resolveApplicableBonusBudgetPeriods,
  validateBaseBudgetPeriod,
} from './budget-authority.js';
import {
  releaseMembershipBonusBudgetReservation,
  reserveMembershipBonusBudget,
} from './bonus-budgets.js';
import { releaseRewardBudgetReservation, reserveRewardBudget } from './budgets.js';
import { withLedgerTransaction, type LedgerDb } from './db.js';
import { isBonusEconomicUnavailability, RewardDomainError } from './errors.js';
import { releaseExposureReservationsForQuote, reserveExposureForQuote } from './exposure.js';
import {
  assertNewQuotesAllowed,
  isMembershipBonusPaused,
  requireBonusUnavailablePolicy,
} from './guardrails.js';
import { insertOutboxEvent } from './outbox.js';
import { resolveRewardRule } from './rules.js';
import { assertSimulatedSourceEligibleForQuote, markSimulatedSourceQuoted } from './simulated.js';
import {
  ELIGIBLE_REWARD_BONUS_CODE,
  type AppliedEconomics,
  type CreateRewardQuoteCommand,
  type MembershipBonusUnavailablePolicy,
  type RewardQuoteResult,
} from './types.js';

interface BonusCandidate {
  readonly membershipId: string;
  readonly membershipPlanId: string;
  readonly entitlementRuleVersionId: string;
  readonly bonusRuleVersion: number;
  readonly bonusBps: number;
}

interface BonusResolution {
  readonly membershipId: string | null;
  readonly membershipPlanId: string | null;
  readonly entitlementRuleVersionId: string | null;
  readonly bonusRuleVersion: number | null;
  readonly bonusBps: number | null;
  readonly bonusAmountAtomic: bigint;
  readonly bonusUnavailablePolicy: MembershipBonusUnavailablePolicy | null;
  readonly bonusBudgetPeriodIds: string[];
}

/**
 * Resolve FINANCIAL ELIGIBLE_REWARD_BONUS candidates across all active memberships.
 * 0 → no bonus; 1 → use; >1 conflicting → FAIL CLOSED.
 */
async function resolveFinancialBonusCandidates(
  client: PoolClient,
  userId: string,
  asOf: Date,
): Promise<BonusCandidate[]> {
  const result = await client.query<{
    membership_id: string;
    membership_plan_id: string;
    rule_version_id: string;
    rule_version: number;
    value_bps: number;
  }>(
    `SELECT um.id AS membership_id,
            um.membership_plan_id,
            mbr.id AS rule_version_id,
            mbr.rule_version,
            mbr.value_bps
     FROM user_memberships um
     JOIN membership_plans mp ON mp.id = um.membership_plan_id
     JOIN membership_plan_entitlements mpe ON mpe.membership_plan_id = mp.id
     JOIN entitlements e ON e.id = mpe.entitlement_id
     JOIN membership_benefit_rule_versions mbr ON mbr.id = mpe.rule_version_id
     WHERE um.user_id = $1::uuid
       AND um.status = 'ACTIVE'
       AND (um.expires_at IS NULL OR um.expires_at > $2::timestamptz)
       AND mp.status = 'ACTIVE'
       AND mpe.status = 'ACTIVE'
       AND mpe.valid_from <= $2::timestamptz
       AND (mpe.valid_to IS NULL OR mpe.valid_to > $2::timestamptz)
       AND mbr.status = 'ACTIVE'
       AND mbr.effective_from <= $2::timestamptz
       AND (mbr.effective_to IS NULL OR mbr.effective_to > $2::timestamptz)
       AND e.code = $3
       AND e.security_classification = 'FINANCIAL'
       AND e.value_type = 'BPS'
       AND mbr.value_bps IS NOT NULL
     ORDER BY um.id ASC, mbr.id ASC`,
    [userId, asOf.toISOString(), ELIGIBLE_REWARD_BONUS_CODE],
  );

  return result.rows.map((row) => ({
    membershipId: row.membership_id,
    membershipPlanId: row.membership_plan_id,
    entitlementRuleVersionId: row.rule_version_id,
    bonusRuleVersion: row.rule_version,
    bonusBps: row.value_bps,
  }));
}

function pickSingleBonusCandidate(candidates: BonusCandidate[]): BonusCandidate | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const keys = new Set(
    candidates.map((c) => `${c.membershipId}:${c.entitlementRuleVersionId}:${c.bonusBps}`),
  );
  if (keys.size > 1) {
    throw new RewardDomainError(
      'BONUS_RESOLUTION_CONFLICT',
      'multiple conflicting FINANCIAL membership bonus entitlements; fail closed (no stacking)',
      {
        details: {
          candidateCount: candidates.length,
          membershipIds: candidates.map((c) => c.membershipId),
        },
      },
    );
  }
  return candidates[0]!;
}

async function resolveMembershipBonus(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly assetId: string;
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
    membershipPlanId: null,
    entitlementRuleVersionId: null,
    bonusRuleVersion: null,
    bonusBps: null,
    bonusAmountAtomic: 0n,
    bonusUnavailablePolicy: input.policy,
    bonusBudgetPeriodIds: [],
  };

  if (!input.evaluateMembershipBonus) {
    return { ...empty, bonusUnavailablePolicy: null };
  }

  const policy = requireBonusUnavailablePolicy(true, input.policy);
  const paused = await isMembershipBonusPaused(client, input.environment);
  const candidates = await resolveFinancialBonusCandidates(client, input.userId, input.asOf);
  const candidate = pickSingleBonusCandidate(candidates);

  if (candidate === null) {
    return { ...empty, bonusUnavailablePolicy: policy };
  }

  if (paused) {
    if (policy === 'BLOCK_QUOTE_BEFORE_START') {
      throw new RewardDomainError(
        'BONUS_BLOCKED',
        'membership bonus unavailable under BLOCK_QUOTE_BEFORE_START',
        { details: { reason: 'MEMBERSHIP_BONUS_PAUSE' } },
      );
    }
    return {
      membershipId: candidate.membershipId,
      membershipPlanId: candidate.membershipPlanId,
      entitlementRuleVersionId: candidate.entitlementRuleVersionId,
      bonusRuleVersion: candidate.bonusRuleVersion,
      bonusBps: candidate.bonusBps,
      bonusAmountAtomic: 0n,
      bonusUnavailablePolicy: policy,
      bonusBudgetPeriodIds: [],
    };
  }

  const bonusAmount = computeMembershipBonusAtomic({
    baseAmountAtomic: input.baseAmountAtomic,
    bonusBps: candidate.bonusBps,
  });

  if (bonusAmount === 0n) {
    return {
      membershipId: candidate.membershipId,
      membershipPlanId: candidate.membershipPlanId,
      entitlementRuleVersionId: candidate.entitlementRuleVersionId,
      bonusRuleVersion: candidate.bonusRuleVersion,
      bonusBps: candidate.bonusBps,
      bonusAmountAtomic: 0n,
      bonusUnavailablePolicy: policy,
      bonusBudgetPeriodIds: [],
    };
  }

  try {
    const locators =
      input.membershipBonusBudgetPeriodId !== undefined &&
      input.membershipBonusBudgetPeriodId !== null
        ? [input.membershipBonusBudgetPeriodId]
        : [];
    const periods = await resolveApplicableBonusBudgetPeriods(client, {
      assetId: input.assetId,
      asOf: input.asOf,
      userId: input.userId,
      membershipPlanId: candidate.membershipPlanId,
      locatorPeriodIds: locators,
    });
    if (periods.length === 0) {
      throw new RewardDomainError('BONUS_UNAVAILABLE', 'no applicable membership bonus budget', {
        details: { reason: 'BONUS_BUDGET_MISSING' },
      });
    }
    for (const period of periods) {
      const remaining =
        BigInt(period.budgetAtomic) - BigInt(period.reservedAtomic) - BigInt(period.consumedAtomic);
      if (bonusAmount > remaining) {
        throw new RewardDomainError('BUDGET_EXHAUSTED', 'insufficient membership bonus budget', {
          details: { budgetPeriodId: period.id, remaining: remaining.toString(10) },
        });
      }
      if (period.perUserCapAtomic !== null) {
        await assertPerUserBonusCap(client, {
          budgetPeriodId: period.id,
          userMembershipId: candidate.membershipId,
          perUserCapAtomic: period.perUserCapAtomic,
          amountAtomic: bonusAmount,
        });
      }
    }
    return {
      membershipId: candidate.membershipId,
      membershipPlanId: candidate.membershipPlanId,
      entitlementRuleVersionId: candidate.entitlementRuleVersionId,
      bonusRuleVersion: candidate.bonusRuleVersion,
      bonusBps: candidate.bonusBps,
      bonusAmountAtomic: bonusAmount,
      bonusUnavailablePolicy: policy,
      bonusBudgetPeriodIds: periods.map((p) => p.id),
    };
  } catch (error) {
    if (!isBonusEconomicUnavailability(error)) {
      throw error;
    }
    if (policy === 'BLOCK_QUOTE_BEFORE_START') {
      throw new RewardDomainError(
        'BONUS_BLOCKED',
        'membership bonus unavailable under BLOCK_QUOTE_BEFORE_START',
        {
          details: {
            reason: error.code,
            causeMessage: error.publicMessage,
            ...(error.details ?? {}),
          },
        },
      );
    }
    // BASE_REWARD_ONLY: recognized economic unavailability → base-only.
    return {
      membershipId: candidate.membershipId,
      membershipPlanId: candidate.membershipPlanId,
      entitlementRuleVersionId: candidate.entitlementRuleVersionId,
      bonusRuleVersion: candidate.bonusRuleVersion,
      bonusBps: candidate.bonusBps,
      bonusAmountAtomic: 0n,
      bonusUnavailablePolicy: policy,
      bonusBudgetPeriodIds: [],
    };
  }
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

  let providerId = command.providerId ?? null;
  if (command.sourceType === 'PROMOTION') {
    const simulated = await assertSimulatedSourceEligibleForQuote(client, {
      sourceId: command.sourceId,
      providerId,
      userId: command.userId,
    });
    providerId = simulated.providerId;
  }

  const rule = await resolveRewardRule(client, asOf, {
    sourceType: command.sourceType,
    assetId: command.assetId,
    providerId,
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

  if (command.budgetPeriodId === undefined || command.budgetPeriodId === null) {
    throw new RewardDomainError(
      'BUDGET_NOT_FOUND',
      'budgetPeriodId is required for quote creation',
    );
  }

  const baseBudget = await validateBaseBudgetPeriod(client, {
    budgetPeriodId: command.budgetPeriodId,
    assetId: command.assetId,
    asOf,
    providerId,
    countryGroup: command.countryGroup ?? null,
    rewardRuleId: rule.id,
    ruleVersion: rule.ruleVersion,
  });

  const bonus = await resolveMembershipBonus(client, {
    userId: command.userId,
    assetId: command.assetId,
    baseAmountAtomic: baseAmount,
    evaluateMembershipBonus,
    policy: command.bonusUnavailablePolicy ?? null,
    environment,
    asOf,
    membershipBonusBudgetPeriodId: command.membershipBonusBudgetPeriodId ?? null,
  });

  const guardrails = await assertNewQuotesAllowed(client, {
    environment,
    assetId: command.assetId,
    rule,
    baseAmountAtomic: baseAmount,
    membershipBonusAmountAtomic: bonus.bonusAmountAtomic,
    providerId,
    countryGroup: command.countryGroup ?? null,
    asOf,
  });

  const quoteTtlSeconds = rule.quoteTtlSeconds > 0 ? rule.quoteTtlSeconds : 300;
  const expiresAt = new Date(asOf.getTime() + quoteTtlSeconds * 1000);
  const quoteId = randomUUID();
  const totalAmount = baseAmount + bonus.bonusAmountAtomic;
  const quoteCreatedAt = asOf.toISOString();
  const bonusBudgetPeriodIds = bonus.bonusBudgetPeriodIds;

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
    budgetPeriodIds: [baseBudget.id, ...bonusBudgetPeriodIds],
    bonusBudgetPeriodIds,
    exposureLimitVersionIds: guardrails.exposureLimitVersionIds,
    evaluatedExposureLimits: guardrails.evaluatedExposureLimits,
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
      providerId,
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

  if (command.sourceType === 'PROMOTION') {
    await markSimulatedSourceQuoted(client, command.sourceId, asOf);
  }

  const baseReservation = await reserveRewardBudget(client, {
    budgetPeriodId: baseBudget.id,
    rewardQuoteId: quoteId,
    amountAtomic: baseAmount,
  });

  const bonusReservationIds: string[] = [];
  if (
    bonus.bonusAmountAtomic > 0n &&
    bonus.membershipId !== null &&
    bonus.entitlementRuleVersionId !== null &&
    bonus.bonusRuleVersion !== null &&
    bonusBudgetPeriodIds.length > 0
  ) {
    // Periods remain locked from resolveApplicableBonusBudgetPeriods in this transaction.
    for (const periodId of [...bonusBudgetPeriodIds].sort()) {
      const bonusReservation = await reserveMembershipBonusBudget(client, {
        budgetPeriodId: periodId,
        userMembershipId: bonus.membershipId,
        rewardQuoteId: quoteId,
        entitlementRuleVersionId: bonus.entitlementRuleVersionId,
        bonusRuleVersion: bonus.bonusRuleVersion,
        amountAtomic: bonus.bonusAmountAtomic,
      });
      bonusReservationIds.push(bonusReservation.id);
    }
  }

  // Apply exposure reservations after quote exists (same transaction; periods already locked).
  for (const pending of guardrails.pendingExposureReservations) {
    await reserveExposureForQuote(client, {
      rewardQuoteId: quoteId,
      exposurePeriodId: pending.exposurePeriodId,
      amountAtomic: pending.amountAtomic,
    });
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
    bonusReservationId: bonusReservationIds[0] ?? null,
    bonusReservationIds,
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

    const bonusReservations = await client.query<{ id: string; state: string }>(
      `SELECT id, state::text AS state FROM membership_bonus_budget_reservations
       WHERE reward_quote_id = $1
       ORDER BY id
       FOR UPDATE`,
      [quoteId],
    );
    for (const bonusReservation of bonusReservations.rows) {
      if (bonusReservation.state === 'ACTIVE') {
        await releaseMembershipBonusBudgetReservation(client, bonusReservation.id);
      }
    }

    await releaseExposureReservationsForQuote(client, quoteId);

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
