import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireTestDispatchLease,
  assertBlindResendForbidden,
  classifySubmitError,
  createWithdrawalAttempt,
  markBroadcastSubmitted,
  persistPreBroadcastEvidence,
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

describe('phase10 broadcast gate (unit classify)', () => {
  it('classifies timeout as UNKNOWN/RPC_TIMEOUT', () => {
    const c = classifySubmitError(new Error('RPC_TIMEOUT from provider'));
    expect(c.kind).toBe('UNKNOWN');
    if (c.kind === 'UNKNOWN') expect(c.ambiguityClass).toBe('RPC_TIMEOUT');
  });

  it('classifies pre-submit as FAILED_PRE_BROADCAST', () => {
    expect(classifySubmitError(new Error('PRE_SUBMIT rejected')).kind).toBe('FAILED_PRE_BROADCAST');
  });
});

describe.skipIf(phase7DatabaseUrl === '')('phase10 broadcast gate (db)', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;

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

  it('persists signed boc before broadcast and forbids blind resend after submit', async () => {
    const userId = await createTestUser(pool, '9101');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    await withWithdrawalTransaction(pool, async (client) => {
      const lease = await acquireTestDispatchLease(client, hotWalletId, 'phase10-gate');
      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId,
        hotWalletId,
        fencingToken: lease.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
      });

      await persistPreBroadcastEvidence(client, {
        attemptId: attempt.id,
        signedExternalMessageBoc: 'dGVzdC1ib2M=',
        signedMessageHash: 'a'.repeat(64),
      });

      const stored = await client.query<{
        signed_external_message_boc: string | null;
        broadcast_submitted_at: Date | null;
      }>(
        `SELECT signed_external_message_boc, broadcast_submitted_at
         FROM withdrawal_attempts WHERE id = $1::uuid`,
        [attempt.id],
      );
      expect(stored.rows[0]?.signed_external_message_boc).toBe('dGVzdC1ib2M=');
      expect(stored.rows[0]?.broadcast_submitted_at).toBeNull();

      await markBroadcastSubmitted(client, {
        attemptId: attempt.id,
        broadcastResultState: 'UNKNOWN',
        ambiguityClass: 'RPC_TIMEOUT',
      });

      await expect(assertBlindResendForbidden(client, attempt.id)).rejects.toMatchObject({
        code: 'RECONCILE_REQUIRED',
      });

      await expect(
        persistPreBroadcastEvidence(client, {
          attemptId: attempt.id,
          signedExternalMessageBoc: 'cmVzZW5k',
          signedMessageHash: 'b'.repeat(64),
        }),
      ).rejects.toMatchObject({ code: 'RECONCILE_REQUIRED' });
    });
  });
});
