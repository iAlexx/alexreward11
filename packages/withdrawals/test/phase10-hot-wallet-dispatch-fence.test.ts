import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireHotWalletDispatchLease,
  assertHotWalletDispatchFence,
  createWithdrawalAttempt,
  hotWalletDispatchOwnerIdentity,
  releaseHotWalletDispatchLease,
  updateAttemptBroadcastState,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  bindVerifiedPrimaryWallet,
  createApprovedWithdrawal,
  createTestUser,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

describe.skipIf(phase7DatabaseUrl === '')('phase10 hot wallet dispatch lease (Owner 1–10)', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let seq = 9700;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
  });

  async function approvedWithdrawal(): Promise<string> {
    const userId = await createTestUser(pool, String(++seq));
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    return createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
  }

  it('1: A holds active lease → B cannot steal (BUSY)', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    await withWithdrawalTransaction(pool, async (client) => {
      const first = await acquireHotWalletDispatchLease(
        client,
        hotWalletId,
        hotWalletDispatchOwnerIdentity(a),
      );
      expect(first.status).toBe('ACQUIRED');
      const second = await acquireHotWalletDispatchLease(
        client,
        hotWalletId,
        hotWalletDispatchOwnerIdentity(b),
      );
      expect(second).toMatchObject({
        status: 'BUSY',
        reason: 'ACTIVE_LEASE_HELD_BY_OTHER',
      });
      if (first.status === 'ACQUIRED') {
        expect(second.status === 'BUSY' ? second.fencingToken : undefined).toBe(first.fencingToken);
      }
    });
  });

  it('2: same-owner renewal is safe (token stable)', async () => {
    const a = await approvedWithdrawal();
    const owner = hotWalletDispatchOwnerIdentity(a);
    await withWithdrawalTransaction(pool, async (client) => {
      const first = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(first.status).toBe('ACQUIRED');
      const renewed = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(renewed.status).toBe('ACQUIRED');
      if (first.status === 'ACQUIRED' && renewed.status === 'ACQUIRED') {
        expect(renewed.fencingToken).toBe(first.fencingToken);
        expect(renewed.renewed).toBe(true);
        expect(renewed.tokenIncremented).toBe(false);
        expect(renewed.expiresAt.getTime()).toBeGreaterThanOrEqual(first.expiresAt.getTime());
      }
    });
  });

  it('3: expired/released takeover increments token', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    const ownerA = hotWalletDispatchOwnerIdentity(a);
    const ownerB = hotWalletDispatchOwnerIdentity(b);
    await withWithdrawalTransaction(pool, async (client) => {
      const first = await acquireHotWalletDispatchLease(client, hotWalletId, ownerA);
      expect(first.status).toBe('ACQUIRED');
      if (first.status !== 'ACQUIRED') return;
      await releaseHotWalletDispatchLease(client, {
        hotWalletId,
        ownerIdentity: ownerA,
        fencingToken: first.fencingToken,
        reason: 'FAILED_PRE_BROADCAST',
      });
      const takeover = await acquireHotWalletDispatchLease(client, hotWalletId, ownerB);
      expect(takeover.status).toBe('ACQUIRED');
      if (takeover.status === 'ACQUIRED') {
        expect(takeover.fencingToken).toBe(first.fencingToken + 1n);
        expect(takeover.tokenIncremented).toBe(true);
      }
    });
  });

  it('4: stale fence cannot enter submit/send boundary after newer owner', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    const ownerA = hotWalletDispatchOwnerIdentity(a);
    const ownerB = hotWalletDispatchOwnerIdentity(b);
    await withWithdrawalTransaction(pool, async (client) => {
      const leaseA = await acquireHotWalletDispatchLease(client, hotWalletId, ownerA);
      expect(leaseA.status).toBe('ACQUIRED');
      if (leaseA.status !== 'ACQUIRED') return;
      const attemptA = await createWithdrawalAttempt(client, {
        withdrawalId: a,
        hotWalletId,
        fencingToken: leaseA.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: ownerA,
        scenarioHashInputs: { scenario: 'stale-a' },
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attemptA.id,
        broadcastResultState: 'FAILED_PRE_BROADCAST',
      });
      await releaseHotWalletDispatchLease(client, {
        hotWalletId,
        ownerIdentity: ownerA,
        fencingToken: leaseA.fencingToken,
        reason: 'FAILED_PRE_BROADCAST',
      });

      const leaseB = await acquireHotWalletDispatchLease(client, hotWalletId, ownerB);
      expect(leaseB.status).toBe('ACQUIRED');
      if (leaseB.status !== 'ACQUIRED') return;

      await expect(
        assertHotWalletDispatchFence(client, {
          hotWalletId,
          fencingToken: leaseA.fencingToken,
          ownerIdentity: ownerA,
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

      await assertHotWalletDispatchFence(client, {
        hotWalletId,
        fencingToken: leaseB.fencingToken,
        ownerIdentity: ownerB,
      });
    });
  });

  it('5: UNKNOWN attempt from A blocks unrelated B', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    const ownerA = hotWalletDispatchOwnerIdentity(a);
    const ownerB = hotWalletDispatchOwnerIdentity(b);
    await withWithdrawalTransaction(pool, async (client) => {
      const leaseA = await acquireHotWalletDispatchLease(client, hotWalletId, ownerA);
      expect(leaseA.status).toBe('ACQUIRED');
      if (leaseA.status !== 'ACQUIRED') return;
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId: a,
        hotWalletId,
        fencingToken: leaseA.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: ownerA,
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'UNKNOWN',
        markBroadcastStarted: true,
      });
      await client.query(
        `UPDATE hot_wallet_dispatch_leases
         SET acquired_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute',
             released_at = NULL
         WHERE hot_wallet_id = $1::uuid`,
        [hotWalletId],
      );
      const blocked = await acquireHotWalletDispatchLease(client, hotWalletId, ownerB);
      expect(blocked.status).toBe('BLOCKED_UNRESOLVED');
    });
  });

  it('6: RECONCILE_REQUIRED from A blocks unrelated B', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    const ownerA = hotWalletDispatchOwnerIdentity(a);
    const ownerB = hotWalletDispatchOwnerIdentity(b);
    await withWithdrawalTransaction(pool, async (client) => {
      const leaseA = await acquireHotWalletDispatchLease(client, hotWalletId, ownerA);
      expect(leaseA.status).toBe('ACQUIRED');
      if (leaseA.status !== 'ACQUIRED') return;
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId: a,
        hotWalletId,
        fencingToken: leaseA.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: ownerA,
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'RECONCILE_REQUIRED',
        markBroadcastStarted: true,
      });
      await client.query(
        `UPDATE hot_wallet_dispatch_leases
         SET acquired_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute'
         WHERE hot_wallet_id = $1::uuid`,
        [hotWalletId],
      );
      const blocked = await acquireHotWalletDispatchLease(client, hotWalletId, ownerB);
      expect(blocked.status).toBe('BLOCKED_UNRESOLVED');
    });
  });

  it('7: definitive non-payment allows B', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    const ownerA = hotWalletDispatchOwnerIdentity(a);
    const ownerB = hotWalletDispatchOwnerIdentity(b);
    await withWithdrawalTransaction(pool, async (client) => {
      const leaseA = await acquireHotWalletDispatchLease(client, hotWalletId, ownerA);
      expect(leaseA.status).toBe('ACQUIRED');
      if (leaseA.status !== 'ACQUIRED') return;
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId: a,
        hotWalletId,
        fencingToken: leaseA.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: ownerA,
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'UNKNOWN',
        markBroadcastStarted: true,
      });
      await client.query(
        `INSERT INTO withdrawal_payout_reconciliations (
           withdrawal_id, withdrawal_attempt_id, resolution, evidence_summary, resolved_at
         ) VALUES ($1::uuid, $2::uuid, 'DEFINITIVE_NONPAYMENT', '{}'::jsonb, now())`,
        [a, attempt.id],
      );
      await releaseHotWalletDispatchLease(client, {
        hotWalletId,
        ownerIdentity: ownerA,
        fencingToken: leaseA.fencingToken,
        reason: 'DEFINITIVE_NONPAYMENT',
      });
      const next = await acquireHotWalletDispatchLease(client, hotWalletId, ownerB);
      expect(next.status).toBe('ACQUIRED');
    });
  });

  it('8: confirmed/settled A allows B', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    const ownerA = hotWalletDispatchOwnerIdentity(a);
    const ownerB = hotWalletDispatchOwnerIdentity(b);
    await withWithdrawalTransaction(pool, async (client) => {
      const leaseA = await acquireHotWalletDispatchLease(client, hotWalletId, ownerA);
      expect(leaseA.status).toBe('ACQUIRED');
      if (leaseA.status !== 'ACQUIRED') return;
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId: a,
        hotWalletId,
        fencingToken: leaseA.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: ownerA,
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'BROADCASTED',
        markBroadcastStarted: true,
      });
      // Minimal settlement marker for unresolved-work filter (ledger tx optional for lease gate).
      await client.query(
        `UPDATE withdrawal_attempts SET settled_at = now(), broadcast_result_state = 'BROADCASTED'
         WHERE id = $1::uuid`,
        [attempt.id],
      );
      await client.query(
        `UPDATE withdrawals
         SET state = 'CONFIRMED', confirmed_at = now(),
             settlement_ledger_tx_id = reservation_ledger_tx_id, updated_at = now()
         WHERE id = $1::uuid`,
        [a],
      );
      await releaseHotWalletDispatchLease(client, {
        hotWalletId,
        ownerIdentity: ownerA,
        fencingToken: leaseA.fencingToken,
        reason: 'CONFIRMED_SETTLED',
      });
      const next = await acquireHotWalletDispatchLease(client, hotWalletId, ownerB);
      expect(next.status).toBe('ACQUIRED');
    });
  });

  it('9: crash before submit + same-withdrawal recovery can safely reacquire', async () => {
    const a = await approvedWithdrawal();
    const owner = hotWalletDispatchOwnerIdentity(a);
    await withWithdrawalTransaction(pool, async (client) => {
      const first = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(first.status).toBe('ACQUIRED');
      if (first.status !== 'ACQUIRED') return;
      await createWithdrawalAttempt(client, {
        withdrawalId: a,
        hotWalletId,
        fencingToken: first.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        leaseOwnerIdentity: owner,
      });
      // Expire lease (crash) without broadcast evidence.
      await client.query(
        `UPDATE hot_wallet_dispatch_leases
         SET acquired_at = now() - interval '2 minutes',
             expires_at = now() - interval '1 minute',
             released_at = NULL
         WHERE hot_wallet_id = $1::uuid`,
        [hotWalletId],
      );
      const recovered = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(recovered.status).toBe('ACQUIRED');
      if (recovered.status === 'ACQUIRED') {
        expect(recovered.fencingToken).toBe(first.fencingToken);
        expect(recovered.tokenIncremented).toBe(false);
      }
    });
  });

  it('10: no two concurrent payouts obtain usable Hot Wallet broadcast authority', async () => {
    const a = await approvedWithdrawal();
    const b = await approvedWithdrawal();
    const ownerA = hotWalletDispatchOwnerIdentity(a);
    const ownerB = hotWalletDispatchOwnerIdentity(b);

    const results = await Promise.all([
      withWithdrawalTransaction(pool, async (client) =>
        acquireHotWalletDispatchLease(client, hotWalletId, ownerA),
      ),
      withWithdrawalTransaction(pool, async (client) =>
        acquireHotWalletDispatchLease(client, hotWalletId, ownerB),
      ),
    ]);

    const acquired = results.filter((r) => r.status === 'ACQUIRED');
    const busy = results.filter((r) => r.status === 'BUSY');
    expect(acquired.length).toBe(1);
    expect(busy.length).toBe(1);
  });
});
