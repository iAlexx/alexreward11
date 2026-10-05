/**
 * Proposed isolated aalex fee/limit rules — pure + disposable fixture validation.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PROPOSED_ISOLATED_AALEX_WITHDRAWAL,
  createWithdrawalQuote,
  localWithdrawalEngineFixtureConfig,
  seedProposedIsolatedAalexWithdrawalRules,
  validateOneAalexUnderProposedRules,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  bindVerifiedPrimaryWallet,
  createTestUser,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

describe('proposed isolated aalex fee/limit (pure)', () => {
  it('1 aalex gross is valid under proposed rules with positive net', () => {
    const result = validateOneAalexUnderProposedRules();
    expect(result.valid).toBe(true);
    expect(result.grossAtomic).toBe('1000000000');
    expect(result.feeAtomic).toBe('10000000');
    expect(result.netAtomic).toBe('990000000');
  });

  it('proposed min equals one aalex and fee is strictly less than min', () => {
    expect(PROPOSED_ISOLATED_AALEX_WITHDRAWAL.minWithdrawalAtomic).toBe(1_000_000_000n);
    expect(PROPOSED_ISOLATED_AALEX_WITHDRAWAL.fixedFeeAtomic).toBeLessThan(
      PROPOSED_ISOLATED_AALEX_WITHDRAWAL.minWithdrawalAtomic,
    );
    expect(PROPOSED_ISOLATED_AALEX_WITHDRAWAL.maxAutoPayoutAtomic).toBeNull();
  });
});

describe.skipIf(phase7DatabaseUrl === '')('proposed isolated aalex fee/limit (fixture quote)', () => {
  let pool: Pool;
  let networkId: string;
  let aalexAssetId: string;

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
    networkId = base.networkId;

    await pool.query(`DELETE FROM assets WHERE symbol = 'aalex' AND network_id = $1::uuid`, [
      networkId,
    ]);
    const asset = await pool.query<{ id: string }>(
      `INSERT INTO assets (
         network_id, symbol, name, decimals, is_native, contract_identity, status
       ) VALUES (
         $1::uuid, 'aalex', 'Isolated aalex', 9, false,
         $2, 'ACTIVE'
       )
       RETURNING id`,
      [networkId, PROPOSED_ISOLATED_AALEX_WITHDRAWAL.contractIdentity],
    );
    aalexAssetId = asset.rows[0]!.id;

    await withWithdrawalTransaction(pool, async (client) => {
      await seedProposedIsolatedAalexWithdrawalRules(client, {
        assetId: aalexAssetId,
        networkId,
      });
    });
  });

  it('quotes exactly 1 aalex under proposed rules', async () => {
    const userId = await createTestUser(pool, '981001');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    const quote = await createWithdrawalQuote(
      pool,
      localWithdrawalEngineFixtureConfig({ usdtSymbol: 'aalex', fakeChainEnabled: true }),
      {
        authenticatedUserId: userId,
        amountAtomic: '1000000000',
      },
    );
    expect(quote.requestedAmountAtomic).toBe('1000000000');
    expect(quote.feeAmountAtomic).toBe('10000000');
    expect(quote.netAmountAtomic).toBe('990000000');
    expect(quote.assetId).toBe(aalexAssetId);
  });

  it('rejects gross below proposed aalex minimum', async () => {
    const userId = await createTestUser(pool, '981002');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    await expect(
      createWithdrawalQuote(
        pool,
        localWithdrawalEngineFixtureConfig({ usdtSymbol: 'aalex', fakeChainEnabled: true }),
        {
          authenticatedUserId: userId,
          amountAtomic: '999999999',
        },
      ),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  });

  it('USDT locked rules still quote after aalex seed coexistence', async () => {
    const userId = await createTestUser(pool, '981003');
    await bindVerifiedPrimaryWallet(pool, userId, networkId);

    const quote = await createWithdrawalQuote(
      pool,
      localWithdrawalEngineFixtureConfig({ usdtSymbol: 'USDT', fakeChainEnabled: true }),
      {
        authenticatedUserId: userId,
        amountAtomic: '200000',
      },
    );
    expect(quote.feeAmountAtomic).toBe('10000');
    expect(quote.netAmountAtomic).toBe('190000');
  });
});
