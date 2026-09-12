import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeTonChainProvider } from '@alex-rewards/ton';

import {
  buildPhase10PayoutConfig,
  localWithdrawalEngineFixtureConfig,
  PipelineCrashError,
  runRealTestnetPayoutPipeline,
  type RealPayoutSignerPort,
  type RealPipelineCrashPoint,
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
const ENCRYPTED_SIGNER_REF = 'phase10-crash-restart-encrypted-ref';
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const TEST_CANONICAL_HASH = '22'.repeat(32);
const NORMALIZED_HASH = '33'.repeat(32);
const nonFakeEngine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

type Scenario = {
  readonly name: string;
  readonly point: RealPipelineCrashPoint;
  readonly stateAfterCrash: string;
  readonly attemptsAfterCrash: number;
  readonly sendsAfterCrash: number;
  readonly sendsAfterRestart: number;
};

const scenarios: readonly Scenario[] = [
  {
    name: 'A: enter SIGNING before attempt',
    point: 'AFTER_ENTER_SIGNING',
    stateAfterCrash: 'SIGNING',
    attemptsAfterCrash: 0,
    sendsAfterCrash: 0,
    sendsAfterRestart: 1,
  },
  {
    name: 'B: pending attempt is reused',
    point: 'AFTER_ATTEMPT_CREATED',
    stateAfterCrash: 'SIGNING',
    attemptsAfterCrash: 1,
    sendsAfterCrash: 0,
    sendsAfterRestart: 1,
  },
  {
    name: 'C: signed but BOC not persisted re-signs same attempt',
    point: 'AFTER_SIGNED',
    stateAfterCrash: 'SIGNING',
    attemptsAfterCrash: 1,
    sendsAfterCrash: 0,
    sendsAfterRestart: 1,
  },
  {
    name: 'D: persisted BOC is submitted once',
    point: 'AFTER_BOC_PERSISTED',
    stateAfterCrash: 'BROADCASTING',
    attemptsAfterCrash: 1,
    sendsAfterCrash: 0,
    sendsAfterRestart: 1,
  },
  {
    name: 'E: submit intent forbids a later send',
    point: 'AFTER_SUBMIT_INTENT',
    stateAfterCrash: 'BROADCASTING',
    attemptsAfterCrash: 1,
    sendsAfterCrash: 0,
    sendsAfterRestart: 0,
  },
  {
    name: 'F: accepted send before evidence is never sent twice',
    point: 'AFTER_SEND_ACCEPTED_BEFORE_EVIDENCE',
    stateAfterCrash: 'BROADCASTING',
    attemptsAfterCrash: 1,
    sendsAfterCrash: 1,
    sendsAfterRestart: 1,
  },
  {
    name: 'G: broadcast evidence resumes confirmation',
    point: 'AFTER_BROADCAST_EVIDENCE',
    stateAfterCrash: 'CONFIRMING',
    attemptsAfterCrash: 1,
    sendsAfterCrash: 1,
    sendsAfterRestart: 1,
  },
  {
    name: 'H: confirmed before settlement settles once on restart',
    point: 'AFTER_CONFIRMATION_BEFORE_SETTLE',
    stateAfterCrash: 'CONFIRMED',
    attemptsAfterCrash: 1,
    sendsAfterCrash: 1,
    sendsAfterRestart: 1,
  },
];

describe.skipIf(phase7DatabaseUrl === '')('phase10 DB crash/restart recovery', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let baseHotWalletId: string;
  let jettonMaster: string;
  let userSequence = 9300;

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
    baseHotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase10_crash_restart',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });
    const asset = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = asset.rows[0]!.contract_identity;
  });

  function signer(signCalls: string[]): RealPayoutSignerPort {
    return {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: 'fp-crash-restart',
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady: true,
          custodyState: 'test',
        };
      },
      async signWithdrawalAttempt(withdrawalAttemptId: string) {
        signCalls.push(withdrawalAttemptId);
        const result = await pool.query<{
          withdrawal_id: string;
          canonical_message_hash: string;
        }>(
          `SELECT withdrawal_id::text, canonical_message_hash
           FROM withdrawal_attempts WHERE id = $1::uuid`,
          [withdrawalAttemptId],
        );
        const attempt = result.rows[0]!;
        return {
          withdrawalAttemptId,
          withdrawalId: attempt.withdrawal_id,
          canonicalMessageHash: attempt.canonical_message_hash,
          canonicalSigningHash: attempt.canonical_message_hash,
          signedMessageHash: NORMALIZED_HASH,
          publicKeyFingerprint: 'fp-crash-restart',
          walletAddressRaw: HOT_WALLET_RAW,
          signatureBase64: 'dGVzdC1zaWc=',
          keySpec: 'TEST_ONLY',
          signingAlgorithm: 'ED25519_SHA_512',
          signedWalletRequestBocBase64: 'dGVzdC13YWxsZXQtcmVxdWVzdA==',
          externalMessageBocBase64: 'dGVzdC1ib2MtYmFzZTY0',
          externalMessageCellHash: '44'.repeat(32),
          normalizedExternalMessageHash: NORMALIZED_HASH,
          signatureFingerprintHash: '55'.repeat(32),
        };
      },
    };
  }

  it.each(scenarios)('$name', async (scenario) => {
    const userId = await createTestUser(pool, String(userSequence++));
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
      hotWalletId: baseHotWalletId,
      amountAtomic: '200000',
      engineConfig: nonFakeEngine,
    });
    const withdrawal = await pool.query<{
      hot_wallet_id: string;
      net_amount_atomic: string;
    }>(
      `SELECT hot_wallet_id::text, net_amount_atomic::text
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const hotWalletId = withdrawal.rows[0]!.hot_wallet_id;
    expect(hotWalletId).toBe(baseHotWalletId);
    const netAmount = withdrawal.rows[0]!.net_amount_atomic;
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now()
       WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const queryId =
      (1n << 32n) +
      BigInt(
        Math.abs(
          [...`${withdrawalId}:${RECIPIENT_RAW}`].reduce(
            (acc, char) => (acc * 31 + char.charCodeAt(0)) | 0,
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
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedSeqno(HOT_WALLET_RAW, 12);
    primary.seedTransfer(evidence);
    secondary.seedTransfer(evidence);
    const signCalls: string[] = [];
    const testSigner = signer(signCalls);
    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });
    const baseInput = {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: testSigner,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    };

    let crash: unknown;
    try {
      await runRealTestnetPayoutPipeline(pool, {
        ...baseInput,
        crashAfter: scenario.point,
      });
    } catch (error) {
      crash = error;
    }
    expect(crash).toBeInstanceOf(PipelineCrashError);
    expect(crash).toEqual(expect.objectContaining({ point: scenario.point }));

    const durable = await pool.query<{
      state: string;
      settlement_ledger_tx_id: string | null;
    }>(
      `SELECT state::text, settlement_ledger_tx_id
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(durable.rows[0]?.state).toBe(scenario.stateAfterCrash);
    if (scenario.point === 'AFTER_CONFIRMATION_BEFORE_SETTLE') {
      expect(durable.rows[0]?.settlement_ledger_tx_id).toBeNull();
    }
    const attemptsAfterCrash = await pool.query<{
      id: string;
      signed_external_message_boc: string | null;
      broadcast_submitted_at: Date | null;
    }>(
      `SELECT id, signed_external_message_boc, broadcast_submitted_at
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid
       ORDER BY attempt_number`,
      [withdrawalId],
    );
    expect(attemptsAfterCrash.rowCount).toBe(scenario.attemptsAfterCrash);
    expect(primary.getSendBocCallCount()).toBe(scenario.sendsAfterCrash);
    const firstAttemptId = attemptsAfterCrash.rows[0]?.id;

    const recovered = await runRealTestnetPayoutPipeline(pool, baseInput);
    expect(recovered.state).toBe('CONFIRMED');
    expect(primary.getSendBocCallCount()).toBe(scenario.sendsAfterRestart);

    const finalAttempts = await pool.query<{ id: string }>(
      `SELECT id FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid ORDER BY attempt_number`,
      [withdrawalId],
    );
    expect(finalAttempts.rowCount).toBe(1);
    if (firstAttemptId !== undefined) {
      expect(finalAttempts.rows[0]?.id).toBe(firstAttemptId);
    }
    if (scenario.point === 'AFTER_ATTEMPT_CREATED' || scenario.point === 'AFTER_SIGNED') {
      expect(signCalls.every((attemptId) => attemptId === finalAttempts.rows[0]?.id)).toBe(true);
    }

    const settled = await pool.query<{
      state: string;
      settlement_ledger_tx_id: string | null;
      settlement_count: string;
    }>(
      `SELECT w.state::text, w.settlement_ledger_tx_id,
              (SELECT count(*)::text FROM ledger_transactions lt
               WHERE lt.business_reference_type = 'withdrawal'
                 AND lt.business_reference_id = w.id
                 AND lt.transaction_type = 'WITHDRAWAL_SETTLEMENT') AS settlement_count
       FROM withdrawals w WHERE w.id = $1::uuid`,
      [withdrawalId],
    );
    expect(settled.rows[0]?.state).toBe('CONFIRMED');
    expect(settled.rows[0]?.settlement_ledger_tx_id).not.toBeNull();
    expect(settled.rows[0]?.settlement_count).toBe('1');
  });
});
