/**
 * Phase 20 Step 2 — Admin notification draft/no-send proofs (disposable DB).
 * Gate: PHASE20_DATABASE_URL, or PHASE20_STEP2_REQUIRE_DB_GATES=1 (required),
 * or PHASE20_NOTIFICATIONS_TESTS=1 + DATABASE_URL.
 *
 * Does NOT implement delivery. Proves draft metadata only + no ledger/send side effects.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import type { VerifiedAdminSession } from '@alex-rewards/auth';
import { UnauthorizedException } from '@nestjs/common';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NotificationsAdminController } from '../src/admin/notifications-admin.controller.js';
import { AdminSessionGuard } from '../src/admin-auth/admin-session.guard.js';

function resolvePhase20DatabaseUrl(): string {
  const explicit = process.env.PHASE20_DATABASE_URL ?? '';
  if (explicit !== '') return explicit;
  if (process.env.PHASE20_STEP2_REQUIRE_DB_GATES === '1') {
    throw new Error(
      'PHASE20_STEP2_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL (disposable *_test DB)',
    );
  }
  if (process.env.PHASE20_NOTIFICATIONS_TESTS === '1') {
    return process.env.DATABASE_URL ?? '';
  }
  return '';
}

const dbUrl = resolvePhase20DatabaseUrl();
const BEARER = 'phase20-notifications-admin-test';

const apiConfig = {
  DEPLOYMENT_ENV: 'local',
  CORS_ORIGINS: ['http://localhost:3001'],
  ADMIN_WEBAUTHN_ORIGIN: 'http://localhost:3001',
} as never;

function bearerRequest(token = BEARER): { headers: { authorization: string } } {
  return { headers: { authorization: `Bearer ${token}` } };
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

describe.skipIf(dbUrl === '')('Phase 20 notifications admin draft/no-send (DB)', () => {
  let pool!: Pool;
  let controller!: NotificationsAdminController;
  let session!: VerifiedAdminSession;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    controller = new NotificationsAdminController(pool, apiConfig);

    const admin = await pool.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, 'Phase20 Notifications Admin', 'ACTIVE')
       RETURNING id`,
      [`phase20-notif-${randomUUID()}@example.invalid`],
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
    const tokenHash = createHash('sha256').update(BEARER, 'utf8').digest('hex');
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
      email: 'phase20-notif@example.invalid',
      displayName: 'Phase20 Notifications Admin',
      sessionId,
      reauthenticatedAt: new Date().toISOString(),
      idleExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      absoluteExpiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
      roles: ['OWNER'],
    };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('list starts EMPTY then READY after MARKETING draft (DRAFT only)', async () => {
    const empty = await controller.list();
    expect(empty.status).toBe('EMPTY');
    expect(empty.items).toEqual([]);

    const created = await controller.createDraft(bearerRequest() as never, session, {
      code: `p20_draft_${randomUUID().slice(0, 8)}`,
      title: 'Phase20 draft only',
      category: 'MARKETING',
      reason: 'phase20-step2-draft-nosend-proof',
      expectedVersion: '1',
    });

    expect(created.status).toBe('DRAFT');
    expect(created.note).toMatch(/draft metadata only/i);
    expect(created.note.toLowerCase()).toMatch(/no send|no dispatch/);

    const row = await pool.query<{ status: string; category: string }>(
      `SELECT status::text AS status, category::text AS category
       FROM notification_campaigns WHERE id = $1::uuid`,
      [created.campaign!.id],
    );
    expect(row.rows[0]?.status).toBe('DRAFT');
    expect(row.rows[0]?.category).toBe('MARKETING');

    const listed = await controller.list();
    expect(listed.status).toBe('READY');
    expect(listed.items.some((i) => i.id === created.campaign!.id)).toBe(true);
  });

  it('creates no delivery / notification / ledger / reward side effects', async () => {
    const beforeDeliveries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notification_deliveries`,
    );
    const beforeNotifications = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notifications`,
    );
    const beforeLedger = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    const beforeRewards = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM reward_events`,
    );

    await controller.createDraft(bearerRequest() as never, session, {
      code: `p20_side_${randomUUID().slice(0, 8)}`,
      title: 'Phase20 side-effect check',
      category: 'SYSTEM',
      reason: 'phase20-step2-no-side-effects',
      expectedVersion: '1',
    });

    const afterDeliveries = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notification_deliveries`,
    );
    const afterNotifications = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notifications`,
    );
    const afterLedger = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_entries`,
    );
    const afterRewards = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM reward_events`,
    );

    expect(afterDeliveries.rows[0]!.c).toBe(beforeDeliveries.rows[0]!.c);
    expect(afterNotifications.rows[0]!.c).toBe(beforeNotifications.rows[0]!.c);
    expect(afterLedger.rows[0]!.c).toBe(beforeLedger.rows[0]!.c);
    expect(afterRewards.rows[0]!.c).toBe(beforeRewards.rows[0]!.c);
  });

  it('refuses SECURITY category at application layer', async () => {
    await expect(
      controller.createDraft(bearerRequest() as never, session, {
        code: `p20_sec_${randomUUID().slice(0, 8)}`,
        title: 'forbidden',
        category: 'SECURITY',
        reason: 'phase20-step2-security-refuse',
        expectedVersion: '1',
      }),
    ).rejects.toThrow();

    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notification_campaigns WHERE category = 'SECURITY'`,
    );
    expect(count.rows[0]!.c).toBe(0);
  });

  it('refuses draft without recent reauth (gateHighImpactMutation)', async () => {
    const stale: VerifiedAdminSession = {
      ...session,
      reauthenticatedAt: new Date(Date.now() - 86_400_000).toISOString(),
    };

    await expect(
      controller.createDraft(bearerRequest() as never, stale, {
        code: `p20_reauth_${randomUUID().slice(0, 8)}`,
        title: 'stale reauth',
        category: 'TRANSACTIONAL',
        reason: 'phase20-step2-reauth',
        expectedVersion: '1',
      }),
    ).rejects.toThrow();
  });

  it('AdminSessionGuard refuses missing Authorization (401)', async () => {
    const guard = new AdminSessionGuard(pool);
    await expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({ headers: {}, cookies: {} }),
        }),
      } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    try {
      await guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({ headers: {}, cookies: {} }),
        }),
      } as never);
      expect.fail('expected UnauthorizedException');
    } catch (error) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).getStatus()).toBe(401);
    }
  });

  it('controller remains decorated with AdminSessionGuard (source contract)', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/admin/notifications-admin.controller.ts'),
      'utf8',
    );
    expect(src).toMatch(/@UseGuards\(\s*AdminSessionGuard\s*\)/);
    expect(src).not.toMatch(/@(Post|Get)\([^)]*(send|dispatch|broadcast)/i);
  });
});