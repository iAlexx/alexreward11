/**
 * Phase 14 fraud test helpers.
 * Destructive against PHASE14_DATABASE_URL (or PHASE14_FRAUD_TESTS=1 + DATABASE_URL).
 */
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool } from 'pg';

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
    readonly actions?: unknown;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO risk_rule_versions (
       rule_version, thresholds, signal_weights, actions, status,
       effective_from, effective_to, reason
     ) VALUES (
       $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::rule_version_status,
       $6::timestamptz, $7::timestamptz, $8
     )
     RETURNING id`,
    [
      input.ruleVersion,
      JSON.stringify(input.thresholds ?? TEST_RULE_THRESHOLDS),
      JSON.stringify(input.signalWeights ?? TEST_RULE_WEIGHTS),
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

/** Explicit TEST-ONLY Trust rule row — not a production seed. */
export async function insertTrustRule(
  pool: Pool,
  input: {
    readonly ruleVersion: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date | null;
    readonly reason?: string | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO trust_rule_versions (
       rule_version, status, effective_from, effective_to, reason
     ) VALUES (
       $1, $2::rule_version_status, $3::timestamptz, $4::timestamptz, $5
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
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('trust rule insert failed');
  return id;
}
