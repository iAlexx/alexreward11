import { createHash } from 'node:crypto';

import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireHotWalletDispatchLease,
  buildPhase10PayoutConfig,
  evaluateFailedPreBroadcastReuse,
  hotWalletDispatchOwnerIdentity,
  localWithdrawalEngineFixtureConfig,
  releaseHotWalletDispatchLease,
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

describe.skipIf(phase7DatabaseUrl === '')('phase10 failed-pre reuse + diagnostic reason', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let jettonMaster: string;
  let signCalls = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    signCalls = 0;
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase10_failed_pre_reuse',
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
        signCalls += 1;
        throw new Error('sign must not be called on pre-attempt failure');
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

  function seedAgreeingProviders(seqno: number): {
    primary: FakeTonChainProvider;
    secondary: FakeTonChainProvider;
  } {
    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
    });
    return { primary, secondary };
  }

  it('pre-attempt hash failure returns reason, preserves reservation, no sign/broadcast/attempt', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9811');
    const before = await pool.query<{
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
    }>(
      `SELECT reservation_ledger_tx_id, release_ledger_tx_id
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(before.rows[0]?.reservation_ledger_tx_id).toBeTruthy();
    expect(before.rows[0]?.release_ledger_tx_id).toBeNull();

    const reservedBefore = await pool.query<{ bal: string }>(
      `SELECT COALESCE(lab.balance_atomic,0)::text AS bal
       FROM ledger_accounts la
       LEFT JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       JOIN withdrawals w ON w.user_id = la.owner_id AND w.asset_id = la.asset_id
       WHERE w.id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [withdrawalId],
    );

    const { primary, secondary } = seedAgreeingProviders(3);
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
      buildCanonicalMessageHash: async () => {
        throw new Error('forced_canonical_hash_failure_for_diagnostics');
      },
    });

    expect(result.state).toBe('FAILED_PRE_BROADCAST');
    expect(result.attemptId).toBeNull();
    expect(result.reason).toMatch(/^CANONICAL_HASH_BUILD_FAILED:forced_canonical_hash_failure/);
    expect(result.stagesCompleted).toContain('fenced_dispatcher_lease');
    expect(result.stagesCompleted).not.toContain('immutable_payout_attempt');
    expect(result.stagesCompleted).not.toContain('signer_attempt_id_signing');
    expect(result.stagesCompleted).not.toContain('provider_sendBoc');
    expect(signCalls).toBe(0);

    const after = await pool.query<{
      state: string;
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
    }>(
      `SELECT state::text AS state, reservation_ledger_tx_id, release_ledger_tx_id
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.state).toBe('FAILED_PRE_BROADCAST');
    expect(after.rows[0]?.reservation_ledger_tx_id).toBe(before.rows[0]?.reservation_ledger_tx_id);
    expect(after.rows[0]?.release_ledger_tx_id).toBeNull();

    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(0);

    const reservedAfter = await pool.query<{ bal: string }>(
      `SELECT COALESCE(lab.balance_atomic,0)::text AS bal
       FROM ledger_accounts la
       LEFT JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       JOIN withdrawals w ON w.user_id = la.owner_id AND w.asset_id = la.asset_id
       WHERE w.id = $1::uuid AND la.account_type = 'USER_RESERVED_LIABILITY'`,
      [withdrawalId],
    );
    expect(reservedAfter.rows[0]?.bal).toBe(reservedBefore.rows[0]?.bal);
    expect(BigInt(reservedAfter.rows[0]?.bal ?? '0')).toBeGreaterThan(0n);

    const lease = await pool.query<{ released_at: Date | null }>(
      `SELECT released_at FROM hot_wallet_dispatch_leases WHERE hot_wallet_id = $1::uuid`,
      [hotWalletId],
    );
    expect(lease.rows[0]?.released_at).not.toBeNull();

    const withdrawalsCount = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawals WHERE user_id = (
         SELECT user_id FROM withdrawals WHERE id = $1::uuid
       )`,
      [withdrawalId],
    );
    expect(withdrawalsCount.rows[0]?.c).toBe(1);

    const reuse = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(reuse.ok).toBe(true);
    expect(reuse.readyForAuthorizedRetry).toBe(true);
    expect(reuse.snapshot?.attemptCount).toBe(0);
    expect(reuse.snapshot?.ambiguousAttemptCount).toBe(0);
    expect(reuse.snapshot?.releaseLedgerTxId).toBeNull();
  });

  it('evaluateFailedPreBroadcastReuse refuses when lease still held', async () => {
    const withdrawalId = await queueApprovedWithdrawal('9812');
    await pool.query(
      `UPDATE withdrawals SET state = 'FAILED_PRE_BROADCAST', updated_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
    await withWithdrawalTransaction(pool, async (client) => {
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(lease.status).toBe('ACQUIRED');
    });

    const reuse = await evaluateFailedPreBroadcastReuse(pool, withdrawalId);
    expect(reuse.ok).toBe(false);
    expect(reuse.refusalReasons).toContain('dispatch_lease_still_held');

    await withWithdrawalTransaction(pool, async (client) => {
      await releaseHotWalletDispatchLease(client, {
        hotWalletId,
        ownerIdentity: owner,
        reason: 'FAILED_PRE_BROADCAST',
      });
    });
  });
});
