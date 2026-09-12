import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeTonChainProvider } from '@alex-rewards/ton';

import {
  buildPhase10PayoutConfig,
  listPhase10MissingResources,
  localWithdrawalEngineFixtureConfig,
  runRealTestnetPayoutPipeline,
  type RealPayoutSignerPort,
} from '../src/index.js';
import {
  createApprovedWithdrawal,
  createTestUser,
  createVerifiedPrimaryWallet,
  ensureEncryptedPayoutHotWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

const PAYOUT_JETTON_WALLET = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT_RAW = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HOT_WALLET_RAW = '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const ENCRYPTED_SIGNER_REF = 'phase10-pipeline-encrypted-ref';
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const TEST_CANONICAL_HASH = '22'.repeat(32);
const nonFakeEngine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

describe('phase10 real pipeline gate (no skeleton throw)', () => {
  it('lists dual-provider Owner resources and does not use single shared API key', () => {
    const config = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'x'.repeat(32),
      jettonMasterIdentity: 'EQ_owner_approved_testnet_jetton',
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      primaryProviderApiKey: 'primary-only',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
      secondaryProviderApiKey: 'secondary-only',
    });
    expect(config.primaryProvider.apiKey).toBe('primary-only');
    expect(config.secondaryProvider.apiKey).toBe('secondary-only');
    expect(listPhase10MissingResources(config)).toEqual([]);
  });

  it('blocks incomplete Owner resources without claiming path not provisioned as code hole', () => {
    const missing = listPhase10MissingResources(
      buildPhase10PayoutConfig({ realChainEnabled: false }),
    );
    expect(missing.some((m) => m.includes('WITHDRAWAL_REAL_CHAIN_ENABLED'))).toBe(true);
    expect(missing.some((m) => m.includes('TON_PRIMARY_PROVIDER_KIND'))).toBe(true);
    expect(missing.some((m) => m.includes('TON_SECONDARY_PROVIDER_KIND'))).toBe(true);
  });
});

