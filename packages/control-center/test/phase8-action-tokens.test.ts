import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  ControlCenterError,
  authorizeOwnerAction,
  consumeAdminActionToken,
  hashActionToken,
  issueAdminActionToken,
  localControlCenterFixtureConfig,
} from '../src/index.js';
import { CONTROL_CENTER_PERMISSIONS } from '../src/permissions.js';
import {
  APPROVALS_TOPIC_ID,
  CONTROL_CHAT_ID,
  OWNER_TELEGRAM_USER_ID,
  createOwnerAdmin,
  createPool,
  phase8DatabaseUrl,
  resetAndMigrate,
  seedAllControlCenterDestinations,
  truncatePhase8Tables,
} from './harness.js';

const describePhase8 = phase8DatabaseUrl === '' ? describe.skip : describe;

describePhase8('phase8 action-token security', () => {
  let pool: Pool;
  let destId: string;
  const chatId = CONTROL_CHAT_ID;
  const topicId = APPROVALS_TOPIC_ID;
  const ownerTg = OWNER_TELEGRAM_USER_ID;

  beforeAll(async () => {
    await resetAndMigrate(phase8DatabaseUrl);
    pool = createPool(phase8DatabaseUrl);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncatePhase8Tables(pool);
    const dests = await seedAllControlCenterDestinations(pool);
    destId = dests.CONTROL_CENTER_APPROVALS;
    await createOwnerAdmin(pool, ownerTg);
  });

  const config = localControlCenterFixtureConfig([ownerTg]);

  async function issueForOwner(adminId: string) {
    return issueAdminActionToken(pool, config, {
      adminUserId: adminId,
      actionType: 'withdrawal.decide.APPROVE',
      resourceType: 'withdrawal',
      resourceId: '00000000-0000-4000-8000-000000000001',
      expectedState: 'MANUAL_REVIEW',
      destinationId: destId,
      boundChatId: chatId,
      boundTopicThreadId: topicId,
    });
  }

  it('accepts valid Owner action token consume', async () => {
    const admin = await pool.query<{ id: string }>(
      `SELECT id FROM admin_users WHERE telegram_user_id = $1::bigint`,
      [ownerTg],
    );
    const issued = await issueForOwner(admin.rows[0]!.id);
    const consumed = await consumeAdminActionToken(pool, {
      rawToken: issued.rawToken,
      actorAdminUserId: admin.rows[0]!.id,
      chatId,
      topicThreadId: topicId,
    });
    expect(consumed.alreadyProcessed).toBe(false);
    expect(consumed.token.consumedAt).not.toBeNull();
  });

  it('rejects unauthorized Telegram user', async () => {
    await expect(
      authorizeOwnerAction(pool, config, {
        telegramUserId: '111111',
        permissionCode: CONTROL_CENTER_PERMISSIONS.WITHDRAWAL_REVIEW_DECIDE,
        chatId,
        topicThreadId: topicId,
        environment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('rejects group admin who is not configured Owner', async () => {
    await createOwnerAdmin(pool, '777777');
    await expect(
      authorizeOwnerAction(pool, config, {
        telegramUserId: '777777',
        permissionCode: CONTROL_CENTER_PERMISSIONS.WITHDRAWAL_REVIEW_DECIDE,
        chatId,
        topicThreadId: topicId,
        environment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('rejects configured Owner without ACTIVE DB admin', async () => {
    await pool.query(
      `UPDATE admin_users SET status = 'DISABLED' WHERE telegram_user_id = $1::bigint`,
      [ownerTg],
    );
    await expect(
      authorizeOwnerAction(pool, config, {
        telegramUserId: ownerTg,
        permissionCode: CONTROL_CENTER_PERMISSIONS.WITHDRAWAL_REVIEW_DECIDE,
        chatId,
        topicThreadId: topicId,
        environment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('rejects admin without OWNER role binding', async () => {
    await pool.query(`DELETE FROM admin_role_bindings`);
    await expect(
      authorizeOwnerAction(pool, config, {
        telegramUserId: ownerTg,
        permissionCode: CONTROL_CENTER_PERMISSIONS.WITHDRAWAL_REVIEW_DECIDE,
        chatId,
        topicThreadId: topicId,
        environment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('rejects wrong chat and wrong topic', async () => {
    const admin = await pool.query<{ id: string }>(
      `SELECT id FROM admin_users WHERE telegram_user_id = $1::bigint`,
      [ownerTg],
    );
    const issued = await issueForOwner(admin.rows[0]!.id);
    await expect(
      consumeAdminActionToken(pool, {
        rawToken: issued.rawToken,
        actorAdminUserId: admin.rows[0]!.id,
        chatId: '-1009999',
        topicThreadId: topicId,
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);
    await expect(
      consumeAdminActionToken(pool, {
        rawToken: issued.rawToken,
        actorAdminUserId: admin.rows[0]!.id,
        chatId,
        topicThreadId: '99',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);
  });

  it('rejects random/expired/consumed tokens and actor mismatch', async () => {
    const admin = await pool.query<{ id: string }>(
      `SELECT id FROM admin_users WHERE telegram_user_id = $1::bigint`,
      [ownerTg],
    );
    await expect(
      consumeAdminActionToken(pool, {
        rawToken: 'totally-random-token-value-xxxxxxxx',
        actorAdminUserId: admin.rows[0]!.id,
        chatId,
        topicThreadId: topicId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });

    const issued = await issueAdminActionToken(pool, config, {
      adminUserId: admin.rows[0]!.id,
      actionType: 'withdrawal.decide.APPROVE',
      resourceType: 'withdrawal',
      resourceId: '00000000-0000-4000-8000-000000000001',
      expectedState: 'MANUAL_REVIEW',
      destinationId: destId,
      boundChatId: chatId,
      boundTopicThreadId: topicId,
      ttlSeconds: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await expect(
      consumeAdminActionToken(pool, {
        rawToken: issued.rawToken,
        actorAdminUserId: admin.rows[0]!.id,
        chatId,
        topicThreadId: topicId,
      }),
    ).rejects.toMatchObject({ code: 'ACTION_EXPIRED' });

    const issued2 = await issueForOwner(admin.rows[0]!.id);
    await consumeAdminActionToken(pool, {
      rawToken: issued2.rawToken,
      actorAdminUserId: admin.rows[0]!.id,
      chatId,
      topicThreadId: topicId,
    });
    const again = await consumeAdminActionToken(pool, {
      rawToken: issued2.rawToken,
      actorAdminUserId: admin.rows[0]!.id,
      chatId,
      topicThreadId: topicId,
    });
    expect(again.alreadyProcessed).toBe(true);

    const other = await createOwnerAdmin(pool, '900002');
    const issued3 = await issueForOwner(admin.rows[0]!.id);
    await expect(
      consumeAdminActionToken(pool, {
        rawToken: issued3.rawToken,
        actorAdminUserId: other.adminUserId,
        chatId,
        topicThreadId: topicId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });

  it('stores hash only; 100 duplicate consumes execute once', async () => {
    const admin = await pool.query<{ id: string }>(
      `SELECT id FROM admin_users WHERE telegram_user_id = $1::bigint`,
      [ownerTg],
    );
    const issued = await issueForOwner(admin.rows[0]!.id);
    const stored = await pool.query<{ token_hash: string }>(
      `SELECT token_hash FROM admin_action_tokens WHERE id = $1`,
      [issued.token.id],
    );
    expect(stored.rows[0]!.token_hash).toBe(hashActionToken(issued.rawToken));
    expect(stored.rows[0]!.token_hash).not.toBe(issued.rawToken);

    let wins = 0;
    await Promise.all(
      Array.from({ length: 100 }, () =>
        consumeAdminActionToken(pool, {
          rawToken: issued.rawToken,
          actorAdminUserId: admin.rows[0]!.id,
          chatId,
          topicThreadId: topicId,
        }).then((r) => {
          if (!r.alreadyProcessed) wins += 1;
          return r;
        }),
      ),
    );
    expect(wins).toBe(1);
  });

  it('callback payload contains no trusted financial fields', async () => {
    const admin = await pool.query<{ id: string }>(
      `SELECT id FROM admin_users WHERE telegram_user_id = $1::bigint`,
      [ownerTg],
    );
    const issued = await issueForOwner(admin.rows[0]!.id);
    expect(issued.rawToken).not.toMatch(/amount|fee|net|balance|MANUAL_REVIEW/i);
    expect(Buffer.byteLength(issued.rawToken, 'utf8')).toBeLessThanOrEqual(64);
  });
});
