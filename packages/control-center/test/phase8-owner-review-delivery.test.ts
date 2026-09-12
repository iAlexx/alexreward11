import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  ControlCenterError,
  executeWithdrawalDecisionFromToken,
  expireOpenWithdrawalDecisionTokens,
  findAdminActionTokenByRaw,
  hashActionToken,
  processOwnerReviewRequiredOutboxBatch,
  type ApprovalsTelegramSender,
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
  truncatePhase8Tables,
  upsertTestDestination,
} from './harness.js';

const describePhase8 = phase8DatabaseUrl === '' ? describe.skip : describe;

function createFakeTelegram(options?: {
  failOnce?: boolean;
  onSend?: (input: {
    chatId: string;
    buttons: ReadonlyArray<{ decision: string; rawToken: string }>;
  }) => void | Promise<void>;
}): ApprovalsTelegramSender & {
  sends: number;
  lastButtons: Array<{ decision: string; rawToken: string }>;
} {
  let failOnce = options?.failOnce === true;
  const state = {
    sends: 0,
    lastButtons: [] as Array<{ decision: string; rawToken: string }>,
  };
  return {
    get sends() {
      return state.sends;
    },
    get lastButtons() {
      return state.lastButtons;
    },
    async sendApprovalsCard(input) {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated telegram send failure');
      }
      state.sends += 1;
      state.lastButtons = input.buttons.map((b) => ({
        decision: b.decision,
        rawToken: b.rawToken,
      }));
      await options?.onSend?.(input);
      return { telegramMessageId: String(1000 + state.sends) };
    },
  };
}

