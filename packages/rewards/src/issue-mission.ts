/**
 * Phase 16 Step 5 — Mission reward issuance via Reward Engine + Ledger.
 * packages/tasks must never call Ledger; this module owns money movement.
 *
 * Post-grant AD reversal cascade: OWNER_POLICY_REQUIRED (not implemented).
 */
import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import {
  evaluateAndPersistEligibility,
  type DeploymentEnvironment,
} from '@alex-rewards/fraud';
import {
  amountAtomicToString,
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
  type LedgerDb,
} from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';
import { lockOrCreateExposurePeriod, utcDayWindow } from './exposure.js';
import { insertOutboxEvent } from './outbox.js';
import type { EnvironmentName } from './types.js';

export type MissionIssuanceKind =
  | 'issued'
  | 'already_granted'
  | 'blocked_pause'
  | 'blocked_budget'
  | 'blocked_exposure'
  | 'blocked_eligibility'
  | 'source_evidence_invalid'
  | 'configuration_missing';

export interface IssueMissionRewardCommand {
  readonly missionClaimId: string;
  readonly environment: EnvironmentName;
  readonly idempotencyKey?: string;
  readonly asOf?: Date;
}

export interface IssueMissionRewardResult {
  readonly kind: MissionIssuanceKind;
  readonly reasonCode: string;
  readonly missionClaimId: string;
  readonly amountAtomic: string | null;
  readonly rewardEventId: string | null;
  readonly ledgerTransactionId: string | null;
  readonly decisionId: string | null;
}

