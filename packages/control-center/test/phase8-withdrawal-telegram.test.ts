import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  ControlCenterError,
  executeWithdrawalDecisionFromToken,
  issueWithdrawalDecisionTokens,
} from '../src/index.js';
import {
  APPROVALS_TOPIC_ID,
  CONTROL_CHAT_ID,
  OWNER_TELEGRAM_USER_ID,
  ccConfig,
  createManualReviewWithdrawal,
  createPool,
  createTestUser,
  engineConfig,
  phase8DatabaseUrl,
  resetAndMigrate,
  seedPhase8Base,
} from './harness.js';

const describePhase8 = phase8DatabaseUrl === '' ? describe.skip : describe;

describePhase8('phase8 withdrawal telegram decisions', () => {
  let pool: Pool;
  let adminId: string;
  const chatId = CONTROL_CHAT_ID;
  const ownerTg = OWNER_TELEGRAM_USER_ID;

  beforeAll(async () => {
    await resetAndMigrate(phase8DatabaseUrl);
    pool = createPool(phase8DatabaseUrl);
    const base = await seedPhase8Base(pool);
    adminId = base.adminUserId;
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('Owner APPROVE via Telegram token calls decideWithdrawal once; duplicates safe', async () => {
    const { userId } = await createTestUser(pool, '930001');
    const { withdrawalId, state } = await createManualReviewWithdrawal(pool, userId);
    expect(state).toBe('MANUAL_REVIEW');

    const tokens = await issueWithdrawalDecisionTokens(pool, ccConfig, {
      adminUserId: adminId,
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      environment: 'LOCAL',
    });
    const approve = tokens.find((t) => t.decision === 'APPROVE');
    expect(approve).toBeTruthy();

    const first = await executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
      rawToken: approve!.rawToken,
      telegramUserId: ownerTg,
      chatId,
      topicThreadId: APPROVALS_TOPIC_ID,
      environment: 'LOCAL',
    });
    expect(first.alreadyProcessed).toBe(false);
    expect(first.state).toBe('APPROVED');

    const second = await executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
      rawToken: approve!.rawToken,
      telegramUserId: ownerTg,
      chatId,
      topicThreadId: APPROVALS_TOPIC_ID,
      environment: 'LOCAL',
    });
    expect(second.alreadyProcessed).toBe(true);

    const outbox = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events
       WHERE aggregate_id = $1::uuid AND event_type LIKE '%approved%'`,
      [withdrawalId],
    );
    expect(outbox.rows[0]!.c).toBe(1);
  });

  it('unauthorized actor cannot decide', async () => {
    const { userId } = await createTestUser(pool, '930002');
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    const tokens = await issueWithdrawalDecisionTokens(pool, ccConfig, {
      adminUserId: adminId,
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      environment: 'LOCAL',
    });
    const hold = tokens.find((t) => t.decision === 'HOLD')!;
    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: hold.rawToken,
        telegramUserId: '111111',
        chatId,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);
  });

  it('stale expected state is rejected', async () => {
    const { userId } = await createTestUser(pool, '930003');
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    const tokens = await issueWithdrawalDecisionTokens(pool, ccConfig, {
      adminUserId: adminId,
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      environment: 'LOCAL',
    });
    await pool.query(`UPDATE withdrawals SET state = 'HELD' WHERE id = $1::uuid`, [withdrawalId]);
    const approve = tokens.find((t) => t.decision === 'APPROVE')!;
    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: approve.rawToken,
        telegramUserId: ownerTg,
        chatId,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toMatchObject({ code: 'STATE_CHANGED' });
  });
});
