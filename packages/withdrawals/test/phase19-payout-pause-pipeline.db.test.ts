/**
 * P19-SEC-016 — pipeline-level fail-closed when PAYOUT_DISPATCH_PAUSE row is absent
 * for STAGING / PRODUCTION (disposable Phase 19 DB only).
 */
import { createHash } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';

import {
  buildPhase10PayoutConfig,
  localWithdrawalEngineFixtureConfig,
  runRealTestnetPayoutPipeline,
  type RealPayoutSignerPort,
  type WithdrawalEngineConfig,
} from '../src/index.js';
import {
  createApprovedWithdrawal,
  createTestUser,
  createVerifiedPrimaryWallet,
  ensureEncryptedPayoutHotWallet,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

const dbUrl =
  process.env.PHASE19_SECURITY_DATABASE_URL ||
  process.env.PHASE7_DATABASE_URL ||
  (process.env.PHASE19_PAYOUT_PAUSE_TESTS === '1' || process.env.PHASE7_WITHDRAWAL_TESTS === '1'
    ? (process.env.DATABASE_URL ?? '')
    : '');

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

/** LOCAL fixture for create/approve — do not assert STAGING/PROD network rules. */
const localEngine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

/**
 * Override deploymentEnvironment WITHOUT assertWithdrawalEngineConfig so the
 * pipeline pause check uses STAGING/PRODUCTION fail-closed for a missing row
 * while still using the LOCAL testnet fixture network code.
 */
function engineForPauseEnv(
  deploymentEnvironment: 'STAGING' | 'PRODUCTION',
): WithdrawalEngineConfig {
  return {
    ...localEngine,
    deploymentEnvironment,
  };
}

describe.skipIf(dbUrl === '')('P19-SEC-016 payout pause pipeline fail-closed (DB)', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let jettonMaster: string;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = new Pool({ connectionString: dbUrl });
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
      friendlyAddress: 'EQ_phase19_pause_hot',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });
    const master = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = master.rows[0]!.contract_identity;
  });

  async function runMissingPauseCase(
    deploymentEnvironment: 'STAGING' | 'PRODUCTION',
  ): Promise<void> {
    await pool.query(
      `DELETE FROM feature_flags
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = $1::environment_name`,
      [deploymentEnvironment],
    );
    const absent = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM feature_flags
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = $1::environment_name`,
      [deploymentEnvironment],
    );
    expect(absent.rows[0]!.c).toBe(0);

    const userId = await createTestUser(pool, deploymentEnvironment === 'STAGING' ? '9310' : '9311');
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
      engineConfig: localEngine,
    });
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const attemptsBefore = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid AND broadcast_submitted_at IS NOT NULL`,
      [withdrawalId],
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
        throw new Error('sign must not be reached while pause-fail-closed');
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

    const engine = engineForPauseEnv(deploymentEnvironment);
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(result.state).toBe('PAUSED');
    expect(result.reason).toBe('PAYOUT_DISPATCH_PAUSE');
    expect(result.attemptId).toBeNull();
    expect(signCalls).toBe(0);
    expect(primary.getSendBocCallCount()).toBe(0);

    const attemptsAfter = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid AND broadcast_submitted_at IS NOT NULL`,
      [withdrawalId],
    );
    expect(attemptsAfter.rows[0]!.c).toBe(attemptsBefore.rows[0]!.c);

    const w = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]!.state).toBe('QUEUED');
  }

  it('STAGING missing PAYOUT_DISPATCH_PAUSE row => PAUSED fail-closed, no sign/broadcast', async () => {
    await runMissingPauseCase('STAGING');
  });

  it('PRODUCTION missing PAYOUT_DISPATCH_PAUSE row => PAUSED fail-closed, no sign/broadcast', async () => {
    await runMissingPauseCase('PRODUCTION');
  });
});
