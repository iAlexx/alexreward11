import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';

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
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');
const HOT_WALLET_RAW = deriveWalletV5R1AddressRaw({
  publicKeyHex: TEST_PUBLIC_KEY_HEX,
  networkGlobalId: -3,
});
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
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
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
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
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
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 7,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 7,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

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

    const reservedBefore = await pool.query<{ b: string }>(
      `SELECT lab.balance_atomic::text AS b
       FROM ledger_accounts la
       JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       WHERE la.owner_id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [userId],
    );
    expect(BigInt(reservedBefore.rows[0]?.b ?? '0')).toBeGreaterThan(0n);

    const primary = new FakeTonChainProvider({ sendBocTimeout: true });
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 3,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 3,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

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

    expect(result.state).toBe('RECONCILE_REQUIRED');
    expect(primary.getSendBocCallCount()).toBe(1);
    expect(result.stagesCompleted).toEqual(
      expect.arrayContaining(['persist_signed_boc_before_send', 'provider_sendBoc_ambiguous']),
    );

    const attempt = await pool.query<{
      c: number;
      query_id: string | null;
      broadcast_result_state: string | null;
      broadcast_ambiguity_class: string | null;
      broadcast_submitted_at: Date | null;
      signing_started_at: Date | null;
      signed_external_message_boc: string | null;
      signed_wallet_request_boc: string | null;
      canonical_message_hash: string | null;
      normalized_external_message_hash: string | null;
      external_message_cell_hash: string | null;
    }>(
      `SELECT COUNT(*)::int AS c,
              MAX(query_id::text) AS query_id,
              MAX(broadcast_result_state::text) AS broadcast_result_state,
              MAX(broadcast_ambiguity_class) AS broadcast_ambiguity_class,
              MAX(broadcast_submitted_at) AS broadcast_submitted_at,
              MAX(signing_started_at) AS signing_started_at,
              MAX(signed_external_message_boc) AS signed_external_message_boc,
              MAX(signed_wallet_request_boc) AS signed_wallet_request_boc,
              MAX(canonical_message_hash) AS canonical_message_hash,
              MAX(normalized_external_message_hash) AS normalized_external_message_hash,
              MAX(external_message_cell_hash) AS external_message_cell_hash
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempt.rows[0]?.c).toBe(1);
    expect(attempt.rows[0]?.query_id).toBeTruthy();
    expect(attempt.rows[0]?.signing_started_at).toBeTruthy();
    expect(attempt.rows[0]?.signed_external_message_boc).toBeTruthy();
    expect(attempt.rows[0]?.signed_wallet_request_boc).toBeTruthy();
    expect(attempt.rows[0]?.canonical_message_hash).toBe(TEST_CANONICAL_HASH);
    expect(attempt.rows[0]?.normalized_external_message_hash).toBeTruthy();
    expect(attempt.rows[0]?.external_message_cell_hash).toBeTruthy();
    expect(attempt.rows[0]?.broadcast_submitted_at).toBeTruthy();
    expect(attempt.rows[0]?.broadcast_result_state).toBe('UNKNOWN');
    expect(attempt.rows[0]?.broadcast_ambiguity_class).toBe('RPC_TIMEOUT');

    const withdrawal = await pool.query<{
      state: string;
      settlement: string | null;
      confirmed_at: Date | null;
      release: string | null;
    }>(
      `SELECT state::text AS state,
              settlement_ledger_tx_id::text AS settlement,
              confirmed_at,
              release_ledger_tx_id::text AS release
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(withdrawal.rows[0]?.state).toBe('RECONCILE_REQUIRED');
    expect(withdrawal.rows[0]?.settlement).toBeNull();
    expect(withdrawal.rows[0]?.confirmed_at).toBeNull();
    expect(withdrawal.rows[0]?.release).toBeNull();

    const ipp = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [withdrawalId],
    );
    expect(ipp.rows[0]?.c).toBe(0);

    const reservedAfter = await pool.query<{ b: string }>(
      `SELECT lab.balance_atomic::text AS b
       FROM ledger_accounts la
       JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       WHERE la.owner_id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [userId],
    );
    expect(reservedAfter.rows[0]?.b).toBe(reservedBefore.rows[0]?.b);

    // Resume must not blind-resend (claim already taken / ambiguity set).
    const resume = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });
    expect(primary.getSendBocCallCount()).toBe(1);
    expect(resume.state === 'RECONCILE_REQUIRED' || resume.state === 'CONFIRMED').toBe(true);
    const attemptsAfterResume = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attemptsAfterResume.rows[0]?.c).toBe(1);
    const signs = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid AND signing_started_at IS NOT NULL`,
      [withdrawalId],
    );
    expect(signs.rows[0]?.c).toBe(1);
  });

  it('sendBoc accepted:false → RECONCILE_REQUIRED, never BROADCASTED', async () => {
    const userId = await createTestUser(pool, '9203');
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

    const primary = new FakeTonChainProvider({ sendBocAcceptedFalse: true });
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 5,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 5,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

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

    expect(result.state).toBe('RECONCILE_REQUIRED');
    expect(result.reason).toBe('sendBoc_accepted_false');
    expect(result.stagesCompleted).toEqual(
      expect.arrayContaining(['persist_signed_boc_before_send', 'provider_sendBoc_accepted_false']),
    );
    expect(primary.getSendBocCallCount()).toBe(1);

    const durable = await pool.query<{
      state: string;
      broadcast_result_state: string;
    }>(
      `SELECT w.state::text AS state, a.broadcast_result_state::text AS broadcast_result_state
       FROM withdrawals w
       INNER JOIN withdrawal_attempts a ON a.withdrawal_id = w.id
       WHERE w.id = $1::uuid`,
      [withdrawalId],
    );
    expect(durable.rows[0]?.state).toBe('RECONCILE_REQUIRED');
    expect(durable.rows[0]?.broadcast_result_state).toBe('RECONCILE_REQUIRED');
    expect(durable.rows[0]?.broadcast_result_state).not.toBe('BROADCASTED');
  });

  it('signer LOCKED (signingReady:false) → BLOCKED before attempt/sign/sendBoc', async () => {
    const userId = await createTestUser(pool, '9210');
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
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 3,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 3,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

    const lockedSigner: RealPayoutSignerPort = {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: false,
          custodyState: 'LOCKED',
        };
      },
      async signWithdrawalAttempt() {
        throw new Error('SIGNING_LOCKED: must not be reached when signingReady=false');
      },
    };

    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });

    const reservedBefore = await pool.query<{ b: string }>(
      `SELECT lab.balance_atomic::text AS b
       FROM ledger_accounts la
       JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       WHERE la.owner_id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [userId],
    );

    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: lockedSigner,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('BLOCKED');
    expect(result.reason).toMatch(/signer locked \/ not ready/i);
    expect(result.attemptId).toBeNull();
    expect(primary.getSendBocCallCount()).toBe(0);

    const attempts = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(0);

    const w = await pool.query<{
      state: string;
      settlement_ledger_tx_id: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT state::text AS state,
              settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
              confirmed_at
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]?.state).toBe('QUEUED');
    expect(w.rows[0]?.settlement_ledger_tx_id).toBeNull();
    expect(w.rows[0]?.confirmed_at).toBeNull();

    const ipp = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [withdrawalId],
    );
    expect(ipp.rows[0]?.c).toBe(0);

    const reservedAfter = await pool.query<{ b: string }>(
      `SELECT lab.balance_atomic::text AS b
       FROM ledger_accounts la
       JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       WHERE la.owner_id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [userId],
    );
    expect(reservedAfter.rows[0]?.b).toBe(reservedBefore.rows[0]?.b);

    // Second call must not auto-unlock or bypass; still blocked, still zero sendBoc.
    const resume = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: lockedSigner,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });
    expect(resume.state).toBe('BLOCKED');
    expect(primary.getSendBocCallCount()).toBe(0);
    const attemptsAfter = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attemptsAfter.rows[0]?.c).toBe(0);
  });

  it('signer throws SIGNING_LOCKED mid-window → FAILED_PRE_BROADCAST, sendBoc=0, no settle/IPP', async () => {
    const userId = await createTestUser(pool, '9211');
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
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 4,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 4,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

    let signInvocations = 0;
    const midWindowLockedSigner: RealPayoutSignerPort = {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: true,
          custodyState: 'LOCKED',
        };
      },
      async signWithdrawalAttempt() {
        signInvocations += 1;
        throw new Error('SIGNING_LOCKED: Signer custody is locked');
      },
    };

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
      signer: midWindowLockedSigner,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('FAILED_PRE_BROADCAST');
    expect(result.reason).toMatch(/SIGNING_LOCKED/i);
    expect(signInvocations).toBe(1);
    expect(primary.getSendBocCallCount()).toBe(0);

    const attempt = await pool.query<{
      c: number;
      broadcast_submitted_at: Date | null;
      broadcast_result_state: string | null;
      broadcast_ambiguity_class: string | null;
      signing_started_at: Date | null;
      signed_external_message_boc: string | null;
    }>(
      `SELECT COUNT(*)::int AS c,
              MAX(broadcast_submitted_at) AS broadcast_submitted_at,
              MAX(broadcast_result_state::text) AS broadcast_result_state,
              MAX(broadcast_ambiguity_class::text) AS broadcast_ambiguity_class,
              MAX(signing_started_at) AS signing_started_at,
              MAX(signed_external_message_boc) AS signed_external_message_boc
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempt.rows[0]?.c).toBe(1);
    expect(attempt.rows[0]?.broadcast_submitted_at).toBeNull();
    expect(attempt.rows[0]?.broadcast_result_state).toBe('FAILED_PRE_BROADCAST');
    expect(attempt.rows[0]?.broadcast_ambiguity_class).toBeNull();
    expect(attempt.rows[0]?.broadcast_result_state).not.toBe('BROADCASTED');
    expect(attempt.rows[0]?.broadcast_result_state).not.toBe('UNKNOWN');
    expect(attempt.rows[0]?.signed_external_message_boc).toBeNull();

    const w = await pool.query<{
      state: string;
      settlement_ledger_tx_id: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT state::text AS state,
              settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
              confirmed_at
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]?.state).toBe('FAILED_PRE_BROADCAST');
    expect(w.rows[0]?.settlement_ledger_tx_id).toBeNull();
    expect(w.rows[0]?.confirmed_at).toBeNull();

    const ipp = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [withdrawalId],
    );
    expect(ipp.rows[0]?.c).toBe(0);

    // Resume with still-locked signer must not blind-resend or auto-unlock.
    const resume = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: midWindowLockedSigner,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });
    expect(primary.getSendBocCallCount()).toBe(0);
    expect(resume.state === 'FAILED_PRE_BROADCAST' || resume.state === 'BLOCKED').toBe(true);
    expect(signInvocations).toBeLessThanOrEqual(2);
    const attemptsAfter = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    // At most one new attempt on redispatch path; never broadcast.
    expect(attemptsAfter.rows[0]?.c).toBeLessThanOrEqual(2);
    const broadcasts = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid AND broadcast_submitted_at IS NOT NULL`,
      [withdrawalId],
    );
    expect(broadcasts.rows[0]?.c).toBe(0);
  });

  it('PAYOUT_DISPATCH_PAUSE=true → PAUSED before attempt/sign/sendBoc', async () => {
    await pool.query(
      `UPDATE feature_flags SET enabled = true, updated_at = now()
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
    const pause = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
    expect(pause.rows[0]?.enabled).toBe(true);

    const userId = await createTestUser(pool, '9220');
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
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const reservedBefore = await pool.query<{ b: string }>(
      `SELECT lab.balance_atomic::text AS b
       FROM ledger_accounts la
       JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       WHERE la.owner_id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [userId],
    );

    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 9,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 9,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });

    let signCalls = 0;
    const signer: RealPayoutSignerPort = {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: ENCRYPTED_SIGNER_REF,
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: true,
          custodyState: 'UNLOCKED',
        };
      },
      async signWithdrawalAttempt() {
        signCalls += 1;
        throw new Error('sign must not be reached while paused');
      },
    };

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
      signer,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('PAUSED');
    expect(result.reason).toBe('PAYOUT_DISPATCH_PAUSE');
    expect(result.attemptId).toBeNull();
    expect(result.stagesCompleted).toEqual([]);
    expect(signCalls).toBe(0);
    expect(primary.getSendBocCallCount()).toBe(0);

    const attempts = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(0);

    const w = await pool.query<{
      state: string;
      settlement_ledger_tx_id: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT state::text AS state,
              settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
              confirmed_at
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]?.state).toBe('QUEUED');
    expect(w.rows[0]?.settlement_ledger_tx_id).toBeNull();
    expect(w.rows[0]?.confirmed_at).toBeNull();

    const reservedAfter = await pool.query<{ b: string }>(
      `SELECT lab.balance_atomic::text AS b
       FROM ledger_accounts la
       JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       WHERE la.owner_id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [userId],
    );
    expect(reservedAfter.rows[0]?.b).toBe(reservedBefore.rows[0]?.b);
  });
});