/** Deterministic UUID for MISSION reward_events.source_id from claim id. */
export function missionRewardSourceIdFromClaim(missionClaimId: string): string {
  const digest = createHash('sha256')
    .update(`alex-rewards:mission-reward:${missionClaimId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function toDeploymentEnvironment(environment: EnvironmentName): DeploymentEnvironment {
  return environment;
}

function softResult(
  kind: MissionIssuanceKind,
  missionClaimId: string,
  reasonCode: string,
  extras: Partial<IssueMissionRewardResult> = {},
): IssueMissionRewardResult {
  return {
    kind,
    reasonCode,
    missionClaimId,
    amountAtomic: extras.amountAtomic ?? null,
    rewardEventId: extras.rewardEventId ?? null,
    ledgerTransactionId: extras.ledgerTransactionId ?? null,
    decisionId: extras.decisionId ?? null,
  };
}

async function recordDecision(
  client: PoolClient,
  input: {
    readonly missionClaimId: string;
    readonly missionProgressId: string;
    readonly missionVersionId: string;
    readonly outcome:
      | 'ISSUED'
      | 'BLOCKED_PAUSE'
      | 'BLOCKED_BUDGET'
      | 'BLOCKED_EXPOSURE'
      | 'BLOCKED_ELIGIBILITY'
      | 'SOURCE_EVIDENCE_INVALID'
      | 'CONFIGURATION_MISSING';
    readonly reasonCode: string;
    readonly amountAtomic?: string | null;
    readonly rewardEventId?: string | null;
    readonly rewardRuleId?: string | null;
    readonly rewardRuleVersion?: number | null;
    readonly assetId?: string | null;
    readonly eligibilityDecisionId?: string | null;
    readonly budgetPeriodId?: string | null;
    readonly exposureLimitId?: string | null;
    readonly exposurePeriodId?: string | null;
    readonly ledgerTransactionId?: string | null;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO mission_reward_decisions (
       mission_claim_id, mission_progress_id, mission_version_id, outcome, reason_code,
       amount_atomic, reward_event_id, reward_rule_id, reward_rule_version, asset_id,
       eligibility_decision_id, budget_period_id, exposure_limit_id, exposure_period_id,
       ledger_transaction_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::mission_reward_decision_outcome, $5,
       $6::bigint, $7::uuid, $8::uuid, $9, $10::uuid,
       $11::uuid, $12::uuid, $13::uuid, $14::uuid,
       $15::uuid
     )
     RETURNING id`,
    [
      input.missionClaimId,
      input.missionProgressId,
      input.missionVersionId,
      input.outcome,
      input.reasonCode,
      input.amountAtomic ?? null,
      input.rewardEventId ?? null,
      input.rewardRuleId ?? null,
      input.rewardRuleVersion ?? null,
      input.assetId ?? null,
      input.eligibilityDecisionId ?? null,
      input.budgetPeriodId ?? null,
      input.exposureLimitId ?? null,
      input.exposurePeriodId ?? null,
      input.ledgerTransactionId ?? null,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) {
    throw new RewardDomainError('INTERNAL', 'mission_reward_decisions insert failed');
  }
  return id;
}

async function loadIssuedDecision(
  client: PoolClient,
  missionClaimId: string,
): Promise<IssueMissionRewardResult | null> {
  const existing = await client.query<{
    id: string;
    reason_code: string;
    amount_atomic: string | null;
    reward_event_id: string | null;
    ledger_transaction_id: string | null;
  }>(
    `SELECT id, reason_code, amount_atomic::text AS amount_atomic,
            reward_event_id, ledger_transaction_id
     FROM mission_reward_decisions
     WHERE mission_claim_id = $1::uuid
       AND outcome = 'ISSUED'
     LIMIT 1`,
    [missionClaimId],
  );
  const row = existing.rows[0];
  if (row === undefined) return null;
  return softResult('already_granted', missionClaimId, row.reason_code, {
    decisionId: row.id,
    amountAtomic: row.amount_atomic,
    rewardEventId: row.reward_event_id,
    ledgerTransactionId: row.ledger_transaction_id,
  });
}

async function isMissionRewardPaused(
  client: PoolClient,
  environment: EnvironmentName,
): Promise<'missing' | 'paused' | 'ok'> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags
     WHERE flag_key = 'MISSION_REWARD_PAUSE' AND environment = $1::environment_name
     FOR SHARE`,
    [environment],
  );
  const row = result.rows[0];
  if (row === undefined) return 'missing';
  return row.enabled === true ? 'paused' : 'ok';
}

async function assertValidAdEvidence(
  client: PoolClient,
  input: {
    readonly progressId: string;
    readonly conditionType: string;
    readonly target: number;
  },
): Promise<boolean> {
  if (input.conditionType !== 'VALID_AD_COUNT') return true;
  const valid = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM mission_progress_events mpe
     INNER JOIN reward_events re ON re.id = mpe.source_key::uuid
     WHERE mpe.mission_progress_id = $1::uuid
       AND mpe.source_kind = 'REWARD_EVENT'
       AND re.source_type = 'AD'
       AND re.state = 'AVAILABLE'`,
    [input.progressId],
  );
  return (valid.rows[0]?.c ?? 0) >= input.target;
}

/**
 * Issue a monetary Mission reward for a PENDING claim.
 * Soft blocks keep the claim PENDING for worker redrive.
 */
