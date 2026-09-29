/**
 * Phase 15 Step 5 — Level-1 referrer bonus issuance via Reward Engine + Ledger.
 * packages/referrals must never call Ledger; this module owns money movement.
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  ReferralDomainError,
  resolveEffectiveReferralRate,
} from '@alex-rewards/referrals';
import {
  amountAtomicToString,
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
  type LedgerDb,
} from '@alex-rewards/ledger';

import { computeReferralBonusAtomic } from './arithmetic.js';
import { RewardDomainError } from './errors.js';
import { lockOrCreateExposurePeriod, utcDayWindow } from './exposure.js';
import { insertOutboxEvent } from './outbox.js';
import type { EnvironmentName } from './types.js';

export type ReferralIssuanceKind =
  | 'issued'
  | 'already_decided'
  | 'skipped'
  | 'rejected_budget';

export interface IssueReferralRewardCommand {
  readonly sourceRewardEventId: string;
  readonly environment: EnvironmentName;
  readonly idempotencyKey?: string;
  readonly asOf?: Date;
}

export interface IssueReferralRewardResult {
  readonly kind: ReferralIssuanceKind;
  readonly reasonCode: string;
  readonly sourceRewardEventId: string;
  readonly referralEdgeId: string | null;
  readonly amountAtomic: string | null;
  readonly referrerRewardEventId: string | null;
  readonly referralRewardEventId: string | null;
  readonly ledgerTransactionId: string | null;
  readonly decisionId: string | null;
}

/** Deterministic UUID for REFERRAL reward_events.source_id from originating AD event. */
export function referralBonusSourceIdFromOrigin(sourceRewardEventId: string): string {
  const digest = createHash('sha256')
    .update(`alex-rewards:referral-bonus:${sourceRewardEventId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function isReferralRewardPaused(
  client: PoolClient,
  environment: EnvironmentName,
): Promise<boolean> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags
     WHERE flag_key = 'REFERRAL_REWARD_PAUSE' AND environment = $1::environment_name`,
    [environment],
  );
  return result.rows[0]?.enabled === true;
}

async function loadExistingDecision(
  client: PoolClient,
  sourceRewardEventId: string,
): Promise<IssueReferralRewardResult | null> {
  const existing = await client.query<{
    id: string;
    outcome: string;
    reason_code: string;
    referral_edge_id: string | null;
    amount_atomic: string | null;
    referrer_reward_event_id: string | null;
    referral_reward_event_id: string | null;
  }>(
    `SELECT id, outcome::text AS outcome, reason_code, referral_edge_id,
            amount_atomic::text AS amount_atomic,
            referrer_reward_event_id, referral_reward_event_id
     FROM referral_reward_decisions
     WHERE source_reward_event_id = $1::uuid`,
    [sourceRewardEventId],
  );
  const row = existing.rows[0];
  if (row === undefined) return null;

  let ledgerTransactionId: string | null = null;
  if (row.referrer_reward_event_id !== null) {
    const ledger = await client.query<{ ledger_transaction_id: string | null }>(
      `SELECT ledger_transaction_id FROM reward_events WHERE id = $1::uuid`,
      [row.referrer_reward_event_id],
    );
    ledgerTransactionId = ledger.rows[0]?.ledger_transaction_id ?? null;
  }

  const kind: ReferralIssuanceKind =
    row.outcome === 'ISSUED'
      ? 'already_decided'
      : row.outcome === 'REJECTED_BUDGET'
        ? 'rejected_budget'
        : 'skipped';

  return {
    kind: kind === 'already_decided' && row.outcome === 'ISSUED' ? 'already_decided' : kind,
    reasonCode: row.reason_code,
    sourceRewardEventId,
    referralEdgeId: row.referral_edge_id,
    amountAtomic: row.amount_atomic,
    referrerRewardEventId: row.referrer_reward_event_id,
    referralRewardEventId: row.referral_reward_event_id,
    ledgerTransactionId,
    decisionId: row.id,
  };
}

