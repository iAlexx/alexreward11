import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireTestDispatchLease,
  createWithdrawalAttempt,
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

describe.skipIf(phase7DatabaseUrl === '')('phase10 lease fencing', () => {
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

  it('competing leases: stale fencing cannot create attempt', async () => {
    const userId = await createTestUser(pool, '9201');
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
      const lease1 = await acquireTestDispatchLease(client, hotWalletId, 'worker-a');
      const lease2 = await acquireTestDispatchLease(client, hotWalletId, 'worker-b');
      expect(lease2.fencingToken).toBeGreaterThan(lease1.fencingToken);

      await expect(
        createWithdrawalAttempt(client, {
          withdrawalId,
          hotWalletId,
          fencingToken: lease1.fencingToken,
          signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
          scenarioHashInputs: { scenario: 'stale-fence' },
        }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

      const attempt = await createWithdrawalAttempt(client, {
        withdrawalId,
        hotWalletId,
        fencingToken: lease2.fencingToken,
        signerKeyReference: 'TEST_ONLY_FAKE_HOT_1',
        scenarioHashInputs: { scenario: 'winner' },
      });
      expect(attempt.dispatchFencingToken).toBe(lease2.fencingToken.toString(10));
    });
  });
});
