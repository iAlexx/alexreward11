import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FakeTonChainProvider,
  TonProviderHttpError,
  deriveWalletV5R1AddressRaw,
  type TonChainProvider,
} from '@alex-rewards/ton';

import {
  buildPhase10PayoutConfig,
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
const rateLimitError = new TonProviderHttpError(
  429,
  '{"ok":false,"result":"Ratelimit exceed","code":429}',
  'TonCenter getAddressInformation',
);

/**
 * Fail getAccountState only after the initial dual-admission (call 1).
 * `failAfterInitial` times: throw on subsequent calls, then succeed.
 * When failAfterInitial is Infinity, every post-initial call 429s.
 */
function wrapSecondaryReadmission429(
  inner: FakeTonChainProvider,
  failAfterInitial: number,
): { provider: TonChainProvider; getCalls: () => number } {
  let calls = 0;
  const provider: TonChainProvider = {
    networkGlobalId: inner.networkGlobalId,
    getSeqno: (address) => inner.getSeqno(address),
    getAccountState: async (address) => {
      calls += 1;
      if (calls > 1 && calls <= 1 + failAfterInitial) {
        throw rateLimitError;
      }
      return inner.getAccountState(address);
    },
    getAccountBalance: (address) => inner.getAccountBalance(address),
    getJettonBalance: (owner, master) => inner.getJettonBalance(owner, master),
    sendBoc: (boc) => inner.sendBoc(boc),
    findTransactionsByQueryId: (input) => inner.findTransactionsByQueryId(input),
    observeJettonTransfer: (input) => inner.observeJettonTransfer(input),
    enumerateOutgoingJettonTransfers: (input) => inner.enumerateOutgoingJettonTransfers(input),
    health: () => inner.health(),
  };
  return { provider, getCalls: () => calls };
}

describe.skipIf(phase7DatabaseUrl === '')('phase10 seqno readmission RATE_LIMITED recovery', () => {
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

  function createTestSigner(signCalls: { count: number }): RealPayoutSignerPort {
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
        signCalls.count += 1;
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

  async function queueApprovedWithdrawal(telegramId: string): Promise<string> {
    const userId = await createTestUser(pool, telegramId);
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
    return withdrawalId;
  }

  function phase10Config() {
    return buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'tonapi',
      primaryProviderUrl: 'https://testnet.tonapi.io',
      secondaryProviderKind: 'toncenter',
      secondaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
    });
  }

  it('recovers from post-lease TonCenter 429 and only then creates attempt/signs/broadcasts', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9401');
    const net = await pool.query<{ net_amount_atomic: string }>(
      `SELECT net_amount_atomic::text AS net_amount_atomic FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const netAmount = net.rows[0]!.net_amount_atomic;

    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 11,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 11,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    const wrapped = wrapSecondaryReadmission429(secondary, 1);

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

    const signCalls = { count: 0 };
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10: phase10Config(),
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: wrapped.provider,
      signer: createTestSigner(signCalls),
      allowTestExecutionPath: true,
      seqnoAdmissionSleepMs: async () => undefined,
      seqnoReadmissionPaceMs: 0,
      seqnoAdmissionRateLimitMaxAttempts: 3,
      seqnoAdmissionRateLimitBaseDelayMs: 1,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('CONFIRMED');
    expect(result.attemptId).not.toBeNull();
    expect(signCalls.count).toBe(1);
    expect(primary.getSendBocCallCount()).toBe(1);
    // initial + failed readmission + successful readmission
    expect(wrapped.getCalls()).toBe(3);
  });

  it('fail-closes persistent readmission 429 with attempt null and no sign/broadcast', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9402');
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
    const wrapped = wrapSecondaryReadmission429(secondary, Number.POSITIVE_INFINITY);

    const signCalls = { count: 0 };
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10: phase10Config(),
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: wrapped.provider,
      signer: createTestSigner(signCalls),
      allowTestExecutionPath: true,
      seqnoAdmissionSleepMs: async () => undefined,
      seqnoReadmissionPaceMs: 0,
      seqnoAdmissionRateLimitMaxAttempts: 3,
      seqnoAdmissionRateLimitBaseDelayMs: 1,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('FAILED_PRE_BROADCAST');
    expect(result.attemptId).toBeNull();
    expect(result.reason).toMatch(/WALLET_SEQNO_READMISSION_BLOCKED:RATE_LIMITED/);
    expect(signCalls.count).toBe(0);
    expect(primary.getSendBocCallCount()).toBe(0);
    // initial + 3 failed readmission attempts
    expect(wrapped.getCalls()).toBe(4);

    const attempts = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe('0');

    const withdrawal = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(withdrawal.rows[0]?.state).toBe('FAILED_PRE_BROADCAST');
  });

  it('aborts RATE_LIMITED retry when dispatch lease is released before re-admission', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9403');
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 8,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 8,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    const wrapped = wrapSecondaryReadmission429(secondary, Number.POSITIVE_INFINITY);

    const signCalls = { count: 0 };
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10: phase10Config(),
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: wrapped.provider,
      signer: createTestSigner(signCalls),
      allowTestExecutionPath: true,
      seqnoReadmissionPaceMs: 0,
      seqnoAdmissionRateLimitMaxAttempts: 4,
      seqnoAdmissionRateLimitBaseDelayMs: 5,
      seqnoAdmissionSleepMs: async () => {
        await pool.query(
          `UPDATE hot_wallet_dispatch_leases
           SET released_at = now()
           WHERE owner_identity = $1
             AND released_at IS NULL`,
          [`withdrawal:${withdrawalId}`],
        );
      },
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('FAILED_PRE_BROADCAST');
    expect(result.attemptId).toBeNull();
    expect(result.reason).toMatch(/WALLET_SEQNO_READMISSION_BLOCKED:LEASE_FENCE_INVALID/);
    expect(signCalls.count).toBe(0);
    expect(primary.getSendBocCallCount()).toBe(0);
    // initial + first failed readmission; lease abort before second retry admission
    expect(wrapped.getCalls()).toBe(2);

    const attempts = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe('0');
  });
});