describePhase8('phase8 owner-review Approvals delivery', () => {
  let pool: Pool;
  let adminId: string;
  let seq = 940000;

  beforeAll(async () => {
    await resetAndMigrate(phase8DatabaseUrl);
    pool = createPool(phase8DatabaseUrl);
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await truncatePhase8Tables(pool);
    const base = await seedPhase8Base(pool);
    adminId = base.adminUserId;
  });

  it('successful delivery issues 3 hashed tokens, one PUBLISHED publication, dispatches Outbox', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    const fake = createFakeTelegram();

    const result = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fake,
    );
    expect(result.claimed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(fake.sends).toBe(1);
    expect(fake.lastButtons).toHaveLength(3);

    const tokens = await pool.query<{
      token_hash: string;
      action_type: string;
      consumed_at: Date | null;
    }>(
      `SELECT token_hash, action_type, consumed_at
       FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND action_type LIKE 'withdrawal.decide.%'
         AND expires_at > now()`,
      [withdrawalId],
    );
    expect(tokens.rowCount).toBe(3);
    for (const row of tokens.rows) {
      expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.consumed_at).toBeNull();
    }
    for (const button of fake.lastButtons) {
      const hash = hashActionToken(button.rawToken);
      expect(tokens.rows.some((t) => t.token_hash === hash)).toBe(true);
    }

    const pub = await pool.query<{ status: string; telegram_message_id: string | null }>(
      `SELECT status::text AS status, telegram_message_id::text AS telegram_message_id
       FROM telegram_publications
       WHERE subject_id = $1::uuid AND message_kind = 'approvals_card'`,
      [withdrawalId],
    );
    expect(pub.rows[0]?.status).toBe('PUBLISHED');
    expect(pub.rows[0]?.telegram_message_id).toBeTruthy();

    const outbox = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events
       WHERE aggregate_id = $1::uuid AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );
    expect(outbox.rows[0]?.status).toBe('DISPATCHED');
  });

  it('already-PUBLISHED does not reissue or resend', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    const fake = createFakeTelegram();
    await processOwnerReviewRequiredOutboxBatch(pool, ccConfig, engineConfig, fake);
    expect(fake.sends).toBe(1);

    // Re-queue Outbox as PENDING to simulate mistaken re-claim after publish.
    await pool.query(
      `UPDATE outbox_events
       SET status = 'PENDING', available_at = now(), dispatched_at = NULL
       WHERE aggregate_id = $1::uuid AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );
    const again = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fake,
    );
    expect(again.superseded).toBe(1);
    expect(fake.sends).toBe(1);

    const open = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [withdrawalId],
    );
    expect(open.rows[0]?.c).toBe(3);
  });

  it('stale expected state completes Outbox without issuing actionable tokens', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    await pool.query(`UPDATE withdrawals SET state = 'HELD' WHERE id = $1::uuid`, [
      withdrawalId,
    ]);
    const fake = createFakeTelegram();
    const result = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fake,
    );
    expect(result.superseded).toBe(1);
    expect(fake.sends).toBe(0);
    const open = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid AND expires_at > now() AND consumed_at IS NULL`,
      [withdrawalId],
    );
    expect(open.rows[0]?.c).toBe(0);
  });

  it('disabled Approvals destination fails closed (retryable)', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    await createManualReviewWithdrawal(pool, userId);
    await pool.query(
      `UPDATE telegram_destinations SET enabled = false
       WHERE purpose = 'CONTROL_CENTER_APPROVALS'`,
    );
    const fake = createFakeTelegram();
    const result = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fake,
    );
    expect(result.retried).toBe(1);
    expect(fake.sends).toBe(0);
  });

  it('Owner without permission cannot receive actionable delivery', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    await createManualReviewWithdrawal(pool, userId);
    await pool.query(
      `DELETE FROM admin_role_permissions
       WHERE role_id = (SELECT id FROM admin_roles WHERE code = 'OWNER')
         AND permission_id = (
           SELECT id FROM admin_permissions WHERE code = 'withdrawal.review.decide'
         )`,
    );
    try {
      const fake = createFakeTelegram();
      const result = await processOwnerReviewRequiredOutboxBatch(
        pool,
        ccConfig,
        engineConfig,
        fake,
      );
      expect(result.retried).toBe(1);
      expect(fake.sends).toBe(0);
    } finally {
      // Permission catalogue survives truncate — restore for later tests.
      await pool.query(
        `INSERT INTO admin_role_permissions (role_id, permission_id)
         SELECT r.id, p.id
         FROM admin_roles r
         CROSS JOIN admin_permissions p
         WHERE r.code = 'OWNER' AND p.code = 'withdrawal.review.decide'
         ON CONFLICT DO NOTHING`,
      );
    }
  });

  it('send failure then retry expires orphan tokens and delivers one active set', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    const failing = createFakeTelegram({ failOnce: true });
    const first = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      failing,
    );
    expect(first.retried).toBe(1);

    // Force lease expiry so the event is claimable again.
    await pool.query(
      `UPDATE outbox_events SET available_at = now()
       WHERE aggregate_id = $1::uuid AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );

    const orphansBefore = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid AND consumed_at IS NULL AND expires_at > now()`,
      [withdrawalId],
    );
    expect(orphansBefore.rows[0]?.c).toBe(3);

    const ok = createFakeTelegram();
    const second = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      ok,
    );
    expect(second.delivered).toBe(1);
    expect(ok.sends).toBe(1);

    const open = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid AND consumed_at IS NULL AND expires_at > now()`,
      [withdrawalId],
    );
    expect(open.rows[0]?.c).toBe(3);

    const expired = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid AND consumed_at IS NULL AND expires_at <= now()`,
      [withdrawalId],
    );
    expect(expired.rows[0]?.c).toBe(3);
  });

  it('simulated send-success / markPublication crash leaves prior card non-actionable after retry', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);

    let firstRawApprove: string | undefined;
    const crashAfterSend: ApprovalsTelegramSender = {
      async sendApprovalsCard(input) {
        firstRawApprove = input.buttons.find((b) => b.decision === 'APPROVE')?.rawToken;
        // Simulate: Telegram accepted, but process crashes before markPublicationPublished.
        throw new Error('crash after telegram accept before publication mark');
      },
    };
    await processOwnerReviewRequiredOutboxBatch(pool, ccConfig, engineConfig, crashAfterSend);
    expect(firstRawApprove).toBeTruthy();

    await pool.query(
      `UPDATE outbox_events SET available_at = now()
       WHERE aggregate_id = $1::uuid AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );

    const ok = createFakeTelegram();
    await processOwnerReviewRequiredOutboxBatch(pool, ccConfig, engineConfig, ok);
    expect(ok.sends).toBe(1);

    // Stale first card token must no longer be actionable.
    const stale = await findAdminActionTokenByRaw(pool, firstRawApprove!);
    expect(stale).not.toBeNull();
    expect(stale!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());

    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: firstRawApprove!,
        telegramUserId: OWNER_TELEGRAM_USER_ID,
        chatId: CONTROL_CHAT_ID,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);

    const freshApprove = ok.lastButtons.find((b) => b.decision === 'APPROVE')!;
    const decided = await executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
      rawToken: freshApprove.rawToken,
      telegramUserId: OWNER_TELEGRAM_USER_ID,
      chatId: CONTROL_CHAT_ID,
      topicThreadId: APPROVALS_TOPIC_ID,
      environment: 'LOCAL',
    });
    expect(decided.state).toBe('APPROVED');
  });

  it('successful APPROVE expires sibling tokens; repeated click stays idempotent', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    const fake = createFakeTelegram();
    await processOwnerReviewRequiredOutboxBatch(pool, ccConfig, engineConfig, fake);
    const approve = fake.lastButtons.find((b) => b.decision === 'APPROVE')!;
    const hold = fake.lastButtons.find((b) => b.decision === 'HOLD')!;

    const first = await executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
      rawToken: approve.rawToken,
      telegramUserId: OWNER_TELEGRAM_USER_ID,
      chatId: CONTROL_CHAT_ID,
      topicThreadId: APPROVALS_TOPIC_ID,
      environment: 'LOCAL',
    });
    expect(first.state).toBe('APPROVED');

    const siblings = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND action_type IN ('withdrawal.decide.HOLD', 'withdrawal.decide.REJECT')
         AND expires_at > now()
         AND consumed_at IS NULL`,
      [withdrawalId],
    );
    expect(siblings.rows[0]?.c).toBe(0);

    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: hold.rawToken,
        telegramUserId: OWNER_TELEGRAM_USER_ID,
        chatId: CONTROL_CHAT_ID,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);

    const again = await executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
      rawToken: approve.rawToken,
      telegramUserId: OWNER_TELEGRAM_USER_ID,
      chatId: CONTROL_CHAT_ID,
      topicThreadId: APPROVALS_TOPIC_ID,
      environment: 'LOCAL',
    });
    expect(again.alreadyProcessed).toBe(true);
  });

  it('expireOpenWithdrawalDecisionTokens is a non-decision supersession', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);
    const fake = createFakeTelegram();
    await processOwnerReviewRequiredOutboxBatch(pool, ccConfig, engineConfig, fake);
    const destination = await upsertTestDestination(pool, {
      environment: 'LOCAL',
      purpose: 'CONTROL_CENTER_APPROVALS',
      chatId: CONTROL_CHAT_ID,
      topicThreadId: APPROVALS_TOPIC_ID,
    });
    const expired = await expireOpenWithdrawalDecisionTokens(pool, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      adminUserId: adminId,
      destinationId: destination.id,
    });
    expect(expired.expiredCount).toBe(3);
    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(state.rows[0]?.state).toBe('MANUAL_REVIEW');
  });

  it('unknown allowlist Owner cannot receive delivery', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    await createManualReviewWithdrawal(pool, userId);
    const unknownAllowlist = {
      ...ccConfig,
      ownerTelegramUserIds: new Set<string>(['424242']),
    };
    const fake = createFakeTelegram();
    const denied = await processOwnerReviewRequiredOutboxBatch(
      pool,
      unknownAllowlist,
      engineConfig,
      fake,
    );
    expect(denied.retried).toBe(1);
    expect(fake.sends).toBe(0);
  });

  it('concurrent deliverers serialize expire→issue; never six active tokens', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);

    const outbox = await pool.query<{
      id: string;
      aggregate_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, aggregate_id, payload
       FROM outbox_events
       WHERE aggregate_id = $1::uuid
         AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );
    const row = outbox.rows[0];
    expect(row).toBeDefined();
    const sharedEvent = {
      id: row!.id,
      aggregateId: row!.aggregate_id,
      payload: row!.payload,
    };

    function deferred(): {
      promise: Promise<void>;
      resolve: () => void;
    } {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const aPausedAfterExpire = deferred();
    const releaseA = deferred();
    let aRawApprove: string | undefined;
    let bEnteredCritical = false;

    const fakeA = createFakeTelegram({
      onSend: (input) => {
        aRawApprove = input.buttons.find((b) => b.decision === 'APPROVE')?.rawToken;
      },
    });
    const fakeB = createFakeTelegram();

    const deliverA = processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fakeA,
      {
        claimedEvents: [sharedEvent],
        serializationHooks: {
          afterExpire: async () => {
            aPausedAfterExpire.resolve();
            await releaseA.promise;
          },
        },
      },
    );

    await aPausedAfterExpire.promise;

    const deliverB = processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fakeB,
      {
        claimedEvents: [sharedEvent],
        serializationHooks: {
          afterExpire: async () => {
            bEnteredCritical = true;
          },
        },
      },
    );

    try {
      // While A holds the publication lock after expire (before issue), B must not have
      // entered its own expire yet — and no tokens may exist yet.
      for (let i = 0; i < 25; i += 1) {
        if (bEnteredCritical) {
          throw new Error('B entered expire while A still held the serialization lock');
        }
        const openMid = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM admin_action_tokens
           WHERE resource_id = $1::uuid
             AND action_type LIKE 'withdrawal.decide.%'
             AND consumed_at IS NULL
             AND expires_at > now()`,
          [withdrawalId],
        );
        expect(openMid.rows[0]?.c).toBe(0);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(bEnteredCritical).toBe(false);
    } finally {
      releaseA.resolve();
    }

    const [resultA, resultB] = await Promise.all([deliverA, deliverB]);

    expect(resultA.delivered + resultA.superseded + resultA.retried).toBe(1);
    expect(resultB.delivered + resultB.superseded + resultB.retried).toBe(1);
    expect(resultA.retried + resultB.retried).toBe(0);

    const open = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND action_type LIKE 'withdrawal.decide.%'
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [withdrawalId],
    );
    expect(open.rows[0]?.c).toBe(3);
    expect(open.rows[0]?.c).not.toBe(6);

    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(state.rows[0]?.state).toBe('MANUAL_REVIEW');

    const pub = await pool.query<{ status: string }>(
      `SELECT status::text AS status
       FROM telegram_publications
       WHERE subject_id = $1::uuid AND message_kind = 'approvals_card'`,
      [withdrawalId],
    );
    expect(pub.rowCount).toBe(1);

    if (aRawApprove !== undefined && resultB.delivered === 1) {
      await expect(
        executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
          rawToken: aRawApprove,
          telegramUserId: OWNER_TELEGRAM_USER_ID,
          chatId: CONTROL_CHAT_ID,
          topicThreadId: APPROVALS_TOPIC_ID,
          environment: 'LOCAL',
        }),
      ).rejects.toBeInstanceOf(ControlCenterError);
    }
  });

  it('stale Telegram success cannot PUBLISH after a newer generation superseded tokens', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);

    const outbox = await pool.query<{
      id: string;
      aggregate_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, aggregate_id, payload
       FROM outbox_events
       WHERE aggregate_id = $1::uuid
         AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );
    const row = outbox.rows[0];
    expect(row).toBeDefined();
    const sharedEvent = {
      id: row!.id,
      aggregateId: row!.aggregate_id,
      payload: row!.payload,
    };

    function deferred(): {
      promise: Promise<void>;
      resolve: () => void;
    } {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const aPausedBeforeSend = deferred();
    const releaseA = deferred();
    let aRawApprove: string | undefined;

    const fakeA = createFakeTelegram({
      onSend: (input) => {
        aRawApprove = input.buttons.find((b) => b.decision === 'APPROVE')?.rawToken;
      },
    });
    const failingB = createFakeTelegram({ failOnce: true });

    const deliverA = processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fakeA,
      {
        claimedEvents: [sharedEvent],
        serializationHooks: {
          beforeTelegramSend: async () => {
            aPausedBeforeSend.resolve();
            await releaseA.promise;
          },
        },
      },
    );

    await aPausedBeforeSend.promise;

    // B expires A's tokens, issues set B, then Telegram send fails.
    const resultB = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      failingB,
      { claimedEvents: [sharedEvent] },
    );
    expect(resultB.retried).toBe(1);
    expect(failingB.sends).toBe(0);

    const openAfterB = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND action_type LIKE 'withdrawal.decide.%'
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [withdrawalId],
    );
    expect(openAfterB.rows[0]?.c).toBe(3);

    releaseA.resolve();
    const resultA = await deliverA;
    // Stale A send must not finalize publication/outbox.
    expect(resultA.superseded).toBe(1);
    expect(resultA.delivered).toBe(0);
    expect(aRawApprove).toBeTruthy();

    const pubAfterA = await pool.query<{ status: string }>(
      `SELECT status::text AS status
       FROM telegram_publications
       WHERE subject_id = $1::uuid AND message_kind = 'approvals_card'`,
      [withdrawalId],
    );
    expect(pubAfterA.rows[0]?.status).not.toBe('PUBLISHED');

    const outboxAfterA = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events WHERE id = $1::uuid`,
      [sharedEvent.id],
    );
    expect(outboxAfterA.rows[0]?.status).toBe('PENDING');

    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: aRawApprove!,
        telegramUserId: OWNER_TELEGRAM_USER_ID,
        chatId: CONTROL_CHAT_ID,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);

    const stateAfterA = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(stateAfterA.rows[0]?.state).toBe('MANUAL_REVIEW');

    // Later retry C delivers the current generation only.
    await pool.query(`UPDATE outbox_events SET available_at = now() WHERE id = $1::uuid`, [
      sharedEvent.id,
    ]);
    const fakeC = createFakeTelegram();
    const resultC = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fakeC,
      { claimedEvents: [sharedEvent] },
    );
    expect(resultC.delivered).toBe(1);
    expect(fakeC.sends).toBe(1);

    const pubFinal = await pool.query<{ status: string; telegram_message_id: string | null }>(
      `SELECT status::text AS status, telegram_message_id::text AS telegram_message_id
       FROM telegram_publications
       WHERE subject_id = $1::uuid AND message_kind = 'approvals_card'`,
      [withdrawalId],
    );
    expect(pubFinal.rows[0]?.status).toBe('PUBLISHED');
    expect(pubFinal.rows[0]?.telegram_message_id).toBeTruthy();

    const outboxFinal = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events WHERE id = $1::uuid`,
      [sharedEvent.id],
    );
    expect(outboxFinal.rows[0]?.status).toBe('DISPATCHED');

    const openFinal = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND action_type LIKE 'withdrawal.decide.%'
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [withdrawalId],
    );
    expect(openFinal.rows[0]?.c).toBe(3);

    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: aRawApprove!,
        telegramUserId: OWNER_TELEGRAM_USER_ID,
        chatId: CONTROL_CHAT_ID,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);

    const freshApprove = fakeC.lastButtons.find((b) => b.decision === 'APPROVE')!;
    const decided = await executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
      rawToken: freshApprove.rawToken,
      telegramUserId: OWNER_TELEGRAM_USER_ID,
      chatId: CONTROL_CHAT_ID,
      topicThreadId: APPROVALS_TOPIC_ID,
      environment: 'LOCAL',
    });
    expect(decided.state).toBe('APPROVED');
  });

  it('expired superseded generation cannot revive after newer generation also expires', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);

    const outbox = await pool.query<{
      id: string;
      aggregate_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, aggregate_id, payload
       FROM outbox_events
       WHERE aggregate_id = $1::uuid
         AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );
    const row = outbox.rows[0];
    expect(row).toBeDefined();
    const sharedEvent = {
      id: row!.id,
      aggregateId: row!.aggregate_id,
      payload: row!.payload,
    };

    function deferred(): {
      promise: Promise<void>;
      resolve: () => void;
    } {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    const aPausedBeforeSend = deferred();
    const releaseA = deferred();
    let aRawApprove: string | undefined;

    const fakeA = createFakeTelegram({
      onSend: (input) => {
        aRawApprove = input.buttons.find((b) => b.decision === 'APPROVE')?.rawToken;
      },
    });
    const failingB = createFakeTelegram({ failOnce: true });

    const deliverA = processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fakeA,
      {
        claimedEvents: [sharedEvent],
        serializationHooks: {
          beforeTelegramSend: async () => {
            aPausedBeforeSend.resolve();
            await releaseA.promise;
          },
        },
      },
    );

    await aPausedBeforeSend.promise;

    // B supersedes A and issues a newer generation, then Telegram send fails.
    const resultB = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      failingB,
      { claimedEvents: [sharedEvent] },
    );
    expect(resultB.retried).toBe(1);

    // B later expires naturally with no Owner decision (all open decide tokens expire).
    await pool.query(
      `UPDATE admin_action_tokens
       SET expires_at = now()
       WHERE resource_id = $1::uuid
         AND action_type LIKE 'withdrawal.decide.%'
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [withdrawalId],
    );

    const openAfterBExpire = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND action_type LIKE 'withdrawal.decide.%'
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [withdrawalId],
    );
    expect(openAfterBExpire.rows[0]?.c).toBe(0);

    releaseA.resolve();
    const resultA = await deliverA;
    expect(resultA.superseded).toBe(1);
    expect(resultA.delivered).toBe(0);
    expect(aRawApprove).toBeTruthy();

    const pubAfterA = await pool.query<{ status: string }>(
      `SELECT status::text AS status
       FROM telegram_publications
       WHERE subject_id = $1::uuid AND message_kind = 'approvals_card'`,
      [withdrawalId],
    );
    expect(pubAfterA.rows[0]?.status).not.toBe('PUBLISHED');

    const outboxAfterA = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events WHERE id = $1::uuid`,
      [sharedEvent.id],
    );
    expect(outboxAfterA.rows[0]?.status).toBe('PENDING');

    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: aRawApprove!,
        telegramUserId: OWNER_TELEGRAM_USER_ID,
        chatId: CONTROL_CHAT_ID,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);

    // Retry C recovers with one fresh actionable set.
    await pool.query(`UPDATE outbox_events SET available_at = now() WHERE id = $1::uuid`, [
      sharedEvent.id,
    ]);
    const fakeC = createFakeTelegram();
    const resultC = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fakeC,
      { claimedEvents: [sharedEvent] },
    );
    expect(resultC.delivered).toBe(1);
    expect(fakeC.sends).toBe(1);

    const pubFinal = await pool.query<{ status: string }>(
      `SELECT status::text AS status
       FROM telegram_publications
       WHERE subject_id = $1::uuid AND message_kind = 'approvals_card'`,
      [withdrawalId],
    );
    expect(pubFinal.rows[0]?.status).toBe('PUBLISHED');

    const outboxFinal = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events WHERE id = $1::uuid`,
      [sharedEvent.id],
    );
    expect(outboxFinal.rows[0]?.status).toBe('DISPATCHED');

    const openFinal = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_action_tokens
       WHERE resource_id = $1::uuid
         AND action_type LIKE 'withdrawal.decide.%'
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [withdrawalId],
    );
    expect(openFinal.rows[0]?.c).toBe(3);

    await expect(
      executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
        rawToken: aRawApprove!,
        telegramUserId: OWNER_TELEGRAM_USER_ID,
        chatId: CONTROL_CHAT_ID,
        topicThreadId: APPROVALS_TOPIC_ID,
        environment: 'LOCAL',
      }),
    ).rejects.toBeInstanceOf(ControlCenterError);
  });

  it('Owner consume of exact sent generation remains finalizable despite sibling expiry', async () => {
    const { userId } = await createTestUser(pool, String(++seq));
    const { withdrawalId } = await createManualReviewWithdrawal(pool, userId);

    const fake = createFakeTelegram({
      onSend: async (input) => {
        const approve = input.buttons.find((b) => b.decision === 'APPROVE');
        expect(approve).toBeDefined();
        // Owner decides from this exact generation before post-send finalization.
        const decided = await executeWithdrawalDecisionFromToken(pool, ccConfig, engineConfig, {
          rawToken: approve!.rawToken,
          telegramUserId: OWNER_TELEGRAM_USER_ID,
          chatId: CONTROL_CHAT_ID,
          topicThreadId: APPROVALS_TOPIC_ID,
          environment: 'LOCAL',
        });
        expect(decided.state).toBe('APPROVED');
      },
    });

    const result = await processOwnerReviewRequiredOutboxBatch(
      pool,
      ccConfig,
      engineConfig,
      fake,
    );
    expect(result.delivered).toBe(1);
    expect(fake.sends).toBe(1);

    const pub = await pool.query<{ status: string }>(
      `SELECT status::text AS status
       FROM telegram_publications
       WHERE subject_id = $1::uuid AND message_kind = 'approvals_card'`,
      [withdrawalId],
    );
    expect(pub.rows[0]?.status).toBe('PUBLISHED');

    const outbox = await pool.query<{ status: string }>(
      `SELECT status::text AS status
       FROM outbox_events
       WHERE aggregate_id = $1::uuid
         AND event_type = 'withdrawal.owner_review_required'`,
      [withdrawalId],
    );
    expect(outbox.rows[0]?.status).toBe('DISPATCHED');

    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(state.rows[0]?.state).toBe('APPROVED');
  });
});