export async function issueMissionReward(
  db: LedgerDb,
  command: IssueMissionRewardCommand,
): Promise<IssueMissionRewardResult> {
  return withLedgerTransaction(db, async (client) => {
    const asOf = command.asOf ?? new Date();
    const claimId = command.missionClaimId;

    const claimLocked = await client.query<{
      id: string;
      mission_version_id: string;
      mission_progress_id: string;
      user_id: string;
      period_key: string;
      status: string;
      reward_event_id: string | null;
      claimed_at: Date;
    }>(
      `SELECT id, mission_version_id, mission_progress_id, user_id, period_key,
              status::text AS status, reward_event_id, claimed_at
       FROM mission_claims
       WHERE id = $1::uuid
       FOR UPDATE`,
      [claimId],
    );
    const claim = claimLocked.rows[0];
    if (claim === undefined) {
      throw new RewardDomainError('VALIDATION', 'mission claim not found', {
        details: { missionClaimId: claimId },
      });
    }

    if (claim.status === 'GRANTED') {
      const prior = await loadIssuedDecision(client, claimId);
      if (prior !== null) return prior;
      let ledgerTransactionId: string | null = null;
      if (claim.reward_event_id !== null) {
        const ledger = await client.query<{ ledger_transaction_id: string | null }>(
          `SELECT ledger_transaction_id FROM reward_events WHERE id = $1::uuid`,
          [claim.reward_event_id],
        );
        ledgerTransactionId = ledger.rows[0]?.ledger_transaction_id ?? null;
      }
      return softResult('already_granted', claimId, 'CLAIM_ALREADY_GRANTED', {
        rewardEventId: claim.reward_event_id,
        ledgerTransactionId,
      });
    }

    if (claim.status !== 'PENDING') {
      throw new RewardDomainError('VALIDATION', 'mission claim is not PENDING', {
        details: { missionClaimId: claimId, status: claim.status },
      });
    }

    const priorIssued = await loadIssuedDecision(client, claimId);
    if (priorIssued !== null) return priorIssued;

    const version = await client.query<{
      id: string;
      condition_type: string;
      target: number;
      reward_source_type: string;
      reward_rule_id: string | null;
      required_membership_plan_id: string | null;
      start_at: Date | null;
      end_at: Date | null;
      eligibility_policy: unknown;
    }>(
      `SELECT id, condition_type::text AS condition_type, target,
              reward_source_type::text AS reward_source_type, reward_rule_id,
              required_membership_plan_id, start_at, end_at, eligibility_policy
       FROM mission_versions
       WHERE id = $1::uuid
       FOR SHARE`,
      [claim.mission_version_id],
    );
    const mv = version.rows[0];
    if (mv === undefined) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: claim.mission_progress_id,
        missionVersionId: claim.mission_version_id,
        outcome: 'CONFIGURATION_MISSING',
        reasonCode: 'MISSION_VERSION_MISSING',
      });
      return softResult('configuration_missing', claimId, 'MISSION_VERSION_MISSING', {
        decisionId,
      });
    }

    const progress = await client.query<{
      id: string;
      user_id: string;
      state: string;
      progress_count: number;
      target: number;
      period_key: string;
    }>(
      `SELECT id, user_id, state::text AS state, progress_count, target, period_key
       FROM mission_progress
       WHERE id = $1::uuid
       FOR SHARE`,
      [claim.mission_progress_id],
    );
    const prog = progress.rows[0];
    if (
      prog === undefined ||
      prog.user_id !== claim.user_id ||
      prog.period_key !== claim.period_key ||
      prog.state !== 'COMPLETED' ||
      prog.progress_count !== prog.target
    ) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: claim.mission_progress_id,
        missionVersionId: mv.id,
        outcome: 'CONFIGURATION_MISSING',
        reasonCode: 'MISSION_PROGRESS_NOT_COMPLETED',
      });
      return softResult('configuration_missing', claimId, 'MISSION_PROGRESS_NOT_COMPLETED', {
        decisionId,
      });
    }

    // Claim must have been created while window was valid (claimed_at in window).
    if (mv.start_at !== null && claim.claimed_at < mv.start_at) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'CONFIGURATION_MISSING',
        reasonCode: 'CLAIM_OUTSIDE_VERSION_WINDOW',
      });
      return softResult('configuration_missing', claimId, 'CLAIM_OUTSIDE_VERSION_WINDOW', {
        decisionId,
      });
    }
    if (mv.end_at !== null && !(claim.claimed_at < mv.end_at)) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'CONFIGURATION_MISSING',
        reasonCode: 'CLAIM_OUTSIDE_VERSION_WINDOW',
      });
      return softResult('configuration_missing', claimId, 'CLAIM_OUTSIDE_VERSION_WINDOW', {
        decisionId,
      });
    }

    if (!(await assertValidAdEvidence(client, {
      progressId: prog.id,
      conditionType: mv.condition_type,
      target: prog.target,
    }))) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'SOURCE_EVIDENCE_INVALID',
        reasonCode: 'MISSION_SOURCE_EVIDENCE_NO_LONGER_VALID',
      });
      return softResult('source_evidence_invalid', claimId, 'MISSION_SOURCE_EVIDENCE_NO_LONGER_VALID', {
        decisionId,
      });
    }

    const pause = await isMissionRewardPaused(client, command.environment);
    if (pause === 'missing') {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'CONFIGURATION_MISSING',
        reasonCode: 'MISSION_REWARD_PAUSE_MISSING',
      });
      return softResult('configuration_missing', claimId, 'MISSION_REWARD_PAUSE_MISSING', {
        decisionId,
      });
    }
    if (pause === 'paused') {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_PAUSE',
        reasonCode: 'MISSION_REWARD_PAUSE',
      });
      return softResult('blocked_pause', claimId, 'MISSION_REWARD_PAUSE', { decisionId });
    }

    if (mv.reward_source_type !== 'MISSION' || mv.reward_rule_id === null) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'CONFIGURATION_MISSING',
        reasonCode: 'MISSION_REWARD_RULE_MISSING',
      });
      return softResult('configuration_missing', claimId, 'MISSION_REWARD_RULE_MISSING', {
        decisionId,
      });
    }

    const rule = await client.query<{
      id: string;
      rule_version: number;
      source_type: string;
      asset_id: string;
      fixed_reward_atomic: string | null;
      pending_hold_seconds: number;
      status: string;
    }>(
      `SELECT id, rule_version, source_type::text AS source_type, asset_id,
              fixed_reward_atomic::text AS fixed_reward_atomic, pending_hold_seconds,
              status::text AS status
       FROM reward_rules
       WHERE id = $1::uuid
       FOR SHARE`,
      [mv.reward_rule_id],
    );
    const rewardRule = rule.rows[0];
    if (
      rewardRule === undefined ||
      rewardRule.source_type !== 'MISSION' ||
      rewardRule.fixed_reward_atomic === null ||
      BigInt(rewardRule.fixed_reward_atomic) <= 0n
    ) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'CONFIGURATION_MISSING',
        reasonCode: 'MISSION_FIXED_REWARD_UNCONFIGURED',
        rewardRuleId: mv.reward_rule_id,
      });
      return softResult('configuration_missing', claimId, 'MISSION_FIXED_REWARD_UNCONFIGURED', {
        decisionId,
      });
    }

    const amountText = rewardRule.fixed_reward_atomic;
    const amount = BigInt(amountText);

    // Fresh eligibility (account/risk/membership/pause/country).
    const eligibility = await evaluateAndPersistEligibility(client, {
      userId: claim.user_id,
      actionType: 'MISSION_CLAIM',
      serverContext: { deploymentEnvironment: toDeploymentEnvironment(command.environment) },
      missionVersionId: mv.id,
    });
    if (eligibility.evaluation.outcome !== 'ELIGIBLE') {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_ELIGIBILITY',
        reasonCode: eligibility.evaluation.primaryBlockedGateCode ?? 'NOT_ELIGIBLE',
        eligibilityDecisionId: eligibility.decision.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        assetId: rewardRule.asset_id,
      });
      return softResult(
        'blocked_eligibility',
        claimId,
        eligibility.evaluation.primaryBlockedGateCode ?? eligibility.evaluation.outcome,
        { decisionId },
      );
    }

    // MISSION budget period: exact scope_reference_id = mission_version_id + asset.
    const budgets = await client.query<{
      id: string;
      budget_atomic: string;
      reserved_atomic: string;
      consumed_atomic: string;
    }>(
      `SELECT id, budget_atomic::text AS budget_atomic,
              reserved_atomic::text AS reserved_atomic,
              consumed_atomic::text AS consumed_atomic
       FROM reward_budget_periods
       WHERE scope_type = 'MISSION'::budget_scope_type
         AND scope_reference_id = $1::uuid
         AND asset_id = $2::uuid
         AND status = 'ACTIVE'
         AND period_start <= $3::timestamptz
         AND period_end > $3::timestamptz
       ORDER BY id ASC
       FOR UPDATE`,
      [mv.id, rewardRule.asset_id, asOf.toISOString()],
    );
    if (budgets.rows.length === 0) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_BUDGET',
        reasonCode: 'MISSION_BUDGET_MISSING',
        eligibilityDecisionId: eligibility.decision.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        assetId: rewardRule.asset_id,
      });
      return softResult('blocked_budget', claimId, 'MISSION_BUDGET_MISSING', { decisionId });
    }
    if (budgets.rows.length > 1) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_BUDGET',
        reasonCode: 'MISSION_BUDGET_AMBIGUOUS',
        eligibilityDecisionId: eligibility.decision.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        assetId: rewardRule.asset_id,
      });
      return softResult('blocked_budget', claimId, 'MISSION_BUDGET_AMBIGUOUS', { decisionId });
    }
    const budget = budgets.rows[0]!;
    const budgetRemaining =
      BigInt(budget.budget_atomic) - BigInt(budget.reserved_atomic) - BigInt(budget.consumed_atomic);
    if (amount > budgetRemaining) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_BUDGET',
        reasonCode: 'MISSION_BUDGET_EXHAUSTED',
        budgetPeriodId: budget.id,
        eligibilityDecisionId: eligibility.decision.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        assetId: rewardRule.asset_id,
      });
      return softResult('blocked_budget', claimId, 'MISSION_BUDGET_EXHAUSTED', { decisionId });
    }

    // MAX_MISSION_BONUS_DAILY exposure.
    const limits = await client.query<{
      id: string;
      limit_atomic: string | null;
      scope_reference_id: string | null;
      country_group: string | null;
      asset_id: string | null;
    }>(
      `SELECT id, limit_atomic::text AS limit_atomic, scope_reference_id, country_group, asset_id
       FROM economic_exposure_limits
       WHERE limit_code = 'MAX_MISSION_BONUS_DAILY'::exposure_limit_code
         AND status = 'ACTIVE'
         AND environment = $1::environment_name
         AND effective_from <= $2::timestamptz
         AND (effective_to IS NULL OR effective_to > $2::timestamptz)
         AND (asset_id IS NULL OR asset_id = $3::uuid)
         AND (scope_reference_id IS NULL OR scope_reference_id = $4::uuid)
       ORDER BY id ASC
       FOR SHARE`,
      [command.environment, asOf.toISOString(), rewardRule.asset_id, mv.id],
    );
    const applicable = limits.rows.filter((row) => row.country_group === null);
    if (applicable.length === 0) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_EXPOSURE',
        reasonCode: 'MAX_MISSION_BONUS_DAILY_MISSING',
        budgetPeriodId: budget.id,
        eligibilityDecisionId: eligibility.decision.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        assetId: rewardRule.asset_id,
      });
      return softResult('blocked_exposure', claimId, 'MAX_MISSION_BONUS_DAILY_MISSING', {
        decisionId,
      });
    }
    if (applicable.length > 1) {
      // Prefer exact mission-version scope if present; else global null scope.
      const exact = applicable.filter((r) => r.scope_reference_id === mv.id);
      const global = applicable.filter((r) => r.scope_reference_id === null);
      const chosen = exact.length === 1 ? exact : global.length === 1 ? global : null;
      if (chosen === null) {
        const decisionId = await recordDecision(client, {
          missionClaimId: claimId,
          missionProgressId: prog.id,
          missionVersionId: mv.id,
          outcome: 'BLOCKED_EXPOSURE',
          reasonCode: 'MAX_MISSION_BONUS_DAILY_AMBIGUOUS',
          budgetPeriodId: budget.id,
          eligibilityDecisionId: eligibility.decision.id,
          rewardRuleId: rewardRule.id,
          rewardRuleVersion: rewardRule.rule_version,
          assetId: rewardRule.asset_id,
        });
        return softResult('blocked_exposure', claimId, 'MAX_MISSION_BONUS_DAILY_AMBIGUOUS', {
          decisionId,
        });
      }
      applicable.length = 0;
      applicable.push(chosen[0]!);
    }
    const limit = applicable[0]!;
    if (limit.limit_atomic === null) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_EXPOSURE',
        reasonCode: 'MAX_MISSION_BONUS_DAILY_INVALID',
        exposureLimitId: limit.id,
        budgetPeriodId: budget.id,
        eligibilityDecisionId: eligibility.decision.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        assetId: rewardRule.asset_id,
      });
      return softResult('blocked_exposure', claimId, 'MAX_MISSION_BONUS_DAILY_INVALID', {
        decisionId,
      });
    }

    const window = utcDayWindow(asOf);
    const period = await lockOrCreateExposurePeriod(client, {
      exposureLimitId: limit.id,
      limitAtomic: BigInt(limit.limit_atomic),
      window,
    });
    const exposureRemaining =
      BigInt(period.limit_atomic) - BigInt(period.reserved_atomic) - BigInt(period.consumed_atomic);
    if (amount > exposureRemaining) {
      const decisionId = await recordDecision(client, {
        missionClaimId: claimId,
        missionProgressId: prog.id,
        missionVersionId: mv.id,
        outcome: 'BLOCKED_EXPOSURE',
        reasonCode: 'MAX_MISSION_BONUS_DAILY_EXHAUSTED',
        exposureLimitId: limit.id,
        exposurePeriodId: period.id,
        budgetPeriodId: budget.id,
        eligibilityDecisionId: eligibility.decision.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        assetId: rewardRule.asset_id,
      });
      return softResult('blocked_exposure', claimId, 'MAX_MISSION_BONUS_DAILY_EXHAUSTED', {
        decisionId,
      });
    }

    // Reserve budget + exposure.
    await client.query(
      `UPDATE reward_budget_periods
       SET reserved_atomic = reserved_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1::uuid`,
      [budget.id, amountText],
    );
    const budgetRes = await client.query<{ id: string }>(
      `INSERT INTO mission_reward_budget_reservations (
         mission_claim_id, budget_period_id, amount_atomic, state
       ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'ACTIVE')
       RETURNING id`,
      [claimId, budget.id, amountText],
    );
    const budgetReservationId = budgetRes.rows[0]?.id;
    if (budgetReservationId === undefined) {
      throw new RewardDomainError('INTERNAL', 'mission budget reservation insert failed');
    }

    await client.query(
      `UPDATE economic_exposure_periods
       SET reserved_atomic = reserved_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1::uuid`,
      [period.id, amountText],
    );
    const exposureRes = await client.query<{ id: string }>(
      `INSERT INTO mission_bonus_exposure_reservations (
         mission_claim_id, exposure_period_id, amount_atomic, state
       ) VALUES ($1::uuid, $2::uuid, $3::bigint, 'ACTIVE')
       RETURNING id`,
      [claimId, period.id, amountText],
    );
    const exposureReservationId = exposureRes.rows[0]?.id;
    if (exposureReservationId === undefined) {
      throw new RewardDomainError('INTERNAL', 'mission exposure reservation insert failed');
    }

    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'MISSION_REWARD_EXPENSE',
      assetId: rewardRule.asset_id,
    });
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId: rewardRule.asset_id,
      ownerId: claim.user_id,
    });

    const sourceId = missionRewardSourceIdFromClaim(claimId);
    const idempotencyKey = command.idempotencyKey ?? `mission-reward-issuance/${claimId}`;

    const ledger = await postLedgerTransaction(client, {
      transactionType: 'MISSION_REWARD_ISSUANCE',
      businessReferenceType: 'mission-reward-issuance',
      businessReferenceId: claimId,
      idempotencyScope: 'rewards.issue.mission',
      idempotencyKey,
      assetId: rewardRule.asset_id,
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
        missionClaimId: claimId,
        missionVersionId: mv.id,
        missionProgressId: prog.id,
        rewardRuleId: rewardRule.id,
        rewardRuleVersion: rewardRule.rule_version,
        eligibilityDecisionId: eligibility.decision.id,
      },
    });

    const pendingUntil = new Date(
      asOf.getTime() + Math.max(0, rewardRule.pending_hold_seconds) * 1000,
    );

    const rewardEvent = await client.query<{ id: string }>(
      `INSERT INTO reward_events (
         user_id, source_type, source_id, reward_quote_id, asset_id, amount_atomic,
         state, reward_rule_id, rule_version, ledger_transaction_id, pending_until
       ) VALUES (
         $1::uuid, 'MISSION'::reward_source_type, $2::uuid, NULL, $3::uuid, $4::bigint,
         'PENDING', $5::uuid, $6, $7::uuid, $8::timestamptz
       )
       RETURNING id`,
      [
        claim.user_id,
        sourceId,
        rewardRule.asset_id,
        amountText,
        rewardRule.id,
        rewardRule.rule_version,
        ledger.id,
        pendingUntil.toISOString(),
      ],
    );
    const rewardEventId = rewardEvent.rows[0]?.id;
    if (rewardEventId === undefined) {
      throw new RewardDomainError('INTERNAL', 'mission reward_event insert failed');
    }

    await client.query(
      `INSERT INTO reward_maturities (reward_event_id, scheduled_for, status, workflow_id)
       VALUES ($1::uuid, $2::timestamptz, 'SCHEDULED', $3)`,
      [rewardEventId, pendingUntil.toISOString(), `reward-maturity/${rewardEventId}`],
    );

    await client.query(
      `UPDATE reward_budget_periods
       SET reserved_atomic = reserved_atomic - $2::bigint,
           consumed_atomic = consumed_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1::uuid`,
      [budget.id, amountText],
    );
    await client.query(
      `UPDATE mission_reward_budget_reservations
       SET state = 'CONSUMED', consumed_at = $2::timestamptz, updated_at = now()
       WHERE id = $1::uuid`,
      [budgetReservationId, asOf.toISOString()],
    );

    await client.query(
      `UPDATE economic_exposure_periods
       SET reserved_atomic = reserved_atomic - $2::bigint,
           consumed_atomic = consumed_atomic + $2::bigint,
           updated_at = now()
       WHERE id = $1::uuid`,
      [period.id, amountText],
    );
    await client.query(
      `UPDATE mission_bonus_exposure_reservations
       SET state = 'CONSUMED', consumed_at = $2::timestamptz, updated_at = now()
       WHERE id = $1::uuid`,
      [exposureReservationId, asOf.toISOString()],
    );

    await client.query(
      `UPDATE mission_claims
       SET status = 'GRANTED'::mission_claim_status,
           reward_event_id = $2::uuid,
           granted_at = $3::timestamptz,
           updated_at = now()
       WHERE id = $1::uuid`,
      [claimId, rewardEventId, asOf.toISOString()],
    );

    const decisionId = await recordDecision(client, {
      missionClaimId: claimId,
      missionProgressId: prog.id,
      missionVersionId: mv.id,
      outcome: 'ISSUED',
      reasonCode: 'ISSUED',
      amountAtomic: amountText,
      rewardEventId,
      rewardRuleId: rewardRule.id,
      rewardRuleVersion: rewardRule.rule_version,
      assetId: rewardRule.asset_id,
      eligibilityDecisionId: eligibility.decision.id,
      budgetPeriodId: budget.id,
      exposureLimitId: limit.id,
      exposurePeriodId: period.id,
      ledgerTransactionId: ledger.id,
    });

    await insertOutboxEvent(client, {
      aggregateType: 'reward_event',
      aggregateId: rewardEventId,
      eventType: 'reward_event.mission_issued',
      dedupeKey: `reward-event-mission-issued/${rewardEventId}`,
      payload: {
        missionClaimId: claimId,
        rewardEventId,
        missionVersionId: mv.id,
        amountAtomic: amountText,
        ledgerTransactionId: ledger.id,
      },
    });

    return softResult('issued', claimId, 'ISSUED', {
      decisionId,
      amountAtomic: amountText,
      rewardEventId,
      ledgerTransactionId: ledger.id,
    });
  });
}