describe.skipIf(phase7DatabaseUrl === '')('phase10 real pipeline (db + fake providers)', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let jettonMaster: string;

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
    // Seed encrypted payout Hot Wallet BEFORE quote/create (non-fake path).
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase10_test_hot',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });

    const master = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = master.rows[0]!.contract_identity;
  });

  function createTestSigner(): RealPayoutSignerPort {
    return {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: 'fp-test',
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: true,
          custodyState: 'n/a',
        };
      },
      async signWithdrawalAttempt(withdrawalAttemptId: string) {
        const row = await pool.query<{
          withdrawal_id: string;
          canonical_message_hash: string;
        }>(
          `SELECT withdrawal_id::text AS withdrawal_id, canonical_message_hash
           FROM withdrawal_attempts WHERE id = $1::uuid`,
          [withdrawalAttemptId],
        );
        const attempt = row.rows[0];
        if (attempt === undefined) {
          throw new Error('attempt missing for mock signer');
        }
        return {
          withdrawalAttemptId,
          withdrawalId: attempt.withdrawal_id,
          canonicalMessageHash: attempt.canonical_message_hash,
          canonicalSigningHash: attempt.canonical_message_hash,
          signedMessageHash: '33'.repeat(32),
          publicKeyFingerprint: 'fp-test',
          walletAddressRaw: HOT_WALLET_RAW,
          signatureBase64: 'dGVzdC1zaWc=',
          keySpec: 'TEST_ONLY',
          signingAlgorithm: 'ED25519_SHA_512',
          signedWalletRequestBocBase64: 'dGVzdC13YWxsZXQtcmVxdWVzdA==',
          externalMessageBocBase64: 'dGVzdC1ib2MtYmFzZTY0',
          externalMessageCellHash: '44'.repeat(32),
          normalizedExternalMessageHash: '33'.repeat(32),
          signatureFingerprintHash: '55'.repeat(32),
        };
      },
    };
  }

  it('runs full non-fake stages to CONFIRMED with fake providers (no real broadcast)', async () => {
    const userId = await createTestUser(pool, '9201');
    await createVerifiedPrimaryWallet(pool, {
      userId,
      networkId,
      rawAddress: RECIPIENT_RAW,
    });
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
      engineConfig: nonFakeEngine,
    });
    const assignedHot = await pool.query<{ hot_wallet_id: string }>(
      `SELECT hot_wallet_id::text AS hot_wallet_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(assignedHot.rows[0]!.hot_wallet_id).toBe(hotWalletId);
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const w = await pool.query<{ net_amount_atomic: string }>(
      `SELECT net_amount_atomic::text AS net_amount_atomic FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const netAmount = w.rows[0]!.net_amount_atomic;

    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedSeqno(HOT_WALLET_RAW, 7);

    const attemptNumber = 1;
    const queryId =
      (BigInt(attemptNumber) << 32n) +
      BigInt(
        Math.abs(
          [...`${withdrawalId}:${RECIPIENT_RAW}`].reduce(
            (a, c) => (a * 31 + c.charCodeAt(0)) | 0,
            7,
          ),
        ),
      );
    const evidence = {
      hotWallet: HOT_WALLET_RAW,
      jettonMaster,
      recipient: RECIPIENT_RAW,
      amountAtomic: netAmount,
      queryId: queryId.toString(10),
      success: true,
      bounced: false,
      networkGlobalId: -3 as const,
      senderJettonWallet: PAYOUT_JETTON_WALLET,
    };
    primary.seedTransfer(evidence);
    secondary.seedTransfer(evidence);

    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });

    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('CONFIRMED');
    expect(result.attemptId).not.toBeNull();
    expect(result.seqno).toBe(7);
    expect(primary.getSendBocCallCount()).toBe(1);
    expect(result.stagesCompleted).toEqual(
      expect.arrayContaining([
        'fenced_dispatcher_lease',
        'authoritative_wallet_seqno',
        'immutable_payout_attempt',
        'signer_attempt_id_signing',
        'persist_signed_boc_before_send',
        'provider_sendBoc',
        'full_tep74_proof_primary_secondary',
        'idempotent_confirmed_finalization',
      ]),
    );

    const attempt = await pool.query<{
      signed_external_message_boc: string | null;
      broadcast_submitted_at: Date | null;
      canonical_message_hash: string;
      expected_seqno: string;
    }>(
      `SELECT signed_external_message_boc, broadcast_submitted_at, canonical_message_hash,
              expected_seqno::text
       FROM withdrawal_attempts WHERE id = $1::uuid`,
      [result.attemptId],
    );
    expect(attempt.rows[0]?.signed_external_message_boc).toBeTruthy();
    expect(attempt.rows[0]?.broadcast_submitted_at).toBeTruthy();
    expect(attempt.rows[0]?.canonical_message_hash).toBe(TEST_CANONICAL_HASH);
    expect(attempt.rows[0]?.expected_seqno).toBe('7');

    const withdrawal = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(withdrawal.rows[0]?.state).toBe('CONFIRMED');
  });

  it('classifies send timeout as RECONCILE_REQUIRED without blind resend', async () => {
    const userId = await createTestUser(pool, '9202');
    await createVerifiedPrimaryWallet(pool, {
      userId,
      networkId,
      rawAddress: RECIPIENT_RAW,
    });
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
      engineConfig: nonFakeEngine,
    });
    const assignedHot = await pool.query<{ hot_wallet_id: string }>(
      `SELECT hot_wallet_id::text AS hot_wallet_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(assignedHot.rows[0]!.hot_wallet_id).toBe(hotWalletId);
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const primary = new FakeTonChainProvider({ sendBocTimeout: true });
    primary.seedSeqno(HOT_WALLET_RAW, 3);

    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });

    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: new FakeTonChainProvider(),
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('RECONCILE_REQUIRED');
    expect(primary.getSendBocCallCount()).toBe(1);
    expect(result.stagesCompleted).toEqual(
      expect.arrayContaining(['persist_signed_boc_before_send', 'provider_sendBoc_ambiguous']),
    );
  });
});
