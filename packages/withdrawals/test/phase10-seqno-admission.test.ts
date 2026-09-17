import { createHash } from 'node:crypto';

import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireHotWalletDispatchLease,
  buildPhase10PayoutConfig,
  hotWalletDispatchOwnerIdentity,
  localWithdrawalEngineFixtureConfig,
  runPhase10Preflight,
  runPhase10RestoreReconcileScan,
  runRealTestnetPayoutPipeline,
  withWithdrawalTransaction,
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

describe.skipIf(phase7DatabaseUrl === '')('phase10 seqno admission pipeline / restore', () => {
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
      friendlyAddress: 'EQ_phase10_seqno_admission',
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
      async signWithdrawalAttempt() {
        throw new Error('sign must not be called when admission is blocked');
      },
    };
  }

  async function queueApprovedWithdrawal(telegramUserId: string): Promise<string> {
    const userId = await createTestUser(pool, telegramUserId);
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

  it('admission blocked before SIGNING does not create attempt or strand a lease; stays QUEUED', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9801');
    const before = await pool.query<{
      state: string;
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
    }>(
      `SELECT state::text AS state, reservation_ledger_tx_id, release_ledger_tx_id
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    // Disagreement → admission BLOCKED before SIGNING/lease.
    primary.seedUninit(HOT_WALLET_RAW);
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 1,
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

    expect(result.state).toBe('BLOCKED');
    expect(result.attemptId).toBeNull();
    expect(result.reason).toMatch(/WALLET_SEQNO_ADMISSION_BLOCKED/);
    expect(result.stagesCompleted).toContain('wallet_seqno_admission_blocked');
    expect(result.stagesCompleted).not.toContain('fenced_dispatcher_lease');
    expect(result.stagesCompleted).not.toContain('immutable_payout_attempt');

    const after = await pool.query<{
      state: string;
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
    }>(
      `SELECT state::text AS state, reservation_ledger_tx_id, release_ledger_tx_id
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.state).toBe('QUEUED');
    expect(after.rows[0]?.reservation_ledger_tx_id).toBe(before.rows[0]?.reservation_ledger_tx_id);
    expect(after.rows[0]?.release_ledger_tx_id).toBe(before.rows[0]?.release_ledger_tx_id);

    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(0);

    const leases = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM hot_wallet_dispatch_leases
       WHERE hot_wallet_id = $1::uuid AND released_at IS NULL`,
      [hotWalletId],
    );
    expect(leases.rows[0]?.c).toBe(0);
  });

  it('SIGNING + zero attempts + stale unreleased lease → restore DANGER; preflight not READY; no mutation', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9802');
    const before = await pool.query<{
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
      state: string;
    }>(
      `SELECT reservation_ledger_tx_id, release_ledger_tx_id, state::text AS state
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );

    await pool.query(
      `UPDATE withdrawals SET state = 'SIGNING', updated_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
    await withWithdrawalTransaction(pool, async (client) => {
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(lease.status).toBe('ACQUIRED');
    });
    await pool.query(
      `UPDATE hot_wallet_dispatch_leases
       SET acquired_at = now() - interval '10 minutes',
           renewed_at = now() - interval '10 minutes',
           expires_at = now() - interval '5 minutes',
           released_at = NULL
       WHERE hot_wallet_id = $1::uuid AND owner_identity = $2`,
      [hotWalletId, owner],
    );

    const leaseBefore = await pool.query<{
      fencing_token: string;
      released_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT fencing_token::text, released_at, expires_at
       FROM hot_wallet_dispatch_leases
       WHERE hot_wallet_id = $1::uuid AND owner_identity = $2`,
      [hotWalletId, owner],
    );

    const restore = await runPhase10RestoreReconcileScan(pool);
    expect(restore.autoResend).toBe(false);
    expect(restore.autoUnpause).toBe(false);
    expect(restore.byCategory.signing_zero_attempts_recovery_required).toBeGreaterThanOrEqual(1);
    const finding = restore.findings.find(
      (f) =>
        f.category === 'signing_zero_attempts_recovery_required' && f.withdrawalId === withdrawalId,
    );
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('DANGER');
    expect(restore.dangerousCount).toBeGreaterThanOrEqual(1);

    const preflight = await runPhase10Preflight(pool, {
      readinessConfig: {
        deploymentEnvironment: 'LOCAL',
        fakeChainEnabled: false,
        realChainEnabled: true,
        acceptedNetworkCode: 'TON_TESTNET',
        usdtSymbol: 'USDT',
      },
      skipRestoreScan: false,
    });
    expect(preflight.verdict).toBe('BLOCKED');
    expect(preflight.restore.dangerousCount).toBeGreaterThan(0);
    expect(
      preflight.blockers.some(
        (b) => b.includes('restore scan') || b.includes('signing_zero_attempts'),
      ),
    ).toBe(true);

    // Detection must not mutate reservation / lease / redispatch.
    const after = await pool.query<{
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
      state: string;
    }>(
      `SELECT reservation_ledger_tx_id, release_ledger_tx_id, state::text AS state
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.state).toBe('SIGNING');
    expect(after.rows[0]?.reservation_ledger_tx_id).toBe(before.rows[0]?.reservation_ledger_tx_id);
    expect(after.rows[0]?.release_ledger_tx_id).toBe(before.rows[0]?.release_ledger_tx_id);

    const leaseAfter = await pool.query<{
      fencing_token: string;
      released_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT fencing_token::text, released_at, expires_at
       FROM hot_wallet_dispatch_leases
       WHERE hot_wallet_id = $1::uuid AND owner_identity = $2`,
      [hotWalletId, owner],
    );
    expect(leaseAfter.rows[0]?.fencing_token).toBe(leaseBefore.rows[0]?.fencing_token);
    expect(leaseAfter.rows[0]?.released_at).toBeNull();
    expect(leaseAfter.rows[0]?.expires_at.getTime()).toBe(
      leaseBefore.rows[0]!.expires_at.getTime(),
    );

    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(0);

    // Pipeline also refuses automatic redispatch of this stuck state.
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
    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });
    const pipeline = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });
    expect(pipeline.state).toBe('BLOCKED');
    expect(pipeline.reason).toBe('signing_zero_attempts_recovery_required');
    expect(pipeline.attemptId).toBeNull();

    const stateAfterPipeline = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(stateAfterPipeline.rows[0]?.state).toBe('SIGNING');
    const leaseStillHeld = await pool.query<{ released_at: Date | null }>(
      `SELECT released_at FROM hot_wallet_dispatch_leases
       WHERE hot_wallet_id = $1::uuid AND owner_identity = $2`,
      [hotWalletId, owner],
    );
    expect(leaseStillHeld.rows[0]?.released_at).toBeNull();
  });
});
