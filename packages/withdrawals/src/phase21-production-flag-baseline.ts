/**
 * Phase 21 — PRODUCTION safety flag baseline tooling.
 *
 * PLAN: read-only; no apply gates required.
 * APPLY: atomic transaction; requires ceremony gates + DB identity.
 * Never accepts forceApply. Never unpauses. Never overwrites conflicts.
 */
import type { PoolClient } from 'pg';

import {
  assertPhase21CeremonyApplyGates,
  Phase21CeremonyApplyGateError,
  type Phase21CeremonyApplyGateClient,
} from './phase21-ceremony-apply-gates.js';

export type Phase21ProductionFlagBaselineMode = 'PLAN' | 'APPLY' | 'REFUSED';

/** enabled=true means paused for pause flags. */
export const PHASE21_PRODUCTION_FLAG_BASELINE = [
  { flagKey: 'WITHDRAWAL_REQUESTS_PAUSE', enabled: true },
  { flagKey: 'PAYOUT_DISPATCH_PAUSE', enabled: true },
  { flagKey: 'AUTO_PAYOUT_PAUSE', enabled: true },
  { flagKey: 'GLOBAL_REWARDS_PAUSE', enabled: true },
  { flagKey: 'REFERRAL_REWARD_PAUSE', enabled: true },
  { flagKey: 'MISSION_REWARD_PAUSE', enabled: true },
  { flagKey: 'MEMBERSHIP_BONUS_PAUSE', enabled: true },
  { flagKey: 'PUBLIC_PAYOUT_LOGS_ENABLED', enabled: false },
] as const;

export type Phase21ProductionBaselineFlagKey =
  (typeof PHASE21_PRODUCTION_FLAG_BASELINE)[number]['flagKey'];

export interface Phase21ProductionFlagBaselinePlanRow {
  readonly flagKey: string;
  readonly environment: 'PRODUCTION';
  readonly desiredEnabled: boolean;
  readonly action: 'CREATE' | 'ALREADY_MATCHES' | 'CONFLICT';
  readonly existingEnabled: boolean | null;
  readonly note: string;
}

export interface Phase21ProductionFlagBaselineResult {
  readonly mode: Phase21ProductionFlagBaselineMode;
  readonly applyAuthorized: boolean;
  readonly applied: boolean;
  readonly rows: readonly Phase21ProductionFlagBaselinePlanRow[];
  readonly conflicts: readonly Phase21ProductionFlagBaselinePlanRow[];
  readonly createdCount: number;
  readonly notes: readonly string[];
  readonly refuseCode?: string;
}

export interface Phase21ProductionFlagBaselineClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface Phase21ProductionFlagBaselineApplyInput {
  readonly reason: string;
  /** Explicit; null allowed (SYSTEM actor / NULL changed_by_admin_id). */
  readonly changedByAdminId: string | null;
}

/** Advisory lock class for production flag baseline APPLY serialization. */
export const PHASE21_PRODUCTION_FLAG_BASELINE_LOCK_KEY1 = 21000302;

const FLAG_DESCRIPTION = 'Phase 21 PRODUCTION safety flag baseline (Owner ceremony)';
const AUDIT_ACTION = 'phase21.production_flag_baseline.create';

export async function planPhase21ProductionFlagBaseline(
  client: Phase21ProductionFlagBaselineClient,
): Promise<readonly Phase21ProductionFlagBaselinePlanRow[]> {
  const rows: Phase21ProductionFlagBaselinePlanRow[] = [];
  for (const flag of PHASE21_PRODUCTION_FLAG_BASELINE) {
    const existing = await client.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags
       WHERE flag_key = $1 AND environment = 'PRODUCTION'::environment_name
       LIMIT 1`,
      [flag.flagKey],
    );
    const row = existing.rows[0];
    if (row === undefined) {
      rows.push({
        flagKey: flag.flagKey,
        environment: 'PRODUCTION',
        desiredEnabled: flag.enabled,
        action: 'CREATE',
        existingEnabled: null,
        note: 'missing PRODUCTION row; would create',
      });
      continue;
    }
    if (row.enabled === flag.enabled) {
      rows.push({
        flagKey: flag.flagKey,
        environment: 'PRODUCTION',
        desiredEnabled: flag.enabled,
        action: 'ALREADY_MATCHES',
        existingEnabled: row.enabled,
        note: 'idempotent exact match',
      });
      continue;
    }
    rows.push({
      flagKey: flag.flagKey,
      environment: 'PRODUCTION',
      desiredEnabled: flag.enabled,
      action: 'CONFLICT',
      existingEnabled: row.enabled,
      note: 'existing row differs; refuse to overwrite or unpause',
    });
  }
  return rows;
}

async function insertFlagWithHistory(
  client: PoolClient,
  input: {
    readonly flagKey: string;
    readonly desiredEnabled: boolean;
    readonly reason: string;
    readonly changedByAdminId: string | null;
  },
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO feature_flags (flag_key, environment, enabled, description)
     VALUES ($1, 'PRODUCTION'::environment_name, $2, $3)
     RETURNING id`,
    [input.flagKey, input.desiredEnabled, FLAG_DESCRIPTION],
  );
  const flagId = inserted.rows[0]?.id;
  if (flagId === undefined) {
    throw new Error(`feature_flags INSERT failed for ${input.flagKey}`);
  }

  await client.query(
    `INSERT INTO feature_flag_versions (
       feature_flag_id, flag_version, old_enabled, new_enabled, reason, changed_by_admin_id
     ) VALUES ($1::uuid, 1, NULL, $2, $3, $4::uuid)`,
    [flagId, input.desiredEnabled, input.reason, input.changedByAdminId],
  );

  const actorType = input.changedByAdminId === null ? 'SYSTEM' : 'ADMIN';
  await client.query(
    `INSERT INTO audit_logs (
       admin_user_id, actor_type, action_type, resource_type, resource_id,
       after_snapshot, reason, source
     ) VALUES (
       $1::uuid, $2::actor_type, $3, 'feature_flag', $4::uuid,
       $5::jsonb, $6, 'SYSTEM'::actor_source
     )`,
    [
      input.changedByAdminId,
      actorType,
      AUDIT_ACTION,
      flagId,
      JSON.stringify({
        flagKey: input.flagKey,
        environment: 'PRODUCTION',
        enabled: input.desiredEnabled,
      }),
      input.reason,
    ],
  );

  return flagId;
}

