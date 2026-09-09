import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  ALL_CONTROL_CENTER_PERMISSION_CODES,
  CONTROL_CENTER_DESTINATION_PURPOSES,
} from '../src/index.js';
import {
  createOwnerAdmin,
  createPool,
  phase8DatabaseUrl,
  resetAndMigrate,
  seedAllControlCenterDestinations,
} from './harness.js';

const describePhase8 = phase8DatabaseUrl === '' ? describe.skip : describe;

describePhase8('phase8 migration 0019 integrity', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(phase8DatabaseUrl);
    pool = createPool(phase8DatabaseUrl);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  it('records migration 0019', async () => {
    const result = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '0019_control_center_security_integrity'`,
    );
    expect(result.rowCount).toBe(1);
  });

  it('supports Audit and System destination purposes', async () => {
    const dests = await seedAllControlCenterDestinations(pool);
    expect(Object.keys(dests).sort()).toEqual([...CONTROL_CENTER_DESTINATION_PURPOSES].sort());
    expect(dests.CONTROL_CENTER_AUDIT).toBeTruthy();
    expect(dests.CONTROL_CENTER_SYSTEM).toBeTruthy();
    expect(dests.CONTROL_CENTER_DAILY_REPORT).toBeTruthy();
  });

  it('requires action-token destination/chat/nonce bindings', async () => {
    const { adminUserId } = await createOwnerAdmin(pool, '900101');
    const dests = await seedAllControlCenterDestinations(pool, { chatId: '-1009001' });
    await expect(
      pool.query(
        `INSERT INTO admin_action_tokens (
           admin_user_id, action_type, resource_type, token_hash, source, expires_at
         ) VALUES ($1::uuid, 'x', 'y', $2, 'TELEGRAM', now() + interval '1 hour')`,
        [adminUserId, `missing-bindings-${Date.now()}`],
      ),
    ).rejects.toThrow();

    const ok = await pool.query(
      `INSERT INTO admin_action_tokens (
         admin_user_id, action_type, resource_type, token_hash, source, expires_at,
         destination_id, bound_chat_id, bound_topic_thread_id, nonce, expected_state
       ) VALUES (
         $1::uuid, 'withdrawal.decide.APPROVE', 'withdrawal', $2, 'TELEGRAM',
         now() + interval '1 hour', $3::uuid, -1009001, 1, $4, 'MANUAL_REVIEW'
       )
       RETURNING id`,
      [adminUserId, `hash-${Date.now()}`, dests.CONTROL_CENTER_APPROVALS, `nonce-${Date.now()}`],
    );
    expect(ok.rowCount).toBe(1);
  });

  it('seeds OWNER Phase 8 permissions', async () => {
    const result = await pool.query<{ code: string }>(
      `SELECT p.code
       FROM admin_permissions p
       INNER JOIN admin_role_permissions rp ON rp.permission_id = p.id
       INNER JOIN admin_roles r ON r.id = rp.role_id
       WHERE r.code = 'OWNER'
       ORDER BY p.code`,
    );
    const codes = result.rows.map((row) => row.code);
    for (const code of ALL_CONTROL_CENTER_PERMISSION_CODES) {
      expect(codes).toContain(code);
    }
  });
});
