/**
 * Phase 21 — PRODUCTION safety flag baseline tooling.
 *
 * Default: DRY_RUN. Apply only when BOTH
 *   PHASE21_PRODUCTION_FLAG_BASELINE_APPLY=1 AND
 *   PHASE21_OPERATIONAL_CEREMONY_ENABLED=true
 *
 * Step 3A implements tooling only — do not execute against operational DB.
 * Creates missing PRODUCTION rows; refuses conflicts; never unpauses; idempotent exact retry.
 */
export type Phase21ProductionFlagBaselineMode = 'DRY_RUN' | 'APPLY';

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
}

export interface Phase21ProductionFlagBaselineClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

function applyGatesEnabled(): boolean {
  return (
    process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY === '1' &&
    process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED === 'true'
  );
}

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

/**
 * Dry-run by default. Apply creates only missing rows when gated.
 */
export async function runPhase21ProductionFlagBaseline(
  client: Phase21ProductionFlagBaselineClient,
  options?: { readonly forceApply?: boolean },
): Promise<Phase21ProductionFlagBaselineResult> {
  const applyAuthorized = options?.forceApply === true || applyGatesEnabled();
  const mode: Phase21ProductionFlagBaselineMode = applyAuthorized ? 'APPLY' : 'DRY_RUN';
  const planned = await planPhase21ProductionFlagBaseline(client);
  const conflicts = planned.filter((r) => r.action === 'CONFLICT');

  if (conflicts.length > 0) {
    return {
      mode,
      applyAuthorized,
      applied: false,
      rows: planned,
      conflicts,
      createdCount: 0,
      notes: [
        'Conflicts present — refuse apply',
        'No unpause / no overwrite of differing enabled values',
        'Step 3A must not execute against operational DB',
      ],
    };
  }

  if (mode === 'DRY_RUN') {
    return {
      mode,
      applyAuthorized: false,
      applied: false,
      rows: planned,
      conflicts: [],
      createdCount: 0,
      notes: [
        'DRY_RUN default',
        'Set PHASE21_PRODUCTION_FLAG_BASELINE_APPLY=1 and PHASE21_OPERATIONAL_CEREMONY_ENABLED=true to apply',
        'Step 3A implements tooling only — do not execute against operational DB',
      ],
    };
  }

  let createdCount = 0;
  for (const row of planned) {
    if (row.action !== 'CREATE') continue;
    await client.query(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ($1, 'PRODUCTION'::environment_name, $2, $3)`,
      [
        row.flagKey,
        row.desiredEnabled,
        'Phase 21 PRODUCTION safety flag baseline (Owner ceremony)',
      ],
    );
    createdCount += 1;
  }

  return {
    mode: 'APPLY',
    applyAuthorized: true,
    applied: true,
    rows: planned,
    conflicts: [],
    createdCount,
    notes: [
      'Applied missing PRODUCTION baseline rows only',
      'No unpause performed',
      'Idempotent exact retry leaves ALREADY_MATCHES rows untouched',
    ],
  };
}