/**
 * Phase 15 referral test helpers.
 * Destructive against PHASE15_DATABASE_URL (or PHASE15_REFERRAL_TESTS=1 + DATABASE_URL).
 */
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool, type PoolClient } from 'pg';

const explicitUrl = process.env.PHASE15_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE15_REFERRAL_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase15DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

/** Explicit TEST-ONLY base rate — not the banned production 500 bps default. */
export const TEST_REFERRAL_BASE_RATE_BPS = 123;

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

/** Explicit TEST-ONLY referral rule row — not a production seed. */
export async function insertReferralRule(
  pool: Pool,
  input: {
    readonly ruleVersion: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly effectiveFrom: Date;
    readonly effectiveTo?: Date | null;
    readonly activationAccountAgeSeconds?: number;
    readonly activationValidAdCount?: number;
    readonly baseRateBps?: number;
    readonly reason?: string | null;
    readonly sourceReference?: string | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO referral_rule_versions (
       rule_version, activation_account_age_seconds, activation_valid_ad_count,
       base_rate_bps, status, effective_from, effective_to, reason, source_reference
     ) VALUES (
       $1, $2, $3, $4, $5::rule_version_status, $6::timestamptz, $7::timestamptz, $8, $9
     )
     RETURNING id`,
    [
      input.ruleVersion,
      input.activationAccountAgeSeconds ?? 0,
      input.activationValidAdCount ?? 0,
      input.baseRateBps ?? TEST_REFERRAL_BASE_RATE_BPS,
      input.status,
      input.effectiveFrom.toISOString(),
      input.effectiveTo === undefined || input.effectiveTo === null
        ? null
        : input.effectiveTo.toISOString(),
      input.reason ?? 'phase15-test-only',
      input.sourceReference ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('referral rule insert failed');
  return id;
}

export async function insertReferralCode(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly code: string;
    readonly status?: 'ACTIVE' | 'DISABLED';
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO referral_codes (user_id, code, status)
     VALUES ($1::uuid, $2, $3::activation_status)
     RETURNING id`,
    [input.userId, input.code, input.status ?? 'ACTIVE'],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('referral code insert failed');
  return id;
}

export async function insertPendingEdge(
  pool: Pool,
  input: {
    readonly referrerUserId: string;
    readonly referredUserId: string;
    readonly codeId: string;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO referral_edges (
       referrer_user_id, referred_user_id, code_id, state
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, 'PENDING'::referral_edge_state
     )
     RETURNING id`,
    [input.referrerUserId, input.referredUserId, input.codeId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('referral edge insert failed');
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
