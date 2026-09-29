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

export async function createTestUser(
  pool: Pool,
  telegramUserId: string,
  options: { readonly createdAt?: Date } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    options.createdAt === undefined
      ? `INSERT INTO users (telegram_user_id, preferred_locale)
         VALUES ($1::bigint, 'en')
         RETURNING id`
      : `INSERT INTO users (telegram_user_id, preferred_locale, created_at)
         VALUES ($1::bigint, 'en', $2::timestamptz)
         RETURNING id`,
    options.createdAt === undefined
      ? [telegramUserId]
      : [telegramUserId, options.createdAt.toISOString()],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return id;
}

export async function getUsdtAssetId(pool: Pool): Promise<string> {
  const asset = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
  const id = asset.rows[0]?.id;
  if (id === undefined) throw new Error('USDT asset missing');
  return id;
}

export async function insertRewardEvent(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly sourceId: string;
    readonly assetId: string;
    readonly sourceType?: 'AD' | 'TASK' | 'REFERRAL' | 'MEMBERSHIP_BONUS';
    readonly state?: 'CREATED' | 'PENDING' | 'AVAILABLE' | 'REVERSED';
    readonly amountAtomic?: number;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO reward_events (
       user_id, source_type, source_id, asset_id, amount_atomic, state
     ) VALUES (
       $1::uuid, $2::reward_source_type, $3::uuid, $4::uuid, $5, $6::reward_event_state
     )
     RETURNING id`,
    [
      input.userId,
      input.sourceType ?? 'AD',
      input.sourceId,
      input.assetId,
      input.amountAtomic ?? 100,
      input.state ?? 'AVAILABLE',
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('reward_event insert failed');
  return id;
}

export async function insertFraudFlag(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    readonly status?: 'OPEN' | 'REVIEWED' | 'DISMISSED' | 'CONFIRMED';
    readonly flagType?: string;
  },
): Promise<string> {
  const status = input.status ?? 'OPEN';
  const result = await pool.query<{ id: string }>(
    `INSERT INTO fraud_flags (
       user_id, flag_type, severity, status, reviewed_at
     ) VALUES (
       $1::uuid, $2, $3::severity_level, $4::fraud_flag_status,
       CASE WHEN $4::fraud_flag_status = 'OPEN'::fraud_flag_status THEN NULL ELSE now() END
     )
     RETURNING id`,
    [input.userId, input.flagType ?? 'phase15-test-flag', input.severity, status],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('fraud_flag insert failed');
  return id;
}

export async function grantFounderMembership(
  pool: Pool,
  userId: string,
): Promise<string> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO user_memberships (
       user_id, membership_plan_id, status, source, claimed_at, founder_number
     ) VALUES (
       $1::uuid, $2::uuid, 'ACTIVE'::membership_status, 'OWNER_GRANT', now(),
       nextval('founder_number_seq')
     )
     RETURNING id`,
    [userId, planId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('founder membership insert failed');
  return id;
}

/** TEST-ONLY: bind a synthetic ACTIVE REFERRAL_RATE_BOOST FINANCIAL BPS rule. */
export async function seedReferralRateBoost(
  pool: Pool,
  input: {
    readonly valueBps: number;
    readonly assetId?: string | null;
    readonly ruleVersion?: number;
    readonly planCode?: string;
  },
): Promise<{ ruleVersionId: string; planId: string; entitlementId: string }> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = $1`,
    [input.planCode ?? 'FOUNDER_LIFETIME'],
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('membership plan missing');
  const ent = await pool.query<{ id: string }>(
    `SELECT id FROM entitlements WHERE code = 'REFERRAL_RATE_BOOST'`,
  );
  const entitlementId = ent.rows[0]?.id;
  if (entitlementId === undefined) throw new Error('REFERRAL_RATE_BOOST entitlement missing');

  const version = await pool.query<{ id: string }>(
    `INSERT INTO membership_benefit_rule_versions (
       entitlement_id, membership_plan_id, rule_version, value_bps, asset_id,
       status, effective_from, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::uuid,
       'ACTIVE', now(), 'PHASE15 TEST synthetic referral rate profile'
     )
     RETURNING id`,
    [
      entitlementId,
      planId,
      input.ruleVersion ?? 1,
      input.valueBps,
      input.assetId ?? null,
    ],
  );
  const ruleVersionId = version.rows[0]?.id;
  if (ruleVersionId === undefined) throw new Error('benefit rule insert failed');

  await pool.query(
    `INSERT INTO membership_plan_entitlements (
       membership_plan_id, entitlement_id, rule_version_id, valid_from, status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
    [planId, entitlementId, ruleVersionId],
  );
  return { ruleVersionId, planId, entitlementId };
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
