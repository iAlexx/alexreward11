/**
 * Real Temporal + Outbox relay gates (TestWorkflowEnvironment).
 * Skip unless PHASE7_WITHDRAWAL_TESTS / PHASE7_DATABASE_URL like other phase7 suites.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  clearFakePayoutScenarios,
  decideWithdrawal,
  FakePayoutChain,
  processWithdrawalApprovedOutboxBatch,
  registerFakePayoutScenario,
  runFakePayoutPipeline,
  startWithdrawalWorkflowFromOutbox,
  takeFakePayoutScenario,
  withdrawalWorkflowId,
  WITHDRAWAL_PAYOUT_WORKFLOW_TYPE,
  type TemporalWorkflowStarter,
  type WithdrawalApprovedOutboxEvent,
} from '../src/index.js';
import {
  approveWithdrawal,
  bindVerifiedPrimaryWallet,
  createTestUser,
  engineConfig,
  fundHotWalletUsdt,
  fundUserAvailable,
  phase7DatabaseUrl,
  quoteAndCreate,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
  userBucketBalance,
} from './harness.js';

const workflowsPath = fileURLToPath(
  new URL('../../../apps/worker/src/workflows.ts', import.meta.url),
);

function createTestWithdrawalActivities(db: Pool) {
  return {
    async executeWithdrawalFakePayout(input: {
      withdrawalId: string;
    }): Promise<{ state: string; attemptId: string | null }> {
      if (!engineConfig.fakeChainEnabled) {
        throw new Error('Fake payout chain is disabled');
      }
      const scenario = takeFakePayoutScenario(input.withdrawalId);
      const fakeChain = new FakePayoutChain(engineConfig);
      const result = await runFakePayoutPipeline(db, engineConfig, fakeChain, {
        withdrawalId: input.withdrawalId,
        scenario,
      });
      return { state: result.state, attemptId: result.attemptId };
    },
  };
}

describe.skipIf(phase7DatabaseUrl === '')('Phase 7 Temporal outbox relay', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let testEnv: TestWorkflowEnvironment;
  let taskQueueCounter = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 300_000);

  afterAll(async () => {
    await testEnv?.teardown();
    await pool?.end();
  });

  beforeEach(async () => {
    clearFakePayoutScenarios();
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
  });

  function nextTaskQueue(): string {
    taskQueueCounter += 1;
    return `phase7-withdrawal-${taskQueueCounter}-${randomUUID().slice(0, 8)}`;
  }

  async function prepareApprovedWithdrawal(telegramId: string): Promise<{
    userId: string;
    withdrawalId: string;
  }> {
    const userId = await createTestUser(pool, telegramId);
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '500000',
      key: randomUUID(),
    });
    await fundHotWalletUsdt(pool, hotWalletId, '10000000');
    const { withdrawalId } = await quoteAndCreate(pool, userId, '200000', randomUUID());
    return { userId, withdrawalId };
  }

  async function outboxRow(withdrawalId: string): Promise<{
    id: string;
    status: string;
    attempts: number;
    last_error_redacted: string | null;
    payload: Record<string, unknown>;
  }> {
    const result = await pool.query<{
      id: string;
      status: string;
      attempts: number;
      last_error_redacted: string | null;
      payload: Record<string, unknown>;
    }>(
      `SELECT id, status::text AS status, attempts, last_error_redacted, payload
       FROM outbox_events
       WHERE dedupe_key = $1`,
      [`withdrawal.approved:${withdrawalId}`],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('outbox row missing');
    return row;
  }

  it('approval inserts Outbox; decideWithdrawal succeeds without Temporal running', async () => {
    const { withdrawalId } = await prepareApprovedWithdrawal('7501');
    const decided = await decideWithdrawal(pool, engineConfig, {
      withdrawalId,
      expectedState: 'MANUAL_REVIEW',
      decision: 'APPROVE',
      trustedOwnerActorContext: { adminUserId },
      reason: 'no-temporal',
      idempotencyKey: randomUUID(),
    });
    expect(decided.state).toBe('APPROVED');
    expect(decided.workflowId).toBe(withdrawalWorkflowId(withdrawalId));

    const row = await outboxRow(withdrawalId);
    expect(row.status).toBe('PENDING');
    expect(row.payload.workflowId).toBe(`withdrawal/${withdrawalId}`);
    expect(row.payload.withdrawalId).toBe(withdrawalId);
  });

  it('relay starts workflowId withdrawal/{id}', async () => {
    const { withdrawalId } = await prepareApprovedWithdrawal('7502');
    await approveWithdrawal(pool, adminUserId, withdrawalId);
    registerFakePayoutScenario(withdrawalId, 'CONFIRMED_SUCCESS');

    const taskQueue = nextTaskQueue();
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: createTestWithdrawalActivities(pool),
    });

    await worker.runUntil(async () => {
      const batch = await processWithdrawalApprovedOutboxBatch(pool, {
        client: testEnv.client,
        taskQueue,
        fakeChainEnabled: true,
      });
      expect(batch.dispatched).toBe(1);

      const handle = testEnv.client.workflow.getHandle(withdrawalWorkflowId(withdrawalId));
      await expect(handle.result()).resolves.toMatchObject({ state: 'CONFIRMED' });
    });

    const row = await outboxRow(withdrawalId);
    expect(row.status).toBe('DISPATCHED');
  }, 180_000);

  it('duplicate relay → one workflow (AlreadyStarted handled)', async () => {
    const { withdrawalId } = await prepareApprovedWithdrawal('7503');
    await approveWithdrawal(pool, adminUserId, withdrawalId);
    registerFakePayoutScenario(withdrawalId, 'CONFIRMED_SUCCESS');

    const taskQueue = nextTaskQueue();
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: createTestWithdrawalActivities(pool),
    });

    await worker.runUntil(async () => {
      const first = await processWithdrawalApprovedOutboxBatch(pool, {
        client: testEnv.client,
        taskQueue,
        fakeChainEnabled: true,
      });
      expect(first.dispatched).toBe(1);

      // Reset outbox to PENDING to simulate duplicate delivery of the same event.
      await pool.query(
        `UPDATE outbox_events
         SET status = 'PENDING', dispatched_at = NULL, available_at = now()
         WHERE dedupe_key = $1`,
        [`withdrawal.approved:${withdrawalId}`],
      );

      const second = await processWithdrawalApprovedOutboxBatch(pool, {
        client: testEnv.client,
        taskQueue,
        fakeChainEnabled: true,
      });
      expect(second.dispatched).toBe(1);

      const handle = testEnv.client.workflow.getHandle(withdrawalWorkflowId(withdrawalId));
      await handle.result();

      const descriptions = testEnv.client.workflow.list({
        query: `WorkflowId = "${withdrawalWorkflowId(withdrawalId)}"`,
      });
      const ids: string[] = [];
      for await (const exec of descriptions) {
        ids.push(exec.workflowId);
      }
      expect(new Set(ids).size).toBe(1);
    });
  }, 180_000);

  it('Temporal unavailable → Outbox remains PENDING', async () => {
    const { withdrawalId } = await prepareApprovedWithdrawal('7504');
    await approveWithdrawal(pool, adminUserId, withdrawalId);

    const brokenClient: TemporalWorkflowStarter = {
      workflow: {
        start: async () => {
          throw new Error('14 UNAVAILABLE: connection refused to temporal');
        },
      },
    };

    const batch = await processWithdrawalApprovedOutboxBatch(pool, {
      client: brokenClient,
      taskQueue: nextTaskQueue(),
      fakeChainEnabled: true,
    });
    expect(batch.retried).toBe(1);
    expect(batch.dispatched).toBe(0);

    const row = await outboxRow(withdrawalId);
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBeGreaterThanOrEqual(1);
    expect(row.last_error_redacted).toMatch(/UNAVAILABLE|connection refused/i);
  });

  it('recovery after Temporal up → workflow starts once', async () => {
    const { withdrawalId } = await prepareApprovedWithdrawal('7505');
    await approveWithdrawal(pool, adminUserId, withdrawalId);
    registerFakePayoutScenario(withdrawalId, 'CONFIRMED_SUCCESS');

    const brokenClient: TemporalWorkflowStarter = {
      workflow: {
        start: async () => {
          throw new Error('14 UNAVAILABLE: temporal down');
        },
      },
    };
    await processWithdrawalApprovedOutboxBatch(pool, {
      client: brokenClient,
      taskQueue: nextTaskQueue(),
      fakeChainEnabled: true,
    });
    expect((await outboxRow(withdrawalId)).status).toBe('PENDING');

    // Make immediately available after backoff.
    await pool.query(`UPDATE outbox_events SET available_at = now() WHERE dedupe_key = $1`, [
      `withdrawal.approved:${withdrawalId}`,
    ]);

    const taskQueue = nextTaskQueue();
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: createTestWithdrawalActivities(pool),
    });

    await worker.runUntil(async () => {
      const batch = await processWithdrawalApprovedOutboxBatch(pool, {
        client: testEnv.client,
        taskQueue,
        fakeChainEnabled: true,
      });
      expect(batch.dispatched).toBe(1);
      const handle = testEnv.client.workflow.getHandle(withdrawalWorkflowId(withdrawalId));
      await expect(handle.result()).resolves.toMatchObject({ state: 'CONFIRMED' });
    });

    expect((await outboxRow(withdrawalId)).status).toBe('DISPATCHED');
  }, 180_000);

  it('worker restart/replay → one logical settlement', async () => {
    const { userId, withdrawalId } = await prepareApprovedWithdrawal('7506');
    await approveWithdrawal(pool, adminUserId, withdrawalId);
    registerFakePayoutScenario(withdrawalId, 'CONFIRMED_SUCCESS');

    const taskQueue = nextTaskQueue();
    const activities = createTestWithdrawalActivities(pool);

    const worker1 = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });

    await worker1.runUntil(async () => {
      await processWithdrawalApprovedOutboxBatch(pool, {
        client: testEnv.client,
        taskQueue,
        fakeChainEnabled: true,
      });
      const handle = testEnv.client.workflow.getHandle(withdrawalWorkflowId(withdrawalId));
      await handle.result();
    });

    // Restart worker on same task queue / workflow id — second pipeline must not settle twice.
    const worker2 = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });

    await worker2.runUntil(async () => {
      const started = await startWithdrawalWorkflowFromOutbox(
        testEnv.client,
        {
          id: randomUUID(),
          aggregateId: withdrawalId,
          eventType: 'withdrawal.approved',
          payload: {
            withdrawalId,
            workflowId: withdrawalWorkflowId(withdrawalId),
          },
          attempts: 0,
          availableAt: new Date(),
        } satisfies WithdrawalApprovedOutboxEvent,
        taskQueue,
      );
      expect(started.alreadyStarted).toBe(true);

      await expect(
        runFakePayoutPipeline(pool, engineConfig, withdrawalId, 'CONFIRMED_SUCCESS'),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });

    const settlements = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND business_reference_id = $1::uuid`,
      [withdrawalId],
    );
    expect(settlements.rows[0]?.c).toBe('1');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
  }, 180_000);

  it('one confirmed economic settlement via Temporal path', async () => {
    const { userId, withdrawalId } = await prepareApprovedWithdrawal('7507');
    await approveWithdrawal(pool, adminUserId, withdrawalId);
    registerFakePayoutScenario(withdrawalId, 'CONFIRMED_SUCCESS');

    const taskQueue = nextTaskQueue();
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: createTestWithdrawalActivities(pool),
    });

    await worker.runUntil(async () => {
      await processWithdrawalApprovedOutboxBatch(pool, {
        client: testEnv.client,
        taskQueue,
        fakeChainEnabled: true,
      });
      await expect(
        testEnv.client.workflow.getHandle(withdrawalWorkflowId(withdrawalId)).result(),
      ).resolves.toMatchObject({ state: 'CONFIRMED' });
    });

    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(state.rows[0]?.state).toBe('CONFIRMED');
    const settlements = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM ledger_transactions
       WHERE transaction_type = 'WITHDRAWAL_SETTLEMENT'
         AND business_reference_id = $1::uuid`,
      [withdrawalId],
    );
    expect(settlements.rows[0]?.c).toBe('1');
    expect(await userBucketBalance(pool, userId, assetId, 'USER_RESERVED_LIABILITY')).toBe(0n);
  }, 180_000);

  it('duplicate workflow start cannot second-attempt payout', async () => {
    const { withdrawalId } = await prepareApprovedWithdrawal('7508');
    await approveWithdrawal(pool, adminUserId, withdrawalId);
    registerFakePayoutScenario(withdrawalId, 'CONFIRMED_SUCCESS');

    const taskQueue = nextTaskQueue();
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: createTestWithdrawalActivities(pool),
    });

    await worker.runUntil(async () => {
      await testEnv.client.workflow.start(WITHDRAWAL_PAYOUT_WORKFLOW_TYPE, {
        taskQueue,
        workflowId: withdrawalWorkflowId(withdrawalId),
        args: [{ withdrawalId }],
        workflowIdReusePolicy: 'REJECT_DUPLICATE',
        workflowIdConflictPolicy: 'FAIL',
      });
      await testEnv.client.workflow.getHandle(withdrawalWorkflowId(withdrawalId)).result();

      await expect(
        testEnv.client.workflow.start(WITHDRAWAL_PAYOUT_WORKFLOW_TYPE, {
          taskQueue,
          workflowId: withdrawalWorkflowId(withdrawalId),
          args: [{ withdrawalId }],
          workflowIdReusePolicy: 'REJECT_DUPLICATE',
          workflowIdConflictPolicy: 'FAIL',
        }),
      ).rejects.toBeInstanceOf(WorkflowExecutionAlreadyStartedError);

      const attempts = await pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
        [withdrawalId],
      );
      expect(attempts.rows[0]?.c).toBe('1');
    });
  }, 180_000);
});
