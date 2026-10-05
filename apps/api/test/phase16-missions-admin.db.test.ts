/**
 * Phase 16 — Missions Admin create → activate (DB) + confirmation + activation lock races.
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
import {
  createRewardRuleVersion,
  withLedgerTransaction,
} from '@alex-rewards/rewards';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MissionsAdminController } from '../src/admin/missions-admin.controller.js';

const explicitUrl = process.env.PHASE16_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE16_MISSION_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const phase16DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const apiConfig = {
  DEPLOYMENT_ENV: 'local',
  CORS_ORIGINS: ['http://localhost:3001'],
  ADMIN_WEBAUTHN_ORIGIN: 'http://localhost:3001',
} as never;

function bearerRequest(): { headers: { authorization: string } } {
  return { headers: { authorization: 'Bearer phase16-missions-admin-test' } };
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

async function holderPid(client: PoolClient): Promise<number> {
  return (await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
}

async function waitForBlockedOnHolder(
  watcher: PoolClient,
  holderPidValue: number,
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
      [holderPidValue],
    );
    if ((waiting.rows[0]?.c ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

describe.skipIf(phase16DatabaseUrl === '')('Phase 16 missions-admin (DB)', () => {
  let pool!: Pool;
  let controller: MissionsAdminController;
  let session: VerifiedAdminSession;
  let assetId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase16DatabaseUrl);
    pool = new Pool({ connectionString: phase16DatabaseUrl, max: 8 });
    controller = new MissionsAdminController(pool, apiConfig);

    const admin = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Phase16 Missions Admin', 'ACTIVE')
       RETURNING id`,
      [`phase16-missions-${randomUUID()}@example.invalid`],
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
    const tokenHash = createHash('sha256').update('phase16-missions-admin-test').digest('hex');
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
      email: 'phase16-missions-admin@example.invalid',
      displayName: 'Phase16 Missions Admin',
      sessionId,
      reauthenticatedAt: new Date().toISOString(),
      idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      roles: ['OWNER'],
    };

    const asset = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
    assetId = asset.rows[0]!.id;
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function createDraftMissionVersion(): Promise<{
    definitionId: string;
    versionId: string;
    missionVersion: number;
    rewardRuleId: string;
  }> {
    const rule = await withLedgerTransaction(pool, async (client) =>
      createRewardRuleVersion(client, {
        code: `P16ADM_${randomUUID().slice(0, 8)}`,
        sourceType: 'MISSION',
        assetId,
        fixedRewardAtomic: '1000',
        pendingHoldSeconds: 0,
        quoteTtlSeconds: 0,
        validFrom: new Date(Date.now() - 30 * 86_400_000),
        activate: true,
        referralEligible: false,
        reason: 'phase16-missions-admin',
      }),
    );

    const def = await controller.createDefinition(bearerRequest() as never, session, {
      code: `P16_${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
      nameKey: 'mission.admin.test',
      reason: 'phase16 admin e2e',
    });
    const version = await controller.createVersion(bearerRequest() as never, session, {
      missionDefinitionId: def.id,
      conditionType: 'DAILY_LOGIN',
      target: 1,
      resetPolicy: 'NONE',
      nameKey: 'mission.admin.test.v1',
      rewardRuleId: rule.id,
      startAt: new Date(Date.now() - 86_400_000).toISOString(),
      reason: 'phase16 admin e2e version',
    });
    return {
      definitionId: def.id,
      versionId: version.id,
      missionVersion: version.missionVersion,
      rewardRuleId: rule.id,
    };
  }

  async function consumeActivateConfirmation(input: {
    readonly versionId: string;
    readonly missionVersion: number;
    readonly startAtIso: string | null;
    readonly reason: string;
  }): Promise<string> {
    const payload = {
      versionId: input.versionId,
      reason: input.reason,
      startAt: input.startAtIso,
    };
    const prepared = await prepareAdminWebConfirmation(pool, {
      session,
      actionType: 'missions.version_activate',
      resourceType: 'mission_version',
      resourceId: input.versionId,
      expectedVersion: String(input.missionVersion),
      payload,
    });
    await confirmAdminWebConfirmation(pool, {
      session,
      confirmationId: prepared.confirmationId,
      confirmationPhrase: prepared.confirmationPhrase,
    });
    return prepared.confirmationId;
  }

  it('create definition → DRAFT version → activate E2E with consumed confirmation', async () => {
    const draft = await createDraftMissionVersion();
    const startRow = await pool.query<{ start_at: Date }>(
      `SELECT start_at FROM mission_versions WHERE id = $1::uuid`,
      [draft.versionId],
    );
    const startAtIso = startRow.rows[0]!.start_at.toISOString();
    expect(startAtIso).toBeTruthy();

    const draftStatus = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM mission_versions WHERE id = $1::uuid`,
      [draft.versionId],
    );
    expect(draftStatus.rows[0]?.status).toBe('DRAFT');

    const activateReason = 'phase16 activate e2e';
    const confirmationId = await consumeActivateConfirmation({
      versionId: draft.versionId,
      missionVersion: draft.missionVersion,
      startAtIso,
      reason: activateReason,
    });

    const activated = await controller.activateVersion(
      bearerRequest() as never,
      session,
      draft.versionId,
      {
        reason: activateReason,
        expectedVersion: String(draft.missionVersion),
        confirmationId,
      },
    );
    expect(activated.status).toBe('ACTIVE');

    const row = await pool.query<{ status: string; def_status: string; start_at: Date }>(
      `SELECT mv.status::text AS status, md.status::text AS def_status, mv.start_at
       FROM mission_versions mv
       JOIN mission_definitions md ON md.id = mv.mission_definition_id
       WHERE mv.id = $1::uuid`,
      [draft.versionId],
    );
    expect(row.rows[0]?.status).toBe('ACTIVE');
    expect(row.rows[0]?.def_status).toBe('ACTIVE');
    expect(row.rows[0]!.start_at.toISOString()).toBe(startAtIso);

    const audits = await pool.query<{ action_type: string }>(
      `SELECT action_type
       FROM audit_logs
       WHERE resource_id = $1
         AND action_type IN ('missions.version_create', 'missions.version_activate')
       ORDER BY created_at ASC`,
      [draft.versionId],
    );
    expect(audits.rows.map((r) => r.action_type)).toEqual([
      'missions.version_create',
      'missions.version_activate',
    ]);
  });

  it('activate rejects stale expectedVersion snapshot (VERSION_CONFLICT)', async () => {
    const draft = await createDraftMissionVersion();
    const startRow = await pool.query<{ start_at: Date }>(
      `SELECT start_at FROM mission_versions WHERE id = $1::uuid`,
      [draft.versionId],
    );
    const staleReason = 'phase16 stale snapshot';
    const confirmationId = await consumeActivateConfirmation({
      versionId: draft.versionId,
      missionVersion: draft.missionVersion,
      startAtIso: startRow.rows[0]?.start_at?.toISOString() ?? null,
      reason: staleReason,
    });

    try {
      await controller.activateVersion(bearerRequest() as never, session, draft.versionId, {
        reason: staleReason,
        expectedVersion: String(draft.missionVersion + 1),
        confirmationId,
      });
      throw new Error('expected VERSION_CONFLICT');
    } catch (error) {
      const response =
        typeof error === 'object' &&
        error !== null &&
        'getResponse' in error &&
        typeof (error as { getResponse: () => unknown }).getResponse === 'function'
          ? (error as { getResponse: () => { error?: string } }).getResponse()
          : null;
      expect(response?.error).toBe('VERSION_CONFLICT');
    }
  });

  it('stale-lifecycle race: concurrent non-DRAFT commit fails activation without audit', async () => {
    const draft = await createDraftMissionVersion();
    const startRow = await pool.query<{ start_at: Date }>(
      `SELECT start_at FROM mission_versions WHERE id = $1::uuid`,
      [draft.versionId],
    );
    const raceReason = 'phase16 stale lifecycle race';
    const confirmationId = await consumeActivateConfirmation({
      versionId: draft.versionId,
      missionVersion: draft.missionVersion,
      startAtIso: startRow.rows[0]?.start_at?.toISOString() ?? null,
      reason: raceReason,
    });

    const mutator = await pool.connect();
    try {
      await mutator.query('BEGIN');
      await mutator.query(
        `SELECT id FROM mission_versions WHERE id = $1::uuid FOR UPDATE`,
        [draft.versionId],
      );
      await mutator.query(
        `UPDATE mission_versions
         SET status = 'REVOKED'::rule_version_status, updated_at = now()
         WHERE id = $1::uuid AND status = 'DRAFT'::rule_version_status`,
        [draft.versionId],
      );
      await mutator.query('COMMIT');
    } finally {
      mutator.release();
    }

    try {
      await controller.activateVersion(bearerRequest() as never, session, draft.versionId, {
        reason: raceReason,
        expectedVersion: String(draft.missionVersion),
        confirmationId,
      });
      throw new Error('expected VERSION_CONFLICT');
    } catch (error) {
      const response =
        typeof error === 'object' &&
        error !== null &&
        'getResponse' in error &&
        typeof (error as { getResponse: () => unknown }).getResponse === 'function'
          ? (error as { getResponse: () => { error?: string } }).getResponse()
          : null;
      expect(response?.error).toBe('VERSION_CONFLICT');
    }

    const status = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM mission_versions WHERE id = $1::uuid`,
      [draft.versionId],
    );
    expect(status.rows[0]?.status).toBe('REVOKED');

    const activateAudits = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM audit_logs
       WHERE resource_id = $1 AND action_type = 'missions.version_activate'`,
      [draft.versionId],
    );
    expect(activateAudits.rows[0]?.c).toBe(0);
  });

  it('activation-first FOR UPDATE on target DRAFT blocks concurrent lifecycle UPDATE', async () => {
    const draft = await createDraftMissionVersion();
    const startRow = await pool.query<{ start_at: Date }>(
      `SELECT start_at FROM mission_versions WHERE id = $1::uuid`,
      [draft.versionId],
    );
    const concurrentReason = 'phase16 concurrent activate target';
    const confirmationId = await consumeActivateConfirmation({
      versionId: draft.versionId,
      missionVersion: draft.missionVersion,
      startAtIso: startRow.rows[0]?.start_at?.toISOString() ?? null,
      reason: concurrentReason,
    });

    const holder = await pool.connect();
    const waiter = await pool.connect();
    const watcher = await pool.connect();
    try {
      await holder.query('BEGIN');
      // Hold target DRAFT row the same way activation will after definition lock.
      await holder.query(
        `SELECT id FROM mission_versions WHERE id = $1::uuid FOR UPDATE`,
        [draft.versionId],
      );
      const hPid = await holderPid(holder);

      const activatePromise = controller.activateVersion(
        bearerRequest() as never,
        session,
        draft.versionId,
        {
          reason: concurrentReason,
          expectedVersion: String(draft.missionVersion),
          confirmationId,
        },
      );

      expect(await waitForBlockedOnHolder(watcher, hPid, 8_000)).toBe(true);
      const mid = await pool.query<{ status: string }>(
        `SELECT status::text AS status FROM mission_versions WHERE id = $1::uuid`,
        [draft.versionId],
      );
      expect(mid.rows[0]?.status).toBe('DRAFT');

      await holder.query('ROLLBACK');
      const activated = await activatePromise;
      expect(activated.status).toBe('ACTIVE');

      // After activation owns ACTIVE target, a concurrent lifecycle UPDATE must block
      // while activation-equivalent FOR UPDATE is held.
      await holder.query('BEGIN');
      await holder.query(
        `SELECT id FROM mission_versions WHERE id = $1::uuid FOR UPDATE`,
        [draft.versionId],
      );
      const hPid2 = await holderPid(holder);
      const updatePromise = waiter.query(
        `UPDATE mission_versions
         SET updated_at = now()
         WHERE id = $1::uuid`,
        [draft.versionId],
      );
      expect(await waitForBlockedOnHolder(watcher, hPid2, 8_000)).toBe(true);
      await holder.query('COMMIT');
      await updatePromise;

      const finalStatus = await pool.query<{ status: string }>(
        `SELECT status::text AS status FROM mission_versions WHERE id = $1::uuid`,
        [draft.versionId],
      );
      expect(finalStatus.rows[0]?.status).toBe('ACTIVE');
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // ignore
      }
      holder.release();
      waiter.release();
      watcher.release();
    }
  }, 30_000);
});