/**
 * Atomic APPLY. Requires ceremony gates. Uses advisory xact lock + single transaction.
 * Conflicts → ROLLBACK refuse. Any error → ROLLBACK.
 */
export async function applyPhase21ProductionFlagBaseline(
  client: PoolClient,
  input: Phase21ProductionFlagBaselineApplyInput,
): Promise<Phase21ProductionFlagBaselineResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    return {
      mode: 'REFUSED',
      applyAuthorized: false,
      applied: false,
      rows: [],
      conflicts: [],
      createdCount: 0,
      notes: ['APPLY refused: reason is required'],
      refuseCode: 'REASON_REQUIRED',
    };
  }

  try {
    await assertPhase21CeremonyApplyGates(
      client as Phase21CeremonyApplyGateClient,
      'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
    );
  } catch (error: unknown) {
    const code =
      error instanceof Phase21CeremonyApplyGateError ? error.code : 'APPLY_GATE_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: 'REFUSED',
      applyAuthorized: false,
      applied: false,
      rows: [],
      conflicts: [],
      createdCount: 0,
      notes: [`APPLY refused: ${message}`],
      refuseCode: code,
    };
  }

  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT pg_advisory_xact_lock($1::int, hashtext('phase21-production-flag-baseline'))`,
      [PHASE21_PRODUCTION_FLAG_BASELINE_LOCK_KEY1],
    );

    const planned = await planPhase21ProductionFlagBaseline(client);
    const conflicts = planned.filter((r) => r.action === 'CONFLICT');
    if (conflicts.length > 0) {
      await client.query('ROLLBACK');
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        rows: planned,
        conflicts,
        createdCount: 0,
        notes: [
          'Conflicts present — refuse apply; transaction rolled back',
          'No unpause / no overwrite of differing enabled values',
        ],
        refuseCode: 'CONFLICTS_PRESENT',
      };
    }

    let createdCount = 0;
    for (const row of planned) {
      if (row.action !== 'CREATE') continue;
      await insertFlagWithHistory(client, {
        flagKey: row.flagKey,
        desiredEnabled: row.desiredEnabled,
        reason,
        changedByAdminId: input.changedByAdminId,
      });
      createdCount += 1;
    }

    const verified = await planPhase21ProductionFlagBaseline(client);
    const incomplete = verified.filter((r) => r.action !== 'ALREADY_MATCHES');
    if (incomplete.length > 0) {
      await client.query('ROLLBACK');
      return {
        mode: 'REFUSED',
        applyAuthorized: true,
        applied: false,
        rows: verified,
        conflicts: incomplete.filter((r) => r.action === 'CONFLICT'),
        createdCount: 0,
        notes: [
          'Post-apply re-verify failed — transaction rolled back',
          ...incomplete.map((r) => `${r.flagKey}:${r.action}`),
        ],
        refuseCode: 'POST_APPLY_VERIFY_FAILED',
      };
    }

    await client.query('COMMIT');
    return {
      mode: 'APPLY',
      applyAuthorized: true,
      applied: true,
      rows: verified,
      conflicts: [],
      createdCount,
      notes: [
        'Applied missing PRODUCTION baseline rows atomically',
        'feature_flag_versions v1 + audit_logs written for CREATE rows',
        'No unpause performed',
        'Idempotent exact retry leaves ALREADY_MATCHES rows untouched',
      ],
    };
  } catch (error: unknown) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: 'REFUSED',
      applyAuthorized: true,
      applied: false,
      rows: [],
      conflicts: [],
      createdCount: 0,
      notes: [`APPLY aborted and rolled back: ${message}`],
      refuseCode: 'APPLY_EXCEPTION',
    };
  }
}

/**
 * Convenience PLAN wrapper (read-only). Prefer planPhase21ProductionFlagBaseline.
 * Does not mutate. Does not authorize APPLY.
 */
export async function runPhase21ProductionFlagBaseline(
  client: Phase21ProductionFlagBaselineClient,
): Promise<Phase21ProductionFlagBaselineResult> {
  const planned = await planPhase21ProductionFlagBaseline(client);
  const conflicts = planned.filter((r) => r.action === 'CONFLICT');
  return {
    mode: 'PLAN',
    applyAuthorized: false,
    applied: false,
    rows: planned,
    conflicts,
    createdCount: 0,
    notes: [
      'PLAN only (read-only)',
      'APPLY requires applyPhase21ProductionFlagBaseline + DEPLOYMENT_ENV=production + ceremony gates + PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
      'forceApply is not supported',
    ],
  };
}
