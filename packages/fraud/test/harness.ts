/**
 * Phase 14 fraud test helpers.
 * Destructive against PHASE14_DATABASE_URL (or PHASE14_FRAUD_TESTS=1 + DATABASE_URL).
 */
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool, type PoolClient } from 'pg';

const explicitUrl = process.env.PHASE14_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE14_FRAUD_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase14DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export function createPool(url: string): Pool {
  return new Pool({ connectionString: url });
}

export async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

/** Explicit TEST-ONLY fixture — not a production seed. */
export const TEST_RULE_THRESHOLDS = {
  lowMax: 20,
  mediumMax: 50,
  highMax: 75,
} as const;

export const TEST_RULE_WEIGHTS = {
  ACCOUNT_AGE: 10,
  WALLET_REUSE: 15,
} as const;

export const TEST_RULE_ACTIONS = {
  LOW: 'MANUAL_REVIEW',
  MEDIUM: 'MANUAL_REVIEW',
  HIGH: 'HELD',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

export async function insertRiskRule(
  pool: Pool,
  input: {
    readonly ruleVersion: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date | null;
    readonly thresholds?: unknown;
    readonly signalWeights?: unknown;
    readonly signalParams?: unknown;
    readonly actions?: unknown;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO risk_rule_versions (
       rule_version, thresholds, signal_weights, signal_params, actions, status,
       effective_from, effective_to, reason
     ) VALUES (
       $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::rule_version_status,
       $7::timestamptz, $8::timestamptz, $9
     )
     RETURNING id`,
    [
      input.ruleVersion,
      JSON.stringify(input.thresholds ?? TEST_RULE_THRESHOLDS),
      JSON.stringify(input.signalWeights ?? TEST_RULE_WEIGHTS),
      JSON.stringify(input.signalParams ?? {}),
      JSON.stringify(input.actions ?? TEST_RULE_ACTIONS),
      input.status,
      input.effectiveFrom.toISOString(),
      input.effectiveTo === undefined || input.effectiveTo === null
        ? null
        : input.effectiveTo.toISOString(),
      'phase14-test-only',
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('risk rule insert failed');
  return id;
}

export async function createTestUser(pool: Pool, telegramUserId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, preferred_locale)
     VALUES ($1::bigint, 'en')
     RETURNING id`,
    [telegramUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return id;
}

/**
 * Explicit TEST-ONLY Trust policy fixture — not a production seed.
 * Used as the ACTIVE default for insertTrustRule when policyConfig is omitted.
 */
export const TEST_TRUST_POLICY_CONFIG = {
  signals: {
    ACCOUNT_AGE: { weight: 25, minDays: 7 },
    VERIFIED_PRIMARY_WALLET_AGE: { weight: 25, minDays: 3 },
    REWARDED_AD_HISTORY: { weight: 25, minCount: 1 },
    CONFIRMED_PAYOUT_HISTORY: { weight: 25, minCount: 1 },
  },
  stateThresholds: {
    basicMin: 25,
    establishedMin: 50,
    trustedMin: 75,
  },
} as const;

/** Explicit TEST-ONLY Trust rule row — not a production seed. */
export async function insertTrustRule(
  pool: Pool,
  input: {
    readonly ruleVersion: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date | null;
    readonly reason?: string | null;
    readonly policyConfig?: unknown | null;
  },
): Promise<string> {
  const policyConfig =
    input.policyConfig !== undefined
      ? input.policyConfig
      : input.status === 'ACTIVE'
        ? TEST_TRUST_POLICY_CONFIG
        : null;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO trust_rule_versions (
       rule_version, status, effective_from, effective_to, reason, policy_config
     ) VALUES (
       $1, $2::rule_version_status, $3::timestamptz, $4::timestamptz, $5, $6::jsonb
     )
     RETURNING id`,
    [
      input.ruleVersion,
      input.status,
      input.effectiveFrom.toISOString(),
      input.effectiveTo === undefined || input.effectiveTo === null
        ? null
        : input.effectiveTo.toISOString(),
      input.reason ?? 'phase14-trust-test-only',
      policyConfig === null ? null : JSON.stringify(policyConfig),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('trust rule insert failed');
  return id;
}

/** Explicit TEST-ONLY Eligibility policy config — not a production seed. */
export const TEST_ELIGIBILITY_POLICY_CONFIG = {
  actions: {
    WITHDRAWAL_REQUEST: {
      requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY', 'FEATURE_FLAG'],
      precedence: ['RISK_POLICY', 'ACCOUNT_STATE', 'FEATURE_FLAG'],
      riskAllowedActions: ['ALLOW', 'EXTEND_PENDING', 'MANUAL_REVIEW', 'HELD'],
    },
    AD_SESSION_START: {
      requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
      precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
    },
    MISSION_CLAIM: {
      requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
      precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
    },
    TASK_CLAIM: {
      requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
      precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
    },
  },
} as const;

/** Explicit TEST-ONLY Eligibility policy row — not a production seed. */
export async function insertEligibilityPolicy(
  pool: Pool,
  input: {
    readonly policyVersion: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date | null;
    readonly reason?: string | null;
    readonly policyConfig?: unknown | null;
  },
): Promise<string> {
  const policyConfig =
    input.policyConfig !== undefined
      ? input.policyConfig
      : input.status === 'ACTIVE'
        ? TEST_ELIGIBILITY_POLICY_CONFIG
        : null;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO eligibility_policy_versions (
       policy_version, status, effective_from, effective_to, reason, policy_config
     ) VALUES (
       $1, $2::rule_version_status, $3::timestamptz, $4::timestamptz, $5, $6::jsonb
     )
     RETURNING id`,
    [
      input.policyVersion,
      input.status,
      input.effectiveFrom.toISOString(),
      input.effectiveTo === undefined || input.effectiveTo === null
        ? null
        : input.effectiveTo.toISOString(),
      input.reason ?? 'phase14-eligibility-test-only',
      policyConfig === null ? null : JSON.stringify(policyConfig),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('eligibility policy insert failed');
  return id;
}

/** Deterministic wait until another backend is blocked on holderPid's granted locks. */
export async function waitForBlockedOnHolder(
  watcher: PoolClient,
  holderPid: number,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const waiting = await watcher.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM pg_locks blocked
       JOIN pg_locks holder
         ON holder.locktype = blocked.locktype
        AND holder.database IS NOT DISTINCT FROM blocked.database
        AND holder.relation IS NOT DISTINCT FROM blocked.relation
        AND holder.page IS NOT DISTINCT FROM blocked.page
        AND holder.tuple IS NOT DISTINCT FROM blocked.tuple
        AND holder.virtualxid IS NOT DISTINCT FROM blocked.virtualxid
        AND holder.transactionid IS NOT DISTINCT FROM blocked.transactionid
        AND holder.classid IS NOT DISTINCT FROM blocked.classid
        AND holder.objid IS NOT DISTINCT FROM blocked.objid
        AND holder.objsubid IS NOT DISTINCT FROM blocked.objsubid
        AND holder.pid <> blocked.pid
       WHERE NOT blocked.granted
         AND holder.granted
         AND holder.pid = $1`,
      [holderPid],
    );
    if ((waiting.rows[0]?.c ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}