async function recordDecision(
  client: PoolClient,
  input: {
    readonly sourceRewardEventId: string;
    readonly referralEdgeId: string | null;
    readonly outcome: 'ISSUED' | 'SKIPPED' | 'REJECTED_BUDGET';
    readonly reasonCode: string;
    readonly amountAtomic?: string | null;
    readonly referrerRewardEventId?: string | null;
    readonly referralRewardEventId?: string | null;
    readonly exposureLimitId?: string | null;
    readonly exposurePeriodId?: string | null;
    readonly rateBps?: number | null;
    readonly rateSource?: string | null;
    readonly referralRuleVersion?: number | null;
    readonly userMembershipId?: string | null;
    readonly entitlementRuleVersionId?: string | null;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO referral_reward_decisions (
       source_reward_event_id, referral_edge_id, outcome, reason_code, amount_atomic,
       referrer_reward_event_id, referral_reward_event_id,
       exposure_limit_id, exposure_period_id, rate_bps, rate_source,
       referral_rule_version, user_membership_id, entitlement_rule_version_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::referral_reward_decision_outcome, $4, $5::bigint,
       $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10, $11::referral_rate_source,
       $12, $13::uuid, $14::uuid
     )
     RETURNING id`,
    [
      input.sourceRewardEventId,
      input.referralEdgeId,
      input.outcome,
      input.reasonCode,
      input.amountAtomic ?? null,
      input.referrerRewardEventId ?? null,
      input.referralRewardEventId ?? null,
      input.exposureLimitId ?? null,
      input.exposurePeriodId ?? null,
      input.rateBps ?? null,
      input.rateSource ?? null,
      input.referralRuleVersion ?? null,
      input.userMembershipId ?? null,
      input.entitlementRuleVersionId ?? null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new RewardDomainError('INTERNAL', 'referral_reward_decisions insert failed');
  }
  return id;
}

function softResult(
  kind: ReferralIssuanceKind,
  sourceRewardEventId: string,
  reasonCode: string,
  extras: Partial<IssueReferralRewardResult> = {},
): IssueReferralRewardResult {
  return {
    kind,
    reasonCode,
    sourceRewardEventId,
    referralEdgeId: extras.referralEdgeId ?? null,
    amountAtomic: extras.amountAtomic ?? null,
    referrerRewardEventId: extras.referrerRewardEventId ?? null,
    referralRewardEventId: extras.referralRewardEventId ?? null,
    ledgerTransactionId: extras.ledgerTransactionId ?? null,
    decisionId: extras.decisionId ?? null,
  };
}

/**
 * Attempt Level-1 referral bonus for an AVAILABLE AD source reward.
 * Soft-skips / budget rejects are durable and never mutate the invitee reward.
 */
export async function issueReferralReward(
  db: LedgerDb,
  command: IssueReferralRewardCommand,
): Promise<IssueReferralRewardResult> {
  return withLedgerTransaction(db, async (client) => {
    const asOf = command.asOf ?? new Date();
    const sourceId = command.sourceRewardEventId;

    const prior = await loadExistingDecision(client, sourceId);
    if (prior !== null) {
      return prior;
    }

    const locked = await client.query<{
      id: string;
      user_id: string;
      source_type: string;
      asset_id: string;
      amount_atomic: string;
      state: string;
      reward_rule_id: string | null;
      available_at: Date | null;
    }>(
      `SELECT id, user_id, source_type::text AS source_type, asset_id,
              amount_atomic::text AS amount_atomic, state::text AS state,
              reward_rule_id, available_at
       FROM reward_events
       WHERE id = $1::uuid
       FOR UPDATE`,
      [sourceId],
    );
    const source = locked.rows[0];
    if (source === undefined) {
      throw new RewardDomainError('VALIDATION', 'source reward event not found', {
        details: { sourceRewardEventId: sourceId },
      });
    }

    // Re-check decision under source lock (concurrent first writers).
    const priorAfterLock = await loadExistingDecision(client, sourceId);
    if (priorAfterLock !== null) {
      return priorAfterLock;
    }

    if (await isReferralRewardPaused(client, command.environment)) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: null,
        outcome: 'SKIPPED',
        reasonCode: 'REFERRAL_REWARD_PAUSE',
      });
      return softResult('skipped', sourceId, 'REFERRAL_REWARD_PAUSE', { decisionId });
    }

    if (source.source_type !== 'AD') {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: null,
        outcome: 'SKIPPED',
        reasonCode: 'SOURCE_NOT_AD',
      });
      return softResult('skipped', sourceId, 'SOURCE_NOT_AD', { decisionId });
    }

    if (source.state !== 'AVAILABLE') {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: null,
        outcome: 'SKIPPED',
        reasonCode: source.state === 'REVERSED' ? 'SOURCE_REVERSED' : 'SOURCE_NOT_AVAILABLE',
      });
      return softResult(
        'skipped',
        sourceId,
        source.state === 'REVERSED' ? 'SOURCE_REVERSED' : 'SOURCE_NOT_AVAILABLE',
        { decisionId },
      );
    }

    if (source.reward_rule_id === null || source.available_at === null) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: null,
        outcome: 'SKIPPED',
        reasonCode: 'SOURCE_PROVENANCE_MISSING',
      });
      return softResult('skipped', sourceId, 'SOURCE_PROVENANCE_MISSING', { decisionId });
    }

    const rule = await client.query<{ referral_eligible: boolean | null }>(
      `SELECT referral_eligible FROM reward_rules WHERE id = $1::uuid FOR SHARE`,
      [source.reward_rule_id],
    );
    const referralEligible = rule.rows[0]?.referral_eligible;
    if (referralEligible !== true) {
      const reason =
        referralEligible === false ? 'REFERRAL_ELIGIBLE_FALSE' : 'REFERRAL_ELIGIBLE_UNCONFIGURED';
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: null,
        outcome: 'SKIPPED',
        reasonCode: reason,
      });
      return softResult('skipped', sourceId, reason, { decisionId });
    }

    const edgeResult = await client.query<{
      id: string;
      referrer_user_id: string;
      referred_user_id: string;
      state: string;
      activated_at: Date | null;
    }>(
      `SELECT id, referrer_user_id, referred_user_id, state::text AS state, activated_at
       FROM referral_edges
       WHERE referred_user_id = $1::uuid
       FOR UPDATE`,
      [source.user_id],
    );
    const edge = edgeResult.rows[0];
    if (edge === undefined) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: null,
        outcome: 'SKIPPED',
        reasonCode: 'NO_REFERRAL_EDGE',
      });
      return softResult('skipped', sourceId, 'NO_REFERRAL_EDGE', { decisionId });
    }
    // PENDING edges must not receive a durable EDGE_NOT_ACTIVE skip — redrive after activation.
    if (edge.state === 'PENDING') {
      return softResult('skipped', sourceId, 'EDGE_NOT_ACTIVE', {
        referralEdgeId: edge.id,
      });
    }
    if (edge.state !== 'ACTIVE' || edge.activated_at === null) {
      const reason = edge.state === 'REJECTED' ? 'EDGE_REJECTED' : 'EDGE_NOT_ACTIVE';
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        outcome: 'SKIPPED',
        reasonCode: reason,
      });
      return softResult('skipped', sourceId, reason, {
        decisionId,
        referralEdgeId: edge.id,
      });
    }

    if (edge.activated_at.getTime() > source.available_at.getTime()) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        outcome: 'SKIPPED',
        reasonCode: 'PRE_ACTIVATION_SOURCE',
      });
      return softResult('skipped', sourceId, 'PRE_ACTIVATION_SOURCE', {
        decisionId,
        referralEdgeId: edge.id,
      });
    }

    let rate;
    try {
      rate = await resolveEffectiveReferralRate(client, {
        referrerUserId: edge.referrer_user_id,
        assetId: source.asset_id,
      });
    } catch (error) {
      if (error instanceof ReferralDomainError) {
        const decisionId = await recordDecision(client, {
          sourceRewardEventId: sourceId,
          referralEdgeId: edge.id,
          outcome: 'SKIPPED',
          reasonCode: error.code,
        });
        return softResult('skipped', sourceId, error.code, {
          decisionId,
          referralEdgeId: edge.id,
        });
      }
      throw error;
    }

    const amount = computeReferralBonusAtomic({
      sourceAmountAtomic: source.amount_atomic,
      effectiveRateBps: rate.effectiveRateBps,
    });
    if (amount <= 0n) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        outcome: 'SKIPPED',
        reasonCode: 'ZERO_AMOUNT',
        rateBps: rate.effectiveRateBps,
        rateSource: rate.rateSource,
        referralRuleVersion: rate.referralRuleVersion,
        userMembershipId: rate.userMembershipId,
        entitlementRuleVersionId: rate.entitlementRuleVersionId,
      });
      return softResult('skipped', sourceId, 'ZERO_AMOUNT', {
        decisionId,
        referralEdgeId: edge.id,
        amountAtomic: '0',
      });
    }
    const amountText = amountAtomicToString(amount);

    const limits = await client.query<{
      id: string;
      limit_atomic: string | null;
      scope_reference_id: string | null;
      country_group: string | null;
      asset_id: string | null;
    }>(
      `SELECT id, limit_atomic::text AS limit_atomic, scope_reference_id, country_group, asset_id
       FROM economic_exposure_limits
       WHERE limit_code = 'MAX_REFERRAL_BONUS_DAILY'::exposure_limit_code
         AND status = 'ACTIVE'
         AND environment = $1::environment_name
         AND effective_from <= $2::timestamptz
         AND (effective_to IS NULL OR effective_to > $2::timestamptz)
         AND (asset_id IS NULL OR asset_id = $3::uuid)
       ORDER BY id ASC
       FOR SHARE`,
      [command.environment, asOf.toISOString(), source.asset_id],
    );

    const applicable = limits.rows.filter(
      (row) => row.scope_reference_id === null && row.country_group === null,
    );
    if (applicable.length === 0) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        outcome: 'REJECTED_BUDGET',
        reasonCode: 'MAX_REFERRAL_BONUS_DAILY_MISSING',
        rateBps: rate.effectiveRateBps,
        rateSource: rate.rateSource,
        referralRuleVersion: rate.referralRuleVersion,
        userMembershipId: rate.userMembershipId,
        entitlementRuleVersionId: rate.entitlementRuleVersionId,
      });
      return softResult('rejected_budget', sourceId, 'MAX_REFERRAL_BONUS_DAILY_MISSING', {
        decisionId,
        referralEdgeId: edge.id,
      });
    }
    if (applicable.length > 1) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        outcome: 'REJECTED_BUDGET',
        reasonCode: 'MAX_REFERRAL_BONUS_DAILY_AMBIGUOUS',
        rateBps: rate.effectiveRateBps,
        rateSource: rate.rateSource,
        referralRuleVersion: rate.referralRuleVersion,
        userMembershipId: rate.userMembershipId,
        entitlementRuleVersionId: rate.entitlementRuleVersionId,
      });
      return softResult('rejected_budget', sourceId, 'MAX_REFERRAL_BONUS_DAILY_AMBIGUOUS', {
        decisionId,
        referralEdgeId: edge.id,
      });
    }

    const limit = applicable[0]!;
    if (limit.limit_atomic === null) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        outcome: 'REJECTED_BUDGET',
        reasonCode: 'MAX_REFERRAL_BONUS_DAILY_INVALID',
        exposureLimitId: limit.id,
        rateBps: rate.effectiveRateBps,
        rateSource: rate.rateSource,
        referralRuleVersion: rate.referralRuleVersion,
        userMembershipId: rate.userMembershipId,
        entitlementRuleVersionId: rate.entitlementRuleVersionId,
      });
      return softResult('rejected_budget', sourceId, 'MAX_REFERRAL_BONUS_DAILY_INVALID', {
        decisionId,
        referralEdgeId: edge.id,
      });
    }

    const window = utcDayWindow(asOf);
    const period = await lockOrCreateExposurePeriod(client, {
      exposureLimitId: limit.id,
      limitAtomic: BigInt(limit.limit_atomic),
      window,
    });
    const remaining =
      BigInt(period.limit_atomic) - BigInt(period.reserved_atomic) - BigInt(period.consumed_atomic);
    if (amount > remaining) {
      const decisionId = await recordDecision(client, {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        outcome: 'REJECTED_BUDGET',
        reasonCode: 'MAX_REFERRAL_BONUS_DAILY_EXHAUSTED',
        exposureLimitId: limit.id,
        exposurePeriodId: period.id,
        rateBps: rate.effectiveRateBps,
        rateSource: rate.rateSource,
        referralRuleVersion: rate.referralRuleVersion,
        userMembershipId: rate.userMembershipId,
        entitlementRuleVersionId: rate.entitlementRuleVersionId,
      });
      return softResult('rejected_budget', sourceId, 'MAX_REFERRAL_BONUS_DAILY_EXHAUSTED', {
        decisionId,
        referralEdgeId: edge.id,
      });
    }

    await client.query(
      `UPDATE economic_exposure_periods
       SET reserved_atomic = reserved_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1::uuid`,
      [period.id, amountText],
    );
    const reservation = await client.query<{ id: string }>(
      `INSERT INTO referral_bonus_exposure_reservations (
         source_reward_event_id, referral_edge_id, exposure_period_id, amount_atomic, state
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::bigint, 'ACTIVE')
       RETURNING id`,
      [sourceId, edge.id, period.id, amountText],
    );
    const reservationId = reservation.rows[0]?.id;
    if (reservationId === undefined) {
      throw new RewardDomainError('INTERNAL', 'referral exposure reservation insert failed');
    }

    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'REFERRAL_REWARD_EXPENSE',
      assetId: source.asset_id,
    });
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId: source.asset_id,
      ownerId: edge.referrer_user_id,
    });

    const referralSourceId = referralBonusSourceIdFromOrigin(sourceId);
    const idempotencyKey =
      command.idempotencyKey ?? `referral-reward-issuance/${sourceId}`;

    const ledger = await postLedgerTransaction(client, {
      transactionType: 'REFERRAL_REWARD_ISSUANCE',
      businessReferenceType: 'referral-reward-issuance',
      businessReferenceId: sourceId,
      idempotencyScope: 'rewards.issue.referral',
      idempotencyKey,
      assetId: source.asset_id,
      entries: [
        {
          ledgerAccountId: expense.id,
          direction: 'DEBIT',
          amountAtomic: amountText,
        },
        {
          ledgerAccountId: pending.id,
          direction: 'CREDIT',
          amountAtomic: amountText,
        },
      ],
      metadata: {
        sourceRewardEventId: sourceId,
        referralEdgeId: edge.id,
        referrerUserId: edge.referrer_user_id,
        rateBps: rate.effectiveRateBps,
        rateSource: rate.rateSource,
        referralRuleVersion: rate.referralRuleVersion,
        userMembershipId: rate.userMembershipId,
        entitlementRuleVersionId: rate.entitlementRuleVersionId,
      },
    });

    // pending_until must not precede source available_at (safe V1: use max(available_at, asOf)).
    const pendingUntil =
      source.available_at.getTime() > asOf.getTime() ? source.available_at : asOf;

    const referrerEvent = await client.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, reward_quote_id, asset_id, amount_atomic,
         state, reward_rule_id, rule_version, ledger_transaction_id, pending_until
       ) VALUES (
         $1::uuid, 'REFERRAL'::reward_source_type, $2::uuid, NULL, $3::uuid, $4::bigint,
         'PENDING', NULL, NULL, $5::uuid, $6::timestamptz
       )
       RETURNING id`,
      [
        edge.referrer_user_id,
        referralSourceId,
        source.asset_id,
        amountText,
        ledger.id,
        pendingUntil.toISOString(),
      ],
    );
    const referrerRewardEventId = referrerEvent.rows[0]?.id;
    if (referrerRewardEventId === undefined) {
      throw new RewardDomainError('INTERNAL', 'referrer reward_event insert failed');
    }

    await client.query(
      `INSERT INTO reward_maturities (reward_event_id, scheduled_for, status, workflow_id)
       VALUES ($1::uuid, $2::timestamptz, 'SCHEDULED', $3)`,
      [
        referrerRewardEventId,
        pendingUntil.toISOString(),
        `reward-maturity/${referrerRewardEventId}`,
      ],
    );

    const link = await client.query<{ id: string }>(
      `INSERT INTO referral_reward_events (
         referral_edge_id, referrer_user_id, source_reward_event_id, referrer_reward_event_id,
         rate_bps, rule_version, amount_atomic,
         rate_source, user_membership_id, entitlement_rule_version_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid,
         $5, $6, $7::bigint,
         $8::referral_rate_source, $9::uuid, $10::uuid
       )
       RETURNING id`,
      [
        edge.id,
        edge.referrer_user_id,
        sourceId,
        referrerRewardEventId,
        rate.effectiveRateBps,
        rate.referralRuleVersion,
        amountText,
        rate.rateSource,
        rate.userMembershipId,
        rate.entitlementRuleVersionId,
      ],
    );
    const referralRewardEventId = link.rows[0]?.id;
    if (referralRewardEventId === undefined) {
      throw new RewardDomainError('INTERNAL', 'referral_reward_events insert failed');
    }

    await client.query(
      `UPDATE economic_exposure_periods
       SET reserved_atomic = reserved_atomic - $2::bigint,
           consumed_atomic = consumed_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1::uuid`,
      [period.id, amountText],
    );
    await client.query(
      `UPDATE referral_bonus_exposure_reservations
       SET state = 'CONSUMED', consumed_at = $2::timestamptz, updated_at = now()
       WHERE id = $1::uuid`,
      [reservationId, asOf.toISOString()],
    );

    const decisionId = await recordDecision(client, {
      sourceRewardEventId: sourceId,
      referralEdgeId: edge.id,
      outcome: 'ISSUED',
      reasonCode: 'ISSUED',
      amountAtomic: amountText,
      referrerRewardEventId,
      referralRewardEventId,
      exposureLimitId: limit.id,
      exposurePeriodId: period.id,
      rateBps: rate.effectiveRateBps,
      rateSource: rate.rateSource,
      referralRuleVersion: rate.referralRuleVersion,
      userMembershipId: rate.userMembershipId,
      entitlementRuleVersionId: rate.entitlementRuleVersionId,
    });

    await insertOutboxEvent(client, {
      aggregateType: 'reward_event',
      aggregateId: referrerRewardEventId,
      eventType: 'reward_event.referral_issued',
      dedupeKey: `reward-event-referral-issued/${referrerRewardEventId}`,
      payload: {
        sourceRewardEventId: sourceId,
        referrerRewardEventId,
        referralRewardEventId,
        referralEdgeId: edge.id,
        amountAtomic: amountText,
        ledgerTransactionId: ledger.id,
      },
    });

    return softResult('issued', sourceId, 'ISSUED', {
      decisionId,
      referralEdgeId: edge.id,
      amountAtomic: amountText,
      referrerRewardEventId,
      referralRewardEventId,
      ledgerTransactionId: ledger.id,
    });
  });
}
