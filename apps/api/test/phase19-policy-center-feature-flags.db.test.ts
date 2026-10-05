/**
 * P19-SEC-009 — Policy Center FEATURE_FLAGS must not mutate flags (DB).
 * Dedicated FeatureFlagsController.mutate remains the sole web mutation path.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  confirmAdminWebConfirmation,
  prepareAdminWebConfirmation,
  type VerifiedAdminSession,
} from '@alex-rewards/auth';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FeatureFlagsController } from '../src/admin/feature-flags.controller.js';
import { PolicyCenterController } from '../src/admin/policy-center.controller.js';

const dbUrl =
  process.env.PHASE19_SECURITY_DATABASE_URL ??
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  (process.env.PHASE19_POLICY_CENTER_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '');

const BEARER = 'phase19-policy-center-admin-test';
const FLAG_KEY = 'PHASE19_TEST_FLAG';

const apiConfig = {
  DEPLOYMENT_ENV: 'local',
  CORS_ORIGINS: ['http://localhost:3001'],
  ADMIN_WEBAUTHN_ORIGIN: 'http://localhost:3001',
} as never;

function bearerRequest(): { headers: { authorization: string } } {
  return { headers: { authorization: `Bearer ${BEARER}` } };
}

async function resetAndMigrate(url: string): Promise<void> {
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

describe.skipIf(dbUrl === '')('P19-SEC-009 policy center FEATURE_FLAGS (DB)', () => {
  let pool!: Pool;
  let policy: PolicyCenterController;
  let flags: FeatureFlagsController;
  let session: VerifiedAdminSession;
  let flagId!: string;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = new Pool({ connectionString: dbUrl, max: 8 });
    policy = new PolicyCenterController(pool, apiConfig);
    flags = new FeatureFlagsController(pool, apiConfig);

    const admin = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Phase19 Policy Center Admin', 'ACTIVE')
       RETURNING id`,
      [`phase19-policy-${randomUUID()}@example.invalid`],
    );
    const adminUserId = admin.rows[0]!.id;
    const role = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [adminUserId, role.rows[0]!.id],
    );

    const sessionId = randomUUID();
    const tokenHash = createHash('sha256').update(BEARER).digest('hex');
    await pool.query(
      `INSERT INTO admin_sessions (
         id, admin_user_id, session_token_hash, idle_expires_at, absolute_expires_at,
         reauthenticated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, now() + interval '1 hour', now() + interval '8 hours',
         now()
       )`,
      [sessionId, adminUserId, tokenHash],
    );

    session = {
      adminUserId,
      email: 'phase19-policy@example.invalid',
      displayName: 'Phase19 Policy Center Admin',
      sessionId,
      reauthenticatedAt: new Date().toISOString(),
      idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      roles: ['OWNER'],
    };

    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ($1, 'LOCAL', false, 'P19-SEC-009 disposable LOCAL test flag')
       RETURNING id`,
      [FLAG_KEY],
    );
    flagId = inserted.rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function prepareConfirm(input: {
    readonly actionType: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly expectedVersion: string;
    readonly payload: unknown;
  }): Promise<string> {
    const prepared = await prepareAdminWebConfirmation(pool, {
      session,
      actionType: input.actionType,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      expectedVersion: input.expectedVersion,
      payload: input.payload,
    });
    await confirmAdminWebConfirmation(pool, {
      session,
      confirmationId: prepared.confirmationId,
      confirmationPhrase: prepared.confirmationPhrase,
    });
    return prepared.confirmationId;
  }

  it('policy FEATURE_FLAGS returns applied=false and does not mutate flag', async () => {
    const versionsBefore = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM feature_flag_versions WHERE feature_flag_id = $1::uuid`,
      [flagId],
    );
    const enabledBefore = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags WHERE id = $1::uuid`,
      [flagId],
    );
    expect(enabledBefore.rows[0]!.enabled).toBe(false);

    const reason = 'phase19 policy FEATURE_FLAGS must not apply';
    const expectedVersion = '0';
    const typed = {
      flagKey: FLAG_KEY,
      environment: 'LOCAL',
      enabled: true,
    };
    const confirmationId = await prepareConfirm({
      actionType: 'policy.FEATURE_FLAGS',
      resourceType: 'policy_family',
      resourceId: 'FEATURE_FLAGS',
      expectedVersion,
      payload: { family: 'FEATURE_FLAGS', reason, typed },
    });

    const result = await policy.typedChange(bearerRequest() as never, session, {
      family: 'FEATURE_FLAGS',
      reason,
      expectedVersion,
      confirmationId,
      typed,
    });

    expect(result.applied).toBe(false);
    expect(result.family).toBe('FEATURE_FLAGS');
    expect(String(result.note ?? '')).toMatch(/dedicated/i);

    const enabledAfter = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags WHERE id = $1::uuid`,
      [flagId],
    );
    expect(enabledAfter.rows[0]!.enabled).toBe(false);

    const versionsAfter = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM feature_flag_versions WHERE feature_flag_id = $1::uuid`,
      [flagId],
    );
    expect(versionsAfter.rows[0]!.c).toBe(versionsBefore.rows[0]!.c);

    const mutateAudits = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM audit_logs WHERE action_type = 'feature_flags.mutate'`,
    );
    expect(mutateAudits.rows[0]!.c).toBe(0);
  });

  it('dedicated FeatureFlagsController.mutate still flips the LOCAL test flag', async () => {
    const reason = 'phase19 dedicated feature flag mutate';
    const expectedVersion = '0';
    const confirmationId = await prepareConfirm({
      actionType: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: `${FLAG_KEY}:LOCAL`,
      expectedVersion,
      payload: {
        flagKey: FLAG_KEY,
        environment: 'LOCAL',
        enabled: true,
        reason,
      },
    });

    const result = await flags.mutate(bearerRequest() as never, session, {
      flagKey: FLAG_KEY,
      environment: 'LOCAL',
      enabled: true,
      reason,
      expectedVersion,
      confirmationId,
    });

    expect(result.enabled).toBe(true);
    expect(result.version).toBe(1);

    const enabled = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags WHERE id = $1::uuid`,
      [flagId],
    );
    expect(enabled.rows[0]!.enabled).toBe(true);

    const versions = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM feature_flag_versions WHERE feature_flag_id = $1::uuid`,
      [flagId],
    );
    expect(versions.rows[0]!.c).toBe(1);

    const mutateAudits = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM audit_logs WHERE action_type = 'feature_flags.mutate'`,
    );
    expect(mutateAudits.rows[0]!.c).toBeGreaterThan(0);
  });
});
