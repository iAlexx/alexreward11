/**
 * Phase 16 mission test helpers.
 * Destructive against PHASE16_DATABASE_URL (or PHASE16_MISSION_TESTS=1 + DATABASE_URL).
 */
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool, type PoolClient } from 'pg';

const explicitUrl = process.env.PHASE16_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE16_MISSION_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase16DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export function createPool(url: string): Pool {
  return new Pool({ connectionString: url });
}

export async function withClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
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
): Promise<string> {
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

export async function insertMissionDefinition(
  pool: Pool,
  input: {
    readonly code: string;
    readonly nameKey?: string;
    readonly status?: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO mission_definitions (code, name_key, status)
     VALUES ($1, $2, $3::content_status)
     RETURNING id`,
    [input.code, input.nameKey ?? `mission.${input.code}`, input.status ?? 'ACTIVE'],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('mission definition insert failed');
  return id;
}

export async function insertMissionVersion(
  pool: Pool,
  input: {
    readonly missionDefinitionId: string;
    readonly missionVersion: number;
    readonly status: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly startAt?: Date | null;
    readonly endAt?: Date | null;
    readonly target?: number;
    readonly conditionType?: string;
    readonly resetPolicy?: string;
    readonly nameKey?: string;
    readonly rewardSourceType?: string;
    readonly rewardRuleId?: string | null;
    readonly eligibilityPolicy?: unknown;
    readonly requiredMembershipPlanId?: string | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO mission_versions (
       mission_definition_id, mission_version, name_key, condition_type, target,
       reset_policy, status, start_at, end_at, reward_source_type, reward_rule_id,
       eligibility_policy, required_membership_plan_id
     ) VALUES (
       $1::uuid, $2, $3, $4::mission_condition_type, $5,
       $6::mission_reset_policy, $7::rule_version_status,
       $8::timestamptz, $9::timestamptz,
       $10::reward_source_type, $11::uuid,
       $12::jsonb, $13::uuid
     )
     RETURNING id`,
    [
      input.missionDefinitionId,
      input.missionVersion,
      input.nameKey ?? 'mission.test.name',
      input.conditionType ?? 'DAILY_LOGIN',
      input.target ?? 1,
      input.resetPolicy ?? 'NONE',
      input.status,
      input.startAt === undefined ? null : input.startAt === null ? null : input.startAt.toISOString(),
      input.endAt === undefined ? null : input.endAt === null ? null : input.endAt.toISOString(),
      input.rewardSourceType ?? 'MISSION',
      input.rewardRuleId ?? null,
      JSON.stringify(input.eligibilityPolicy ?? {}),
      input.requiredMembershipPlanId ?? null,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('mission version insert failed');
  return id;
}

export async function insertMissionProgress(
  pool: Pool,
  input: {
    readonly missionVersionId: string;
    readonly userId: string;
    readonly periodKey?: string;
    readonly target: number;
    readonly progressCount?: number;
    readonly state?: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CLAIMED' | 'EXPIRED';
    readonly startedAt?: Date | null;
    readonly completedAt?: Date | null;
  },
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO mission_progress (
       mission_version_id, user_id, period_key, progress_count, target, state,
       started_at, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6::task_progress_state,
       $7::timestamptz, $8::timestamptz
     )
     RETURNING id`,
    [
      input.missionVersionId,
      input.userId,
      input.periodKey ?? 'LIFETIME',
      input.progressCount ?? 0,
      input.target,
      input.state ?? 'NOT_STARTED',
      input.startedAt === undefined || input.startedAt === null
        ? null
        : input.startedAt.toISOString(),
      input.completedAt === undefined || input.completedAt === null
        ? null
        : input.completedAt.toISOString(),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('mission progress insert failed');
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

/** Explicit TEST-ONLY Eligibility policy — not a production seed. */
export const TEST_MISSION_CLAIM_ELIGIBILITY_POLICY = {
  actions: {
    MISSION_CLAIM: {
      requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG', 'MEMBERSHIP', 'COUNTRY_POLICY'],
      precedence: ['ACCOUNT_STATE', 'MEMBERSHIP', 'COUNTRY_POLICY', 'FEATURE_FLAG'],
    },
    WITHDRAWAL_REQUEST: {
      requiredGates: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
      precedence: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
    },
    AD_SESSION_START: {
      requiredGates: ['ACCOUNT_STATE'],
      precedence: ['ACCOUNT_STATE'],
    },
    TASK_CLAIM: {
      requiredGates: ['ACCOUNT_STATE'],
      precedence: ['ACCOUNT_STATE'],
    },
  },
} as const;

export async function insertEligibilityPolicy(
  pool: Pool,
  input: {
    readonly policyVersion: number;
    readonly status?: 'DRAFT' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
    readonly effectiveFrom?: Date;
    readonly policyConfig?: unknown;
  },
): Promise<string> {
  await pool.query(
    `UPDATE eligibility_policy_versions
     SET status = 'SUPERSEDED'::rule_version_status
     WHERE status = 'ACTIVE'`,
  );
  const result = await pool.query<{ id: string }>(
    `INSERT INTO eligibility_policy_versions (
       policy_version, status, effective_from, reason, policy_config
     ) VALUES (
       $1, $2::rule_version_status, $3::timestamptz, $4, $5::jsonb
     )
     RETURNING id`,
    [
      input.policyVersion,
      input.status ?? 'ACTIVE',
      (input.effectiveFrom ?? new Date('2020-01-01T00:00:00.000Z')).toISOString(),
      'phase16-mission-claim-test-only',
      JSON.stringify(input.policyConfig ?? TEST_MISSION_CLAIM_ELIGIBILITY_POLICY),
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('eligibility policy insert failed');
  return id;
}

export async function getFounderPlanId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  return id;
}

export async function grantFounderMembership(pool: Pool, userId: string): Promise<string> {
  const planId = await getFounderPlanId(pool);
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

/** TEST-ONLY: bind ACTIVE EXCLUSIVE_MISSION_ACCESS BOOLEAN entitlement to a plan. */
export async function seedExclusiveMissionAccess(
  pool: Pool,
  input?: { readonly planCode?: string; readonly ruleVersion?: number },
): Promise<{ ruleVersionId: string; planId: string; entitlementId: string }> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = $1`,
    [input?.planCode ?? 'FOUNDER_LIFETIME'],
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('membership plan missing');
  const ent = await pool.query<{ id: string }>(
    `SELECT id FROM entitlements WHERE code = 'EXCLUSIVE_MISSION_ACCESS'`,
  );
  const entitlementId = ent.rows[0]?.id;
  if (entitlementId === undefined) throw new Error('EXCLUSIVE_MISSION_ACCESS entitlement missing');

  const version = await pool.query<{ id: string }>(
    `INSERT INTO membership_benefit_rule_versions (
       entitlement_id, membership_plan_id, rule_version, value_boolean,
       status, effective_from, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3, TRUE,
       'ACTIVE', now(), 'PHASE16 TEST exclusive mission access'
     )
     RETURNING id`,
    [entitlementId, planId, input?.ruleVersion ?? 1],
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

export async function insertMissionRewardRule(
  pool: Pool,
  input?: { readonly amountAtomic?: string; readonly pendingHoldSeconds?: number },
): Promise<string> {
  const asset = await pool.query<{ id: string }>(
    `SELECT id FROM assets ORDER BY created_at ASC LIMIT 1`,
  );
  const assetId = asset.rows[0]?.id;
  if (assetId === undefined) throw new Error('seed asset missing');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO reward_rules (
       code, source_type, asset_id, status, fixed_reward_atomic, pending_hold_seconds,
       rule_version, valid_from, referral_eligible
     ) VALUES (
       $1, 'MISSION'::reward_source_type, $2::uuid, 'ACTIVE', $3::bigint, $4,
       1, now(), false
     )
     RETURNING id`,
    [
      `mission-test-rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      assetId,
      input?.amountAtomic ?? '1000',
      input?.pendingHoldSeconds ?? 0,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('reward rule insert failed');
  return id;
}

export async function insertAvailableAdReward(
  pool: Pool,
  input: { readonly userId: string; readonly sourceId?: string; readonly amountAtomic?: string },
): Promise<string> {
  const asset = await pool.query<{ id: string }>(
    `SELECT id FROM assets ORDER BY created_at ASC LIMIT 1`,
  );
  const assetId = asset.rows[0]?.id;
  if (assetId === undefined) throw new Error('seed asset missing');
  const sourceId =
    input.sourceId ??
    crypto.randomUUID();
  const result = await pool.query<{ id: string }>(
    `INSERT INTO reward_events (
       user_id, source_type, source_id, asset_id, amount_atomic, state, available_at
     ) VALUES (
       $1::uuid, 'AD'::reward_source_type, $2::uuid, $3::uuid, $4::bigint,
       'AVAILABLE'::reward_event_state, now()
     )
     RETURNING id`,
    [input.userId, sourceId, assetId, input.amountAtomic ?? '100'],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('ad reward insert failed');
  return id;
}

export async function reverseAdReward(pool: Pool, rewardEventId: string): Promise<void> {
  await pool.query(
    `UPDATE reward_events
     SET state = 'REVERSED'::reward_event_state, reversed_at = now()
     WHERE id = $1::uuid`,
    [rewardEventId],
  );
}

