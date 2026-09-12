import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  localWithdrawalEngineFixtureConfig,
  resolveSinglePayoutHotWallet,
  WithdrawalDomainError,
  withWithdrawalTransaction,
} from '../src/index.js';
import {
  createTestUser,
  createVerifiedPrimaryWallet,
  ensureEncryptedPayoutHotWallet,
  ensureTestHotWallet,
  fundUserAvailable,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

const ENCRYPTED_ADDR = '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ENCRYPTED_REF = 'phase10-resolve-encrypted-fingerprint';
const JETTON = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe.skipIf(phase7DatabaseUrl === '')('phase10 payout Hot Wallet resolve (mode-specific)', () => {
  let pool: Pool;
  let networkId: string;
  let assetId: string;

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
    assetId = base.assetId;
  });

  it('fake=true + exactly one ACTIVE TEST_ONLY_FAKE% → selected', async () => {
    const hotId = await ensureTestHotWallet(pool, networkId);
    const resolved = await withWithdrawalTransaction(pool, async (client) =>
      resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: true }),
    );
    expect(resolved.id).toBe(hotId);
  });

  it('fake=true + only FALLBACK_ENCRYPTED → rejected', async () => {
    await pool.query(
      `UPDATE hot_wallets SET status = 'RETIRED', retired_at = now()
       WHERE network_id = $1::uuid AND status = 'ACTIVE'`,
      [networkId],
    );
    await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: ENCRYPTED_ADDR,
      friendlyAddress: 'EQ_encrypted_only',
      signerReference: ENCRYPTED_REF,
      payoutJettonWalletAddress: JETTON,
    });
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: true }),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIG',
      message: expect.stringMatching(/No eligible test Hot Wallet/),
    });
  });

  it('fake=false + exactly one ACTIVE FALLBACK_ENCRYPTED → selected', async () => {
    const hotId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: ENCRYPTED_ADDR,
      friendlyAddress: 'EQ_encrypted_one',
      signerReference: ENCRYPTED_REF,
      payoutJettonWalletAddress: JETTON,
    });
    const resolved = await withWithdrawalTransaction(pool, async (client) =>
      resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: false }),
    );
    expect(resolved.id).toBe(hotId);
  });

  it('fake=false + only TEST_ONLY_FAKE% → rejected', async () => {
    await ensureTestHotWallet(pool, networkId);
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: false }),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIG',
      message: expect.stringMatching(/No eligible encrypted payout Hot Wallet/),
    });
  });

  it('zero eligible wallets → rejected (both modes)', async () => {
    await pool.query(
      `UPDATE hot_wallets SET status = 'RETIRED', retired_at = now()
       WHERE network_id = $1::uuid AND status = 'ACTIVE'`,
      [networkId],
    );
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: true }),
      ),
    ).rejects.toBeInstanceOf(WithdrawalDomainError);
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: false }),
      ),
    ).rejects.toBeInstanceOf(WithdrawalDomainError);
  });

  it('multiple mode-eligible ACTIVE wallets → rejected', async () => {
    await ensureTestHotWallet(pool, networkId);
    const address2 = `0:hot${randomUUID().replace(/-/g, '').slice(0, 60)}`;
    await pool.query(
      `INSERT INTO hot_wallets (
         network_id, address, friendly_address, wallet_version,
         signer_type, signer_reference, status, label
       ) VALUES (
         $1::uuid, $2, $3, 'v5R1',
         'KMS', 'TEST_ONLY_FAKE_HOT_2', 'ACTIVE', 'phase7-test-hot-2'
       )`,
      [networkId, address2, `EQ${address2.slice(2, 50)}`],
    );
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: true }),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIG',
      message: expect.stringMatching(/Ambiguous eligible test Hot Wallets/),
    });

    await pool.query(
      `UPDATE hot_wallets SET status = 'RETIRED', retired_at = now()
       WHERE network_id = $1::uuid AND status = 'ACTIVE'`,
      [networkId],
    );
    await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: ENCRYPTED_ADDR,
      friendlyAddress: 'EQ_enc_a',
      signerReference: `${ENCRYPTED_REF}-a`,
      payoutJettonWalletAddress: JETTON,
    });
    const addressEnc2 = '0:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    await pool.query(
      `INSERT INTO hot_wallets (
         network_id, address, friendly_address, wallet_version,
         signer_type, signer_reference, status, payout_jetton_wallet_address, label
       ) VALUES (
         $1::uuid, $2, $3, 'v5R1',
         'FALLBACK_ENCRYPTED', $4, 'ACTIVE', $5, 'phase10-encrypted-2'
       )`,
      [networkId, addressEnc2, 'EQ_enc_b', `${ENCRYPTED_REF}-b`, JETTON],
    );
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        resolveSinglePayoutHotWallet(client, networkId, { fakeChainEnabled: false }),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIG',
      message: expect.stringMatching(/Ambiguous eligible encrypted payout Hot Wallets/),
    });
  });

  it('quote+create with fake=false selects and freezes encrypted hot_wallet_id', async () => {
    const encryptedId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: ENCRYPTED_ADDR,
      friendlyAddress: 'EQ_quote_create_enc',
      signerReference: ENCRYPTED_REF,
      payoutJettonWalletAddress: JETTON,
    });
    const userId = await createTestUser(pool, '9401');
    await createVerifiedPrimaryWallet(pool, { userId, networkId });
    await fundUserAvailable({
      pool,
      userId,
      assetId,
      amountAtomic: '5000000',
      key: randomUUID(),
    });

    const nonFake = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });
    const quote = await createWithdrawalQuote(pool, nonFake, {
      authenticatedUserId: userId,
      amountAtomic: '200000',
    });
    const withdrawal = await createWithdrawalFromQuote(pool, nonFake, {
      authenticatedUserId: userId,
      quoteId: quote.id,
      idempotencyKey: randomUUID(),
    });

    const row = await pool.query<{ hot_wallet_id: string; signer_type: string }>(
      `SELECT w.hot_wallet_id::text AS hot_wallet_id, hw.signer_type::text AS signer_type
       FROM withdrawals w
       INNER JOIN hot_wallets hw ON hw.id = w.hot_wallet_id
       WHERE w.id = $1::uuid`,
      [withdrawal.id],
    );
    expect(row.rows[0]?.hot_wallet_id).toBe(encryptedId);
    expect(row.rows[0]?.signer_type).toBe('FALLBACK_ENCRYPTED');
  });
});
