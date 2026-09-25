/**
 * Real-chain reconcile-only path — never signs/broadcasts/settles/releases.
 */
import { createHash } from 'node:crypto';

import {
  FakeTonChainProvider,
  deriveWalletV5R1AddressRaw,
  type JettonTransferEvidence,
  type TonChainProvider,
  type TonSendBocResult,
} from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  localWithdrawalEngineFixtureConfig,
  reconcileRealWithdrawalAttemptOnly,
} from '../src/index.js';
import {
  createApprovedWithdrawal,
  createOwnerAdmin,
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
const TEST_PUBLIC_KEY_HEX = '33'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');
const HOT_WALLET_RAW = deriveWalletV5R1AddressRaw({
  publicKeyHex: TEST_PUBLIC_KEY_HEX,
  networkGlobalId: -3,
});
const QUERY_ID = '6345071293';
const NET = '190000';
const GROSS = '200000';
const NORM_HASH = '50'.repeat(32);
const CELL_HASH = 'bd'.repeat(32);

function trackingProvider(
  inner: FakeTonChainProvider,
): { provider: TonChainProvider; sendBocCalls: () => number } {
  let sendBocCalls = 0;
  const provider: TonChainProvider = {
    networkGlobalId: inner.networkGlobalId,
    getSeqno: (a) => inner.getSeqno(a),
    getAccountState: (a) => inner.getAccountState(a),
    getAccountBalance: (a) => inner.getAccountBalance(a),
    getJettonBalance: (o, m) => inner.getJettonBalance(o, m),
    sendBoc: async (boc): Promise<TonSendBocResult> => {
      sendBocCalls += 1;
      return inner.sendBoc(boc);
    },
    findTransactionsByQueryId: (input) => inner.findTransactionsByQueryId(input),
    observeJettonTransfer: (input) => inner.observeJettonTransfer(input),
    enumerateOutgoingJettonTransfers: (input) => inner.enumerateOutgoingJettonTransfers(input),
    health: () => inner.health(),
  };
  return { provider, sendBocCalls: () => sendBocCalls };
}

function completeEvidence(
  overrides: Partial<JettonTransferEvidence> & { readonly providerKind: 'tonapi' | 'toncenter' },
): JettonTransferEvidence {
  return {
    hotWallet: HOT_WALLET_RAW,
    jettonMaster: 'PLACEHOLDER',
    recipient: RECIPIENT_RAW,
    amountAtomic: NET,
    queryId: QUERY_ID,
    success: true,
    bounced: false,
    networkGlobalId: -3,
    senderJettonWallet: PAYOUT_JETTON_WALLET,
    proofStage: 'COMPLETE',
    hotWalletTxHash: 'aa'.repeat(32),
    jettonWalletTxHash: 'bb'.repeat(32),
    recipientEvidence: 'recipient-ok',
    transactionHash: 'cc'.repeat(32),
    ...overrides,
  };
}

describe.skipIf(phase7DatabaseUrl === '')('phase10 real-chain reconcile-only', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let jettonMaster: string;
  const engine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

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
    adminUserId = await createOwnerAdmin(pool, `recon-only-${Date.now()}@example.local`);
    const master = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = master.rows[0]?.contract_identity ?? '';
    if (jettonMaster === '') {
      jettonMaster = '0:53a1eee8c135c0472b4b75b14880ef1b5798f76d24e78b7f8140899be800c6e8';
      await pool.query(`UPDATE assets SET contract_identity = $2 WHERE id = $1::uuid`, [
        assetId,
        jettonMaster,
      ]);
    }
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: HOT_WALLET_RAW,
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });
    await pool.query(
      `UPDATE feature_flags SET enabled = true, updated_at = now()
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
  });

  async function seedReconcileRequiredWithdrawal(): Promise<{
    withdrawalId: string;
    attemptId: string;
    userId: string;
  }> {
    const userId = await createTestUser(pool, String(9_100_000_000 + Math.floor(Math.random() * 1e6)));
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
      amountAtomic: GROSS,
      engineConfig: engine,
    });
    await pool.query(
      `UPDATE withdrawals
       SET state = 'RECONCILE_REQUIRED'::withdrawal_state,
           hot_wallet_id = $2::uuid,
           updated_at = now()
       WHERE id = $1::uuid`,
      [withdrawalId, hotWalletId],
    );
    const attempt = await pool.query<{ id: string }>(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, broadcast_ambiguity_class,
         requires_state_init, signed_external_message_boc,
         normalized_external_message_hash, external_message_cell_hash,
         signing_started_at, broadcast_started_at, broadcast_submitted_at
       ) VALUES (
         $1::uuid, 1, $2::uuid, 71, $3::bigint,
         now() + interval '1 hour', $4, $5,
         1, 'UNKNOWN', 'UNKNOWN_SUBMIT_OUTCOME',
         false, 'te6cckEBAQEAAgAAAA==',
         $6, $7,
         now(), now(), now()
       )
       RETURNING id`,
      [
        withdrawalId,
        hotWalletId,
        QUERY_ID,
        '04'.repeat(32),
        ENCRYPTED_SIGNER_REF,
        NORM_HASH,
        CELL_HASH,
      ],
    );
    return { withdrawalId, attemptId: attempt.rows[0]!.id, userId };
  }

  async function reservedBalance(userId: string): Promise<string> {
    const r = await pool.query<{ bal: string }>(
      `SELECT b.balance_atomic::text AS bal
       FROM ledger_accounts a
       JOIN ledger_account_balances b ON b.ledger_account_id = a.id
       WHERE a.owner_id = $1::uuid AND a.asset_id = $2::uuid
         AND a.account_type = 'USER_RESERVED_LIABILITY'`,
      [userId, assetId],
    );
    return r.rows[0]?.bal ?? '0';
  }

  async function attemptCount(withdrawalId: string): Promise<number> {
    const r = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    return Number(r.rows[0]?.c ?? 0);
  }

  it('1 AMBIGUOUS: both providers no match — Reserved untouched, no confirm/settle/retry', async () => {
    const { withdrawalId, attemptId, userId } = await seedReconcileRequiredWithdrawal();
    const reservedBefore = await reservedBalance(userId);
    expect(reservedBefore).toBe(GROSS);

    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    const primary = trackingProvider(primaryInner);
    const secondary = trackingProvider(secondaryInner);

    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });

    expect(result.classification).toBe('AMBIGUOUS');
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.withdrawalState).toBe('RECONCILE_REQUIRED');
    expect(result.definitiveNonpaymentSupported).toBe(true);
    expect(result.definitiveNonpaymentReason).toBeNull();
    expect(result.safety.settled).toBe(false);
    expect(result.safety.confirmed).toBe(false);
    expect(result.safety.broadcast).toBe(false);
    expect(result.safety.signed).toBe(false);
    expect(primary.sendBocCalls()).toBe(0);
    expect(secondary.sendBocCalls()).toBe(0);
    expect(await reservedBalance(userId)).toBe(GROSS);
    expect(await attemptCount(withdrawalId)).toBe(1);

    const w = await pool.query<{ state: string; settlement: string | null }>(
      `SELECT state::text AS state, settlement_ledger_tx_id::text AS settlement
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]?.state).toBe('RECONCILE_REQUIRED');
    expect(w.rows[0]?.settlement).toBeNull();

    const proofs = await pool.query<{ resolution: string }>(
      `SELECT resolution::text AS resolution FROM withdrawal_payout_reconciliations
       WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(proofs.rows).toHaveLength(1);
    expect(proofs.rows[0]?.resolution).toBe('AMBIGUOUS');
  });

  it('2 DUAL COMPLETE: proof persisted but no confirm/settle/ledger/campaign mutation', async () => {
    const { withdrawalId, attemptId, userId } = await seedReconcileRequiredWithdrawal();
    const reservedBefore = await reservedBalance(userId);

    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    primaryInner.seedTransfer(
      completeEvidence({ providerKind: 'tonapi', jettonMaster }),
    );
    secondaryInner.seedTransfer(
      completeEvidence({ providerKind: 'toncenter', jettonMaster }),
    );
    const primary = trackingProvider(primaryInner);
    const secondary = trackingProvider(secondaryInner);

    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });

    expect(result.classification).toBe('DUAL_PROVIDER_COMPLETE');
    expect(result.resolution).toBe('INTENDED_PAYOUT_PROVEN');
    expect(result.withdrawalState).toBe('RECONCILE_REQUIRED');
    expect(result.safety.settled).toBe(false);
    expect(result.safety.confirmed).toBe(false);
    expect(primary.sendBocCalls()).toBe(0);
    expect(await reservedBalance(userId)).toBe(reservedBefore);

    const w = await pool.query<{ state: string; settlement: string | null }>(
      `SELECT state::text AS state, settlement_ledger_tx_id::text AS settlement
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]?.state).toBe('RECONCILE_REQUIRED');
    expect(w.rows[0]?.settlement).toBeNull();

    const proofs = await pool.query<{ resolution: string }>(
      `SELECT resolution::text AS resolution FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid`,
      [attemptId],
    );
    expect(proofs.rows.some((p) => p.resolution === 'INTENDED_PAYOUT_PROVEN')).toBe(true);
    expect(await attemptCount(withdrawalId)).toBe(1);
  });

  it('3 PROVIDER DISAGREE: primary match secondary miss — fail closed, no settlement', async () => {
    const { withdrawalId, attemptId, userId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    primaryInner.seedTransfer(completeEvidence({ providerKind: 'tonapi', jettonMaster }));
    // secondary: no seed → null
    const primary = trackingProvider(primaryInner);
    const secondary = trackingProvider(secondaryInner);

    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });

    expect(result.classification).toBe('PROVIDER_DISAGREE');
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.withdrawalState).toBe('RECONCILE_REQUIRED');
    expect(result.primary.matched).toBe(true);
    expect(result.secondary.matched).toBe(false);
    expect(result.providersAgree).toBe(false);
    expect(result.safety.confirmed).toBe(false);
    expect(result.safety.settled).toBe(false);
    expect(result.safety.signed).toBe(false);
    expect(result.safety.broadcast).toBe(false);
    expect(result.safety.attemptCreated).toBe(false);
    expect(primary.sendBocCalls()).toBe(0);
    expect(secondary.sendBocCalls()).toBe(0);
    expect(await reservedBalance(userId)).toBe(GROSS);
    expect(await attemptCount(withdrawalId)).toBe(1);
    const settle = await pool.query<{
      settlement: string | null;
      confirmed_at: Date | null;
      state: string;
    }>(
      `SELECT settlement_ledger_tx_id::text AS settlement, confirmed_at, state::text AS state
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(settle.rows[0]?.settlement).toBeNull();
    expect(settle.rows[0]?.confirmed_at).toBeNull();
    expect(settle.rows[0]?.state).toBe('RECONCILE_REQUIRED');
    const ipp = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [attemptId],
    );
    expect(ipp.rows[0]?.c).toBe(0);
    const ambiguous = await pool.query<{ resolution: string }>(
      `SELECT resolution::text AS resolution FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid`,
      [attemptId],
    );
    expect(ambiguous.rows.some((r) => r.resolution === 'AMBIGUOUS')).toBe(true);
  });

  it('3b PROVIDER DISAGREE: secondary match primary miss — fail closed, no settlement', async () => {
    const { withdrawalId, attemptId, userId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    // primary: no seed → null
    secondaryInner.seedTransfer(completeEvidence({ providerKind: 'toncenter', jettonMaster }));
    const primary = trackingProvider(primaryInner);
    const secondary = trackingProvider(secondaryInner);

    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });

    expect(result.classification).toBe('PROVIDER_DISAGREE');
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.withdrawalState).toBe('RECONCILE_REQUIRED');
    expect(result.primary.matched).toBe(false);
    expect(result.secondary.matched).toBe(true);
    expect(result.providersAgree).toBe(false);
    expect(result.safety.confirmed).toBe(false);
    expect(result.safety.settled).toBe(false);
    expect(result.safety.signed).toBe(false);
    expect(result.safety.broadcast).toBe(false);
    expect(result.safety.attemptCreated).toBe(false);
    expect(primary.sendBocCalls()).toBe(0);
    expect(secondary.sendBocCalls()).toBe(0);
    expect(await reservedBalance(userId)).toBe(GROSS);
    expect(await attemptCount(withdrawalId)).toBe(1);
    const settle = await pool.query<{ settlement: string | null; confirmed_at: Date | null }>(
      `SELECT settlement_ledger_tx_id::text AS settlement, confirmed_at
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(settle.rows[0]?.settlement).toBeNull();
    expect(settle.rows[0]?.confirmed_at).toBeNull();
    const ipp = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [attemptId],
    );
    expect(ipp.rows[0]?.c).toBe(0);
  });

  it('3c PROVIDER DISAGREE: primary MATCH vs secondary conflicting amount — fail closed', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    primaryInner.seedTransfer(completeEvidence({ providerKind: 'tonapi', jettonMaster }));
    secondaryInner.seedTransfer(
      completeEvidence({
        providerKind: 'toncenter',
        jettonMaster,
        amountAtomic: '180000',
      }),
    );
    const primary = trackingProvider(primaryInner);
    const secondary = trackingProvider(secondaryInner);

    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });

    expect(result.classification).toBe('PROVIDER_DISAGREE');
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.primary.matched).toBe(true);
    expect(result.secondary.matched).toBe(false);
    expect(result.providersAgree).toBe(false);
    expect(result.safety.confirmed).toBe(false);
    expect(result.safety.settled).toBe(false);
    expect(primary.sendBocCalls()).toBe(0);
    expect(await attemptCount(withdrawalId)).toBe(1);
    const ipp = await pool.query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [attemptId],
    );
    expect(ipp.rows[0]?.c).toBe(0);
  });

  it('4 WRONG QUERY ID: both show other transfer — not intended', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    const wrong = completeEvidence({
      providerKind: 'tonapi',
      jettonMaster,
      queryId: '9999999999',
    });
    primaryInner.seedTransfer(wrong);
    secondaryInner.seedTransfer({ ...wrong, providerKind: 'toncenter' });

    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(primaryInner).provider,
      secondary: trackingProvider(secondaryInner).provider,
    });
    expect(result.classification).toBe('AMBIGUOUS');
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.primary.matched).toBe(false);
    expect(result.secondary.matched).toBe(false);
  });

  it('5 WRONG AMOUNT', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    const wrong = completeEvidence({
      providerKind: 'tonapi',
      jettonMaster,
      amountAtomic: '180000',
    });
    primaryInner.seedTransfer(wrong);
    secondaryInner.seedTransfer({ ...wrong, providerKind: 'toncenter' });
    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(primaryInner).provider,
      secondary: trackingProvider(secondaryInner).provider,
    });
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.primary.matched).toBe(false);
  });

  it('6 WRONG RECIPIENT', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    const wrong = completeEvidence({
      providerKind: 'tonapi',
      jettonMaster,
      recipient: '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    });
    primaryInner.seedTransfer(wrong);
    secondaryInner.seedTransfer({ ...wrong, providerKind: 'toncenter' });
    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(primaryInner).provider,
      secondary: trackingProvider(secondaryInner).provider,
    });
    expect(result.resolution).toBe('AMBIGUOUS');
  });

  it('7 WRONG MASTER', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    const wrong = completeEvidence({
      providerKind: 'tonapi',
      jettonMaster: '0:1111111111111111111111111111111111111111111111111111111111111111',
    });
    primaryInner.seedTransfer(wrong);
    secondaryInner.seedTransfer({ ...wrong, providerKind: 'toncenter' });
    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(primaryInner).provider,
      secondary: trackingProvider(secondaryInner).provider,
    });
    expect(result.resolution).toBe('AMBIGUOUS');
  });

  it('8 BOUNCED / failed transfer', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    const bounced = completeEvidence({
      providerKind: 'tonapi',
      jettonMaster,
      success: false,
      bounced: true,
    });
    primaryInner.seedTransfer(bounced);
    secondaryInner.seedTransfer({ ...bounced, providerKind: 'toncenter' });
    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(primaryInner).provider,
      secondary: trackingProvider(secondaryInner).provider,
    });
    expect(result.resolution).toBe('AMBIGUOUS');
    expect(result.primary.matched).toBe(false);
  });

  it('9 IDEMPOTENT repeated reconciliation', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    const primary = trackingProvider(primaryInner);
    const secondary = trackingProvider(secondaryInner);

    const first = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });
    const second = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });

    expect(first.resolution).toBe('AMBIGUOUS');
    expect(second.resolution).toBe('AMBIGUOUS');
    expect(second.reconciliationId).toBe(first.reconciliationId);
    expect(second.evidenceCreated).toBe(false);

    const count = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'AMBIGUOUS'`,
      [attemptId],
    );
    expect(count.rows[0]?.c).toBe('1');

    // Dual complete idempotent
    primaryInner.seedTransfer(completeEvidence({ providerKind: 'tonapi', jettonMaster }));
    secondaryInner.seedTransfer(completeEvidence({ providerKind: 'toncenter', jettonMaster }));
    const proven1 = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });
    const proven2 = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });
    expect(proven1.resolution).toBe('INTENDED_PAYOUT_PROVEN');
    expect(proven2.reconciliationId).toBe(proven1.reconciliationId);
    expect(proven2.evidenceCreated).toBe(false);
    const provenCount = await pool.query<{ c: string }>(
      `SELECT COUNT(*)::text AS c FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
      [attemptId],
    );
    expect(provenCount.rows[0]?.c).toBe('1');
  });

  it('10 Works while PAYOUT_DISPATCH_PAUSE=true', async () => {
    const pause = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
    expect(pause.rows[0]?.enabled).toBe(true);

    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const result = await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(new FakeTonChainProvider()).provider,
      secondary: trackingProvider(new FakeTonChainProvider()).provider,
    });
    expect(result.classification).toBe('AMBIGUOUS');
    expect(result.safety.pauseBypassedForDispatch).toBe(false);
  });

  it('11 Cannot invoke signer/broadcast (sendBoc never called)', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    const primaryInner = new FakeTonChainProvider();
    const secondaryInner = new FakeTonChainProvider();
    primaryInner.seedTransfer(completeEvidence({ providerKind: 'tonapi', jettonMaster }));
    secondaryInner.seedTransfer(completeEvidence({ providerKind: 'toncenter', jettonMaster }));
    const primary = trackingProvider(primaryInner);
    const secondary = trackingProvider(secondaryInner);

    await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: primary.provider,
      secondary: secondary.provider,
    });
    expect(primary.sendBocCalls()).toBe(0);
    expect(secondary.sendBocCalls()).toBe(0);
  });

  it('12 Attempt count unchanged', async () => {
    const { withdrawalId, attemptId } = await seedReconcileRequiredWithdrawal();
    expect(await attemptCount(withdrawalId)).toBe(1);
    await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(new FakeTonChainProvider()).provider,
      secondary: trackingProvider(new FakeTonChainProvider()).provider,
    });
    expect(await attemptCount(withdrawalId)).toBe(1);
    const q = await pool.query<{ query_id: string }>(
      `SELECT query_id::text AS query_id FROM withdrawal_attempts WHERE id = $1::uuid`,
      [attemptId],
    );
    expect(q.rows[0]?.query_id).toBe(QUERY_ID);
  });

  it('13 Reserved unchanged for ambiguous result', async () => {
    const { withdrawalId, attemptId, userId } = await seedReconcileRequiredWithdrawal();
    const before = await reservedBalance(userId);
    await reconcileRealWithdrawalAttemptOnly(pool, {
      withdrawalId,
      attemptId,
      primary: trackingProvider(new FakeTonChainProvider()).provider,
      secondary: trackingProvider(new FakeTonChainProvider()).provider,
    });
    expect(await reservedBalance(userId)).toBe(before);
    expect(before).toBe(GROSS);
  });
});

describe.skipIf(phase7DatabaseUrl === '')(
  'phase10 real-chain reconcile-only DEFINITIVE_NONPAYMENT (V5R1 expired+unconsumed)',
  () => {
    let pool: Pool;
    let assetId: string;
    let networkId: string;
    let adminUserId: string;
    let hotWalletId: string;
    let jettonMaster: string;
    const engine = localWithdrawalEngineFixtureConfig({ fakeChainEnabled: false });

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
      adminUserId = await createOwnerAdmin(pool, `dnp-v5r1-${Date.now()}@example.local`);
      const master = await pool.query<{ contract_identity: string }>(
        `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
        [assetId],
      );
      jettonMaster = master.rows[0]?.contract_identity ?? '';
      if (jettonMaster === '') {
        jettonMaster = '0:53a1eee8c135c0472b4b75b14880ef1b5798f76d24e78b7f8140899be800c6e8';
        await pool.query(`UPDATE assets SET contract_identity = $2 WHERE id = $1::uuid`, [
          assetId,
          jettonMaster,
        ]);
      }
      hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
        networkId,
        address: HOT_WALLET_RAW,
        friendlyAddress: HOT_WALLET_RAW,
        signerReference: ENCRYPTED_SIGNER_REF,
        payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
      });
      await pool.query(
        `UPDATE feature_flags SET enabled = true, updated_at = now()
         WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
      );
    });

    async function reservedBalance(userId: string): Promise<string> {
      const r = await pool.query<{ bal: string }>(
        `SELECT b.balance_atomic::text AS bal
         FROM ledger_accounts a
         JOIN ledger_account_balances b ON b.ledger_account_id = a.id
         WHERE a.owner_id = $1::uuid AND a.asset_id = $2::uuid
           AND a.account_type = 'USER_RESERVED_LIABILITY'`,
        [userId, assetId],
      );
      return r.rows[0]?.bal ?? '0';
    }

    async function availableBalance(userId: string): Promise<string> {
      const r = await pool.query<{ bal: string }>(
        `SELECT b.balance_atomic::text AS bal
         FROM ledger_accounts a
         JOIN ledger_account_balances b ON b.ledger_account_id = a.id
         WHERE a.owner_id = $1::uuid AND a.asset_id = $2::uuid
           AND a.account_type = 'USER_AVAILABLE_LIABILITY'`,
        [userId, assetId],
      );
      return r.rows[0]?.bal ?? '0';
    }

    async function attemptCount(withdrawalId: string): Promise<number> {
      const r = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
        [withdrawalId],
      );
      return Number(r.rows[0]?.c ?? 0);
    }

    async function seedV5R1Attempt(input: {
      readonly seqno: number;
      readonly validUntilUnix: number;
      readonly tamperCanonicalHash?: boolean;
      readonly unsupportedRequest?: boolean;
    }): Promise<{
      withdrawalId: string;
      attemptId: string;
      userId: string;
      signingMessageHashHex: string;
    }> {
      const {
        buildTestWalletV5R1SignedExternalBoc,
        buildTestExternalInBoc,
      } = await import('@alex-rewards/ton');

      let walletBoc: string;
      let externalBoc: string | null;
      let canonical: string;
      let normHash: string;
      let cellHash: string;
      let signingMessageHashHex: string;

      if (input.unsupportedRequest === true) {
        walletBoc = 'te6cckEBAQEAAgAAAA==';
        externalBoc = null;
        canonical = '04'.repeat(32);
        signingMessageHashHex = canonical;
        normHash = NORM_HASH;
        cellHash = CELL_HASH;
      } else {
        const built = await buildTestWalletV5R1SignedExternalBoc({
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          seqno: input.seqno,
          validUntil: input.validUntilUnix,
          toAddress: PAYOUT_JETTON_WALLET,
        });
        const external = buildTestExternalInBoc({
          walletAddress: HOT_WALLET_RAW,
          signedWalletRequestBocBase64: built.signedWalletRequestBocBase64,
        });
        walletBoc = built.signedWalletRequestBocBase64;
        externalBoc = external.externalMessageBocBase64;
        signingMessageHashHex = built.signingMessageHashHex;
        canonical = input.tamperCanonicalHash ? '11'.repeat(32) : built.signingMessageHashHex;
        normHash = external.normalizedExternalMessageHashHex;
        cellHash = external.externalMessageCellHashHex;
      }

      const userId = await createTestUser(
        pool,
        String(9_200_000_000 + Math.floor(Math.random() * 1e6)),
      );
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
        amountAtomic: GROSS,
        engineConfig: engine,
      });
      await pool.query(
        `UPDATE withdrawals
         SET state = 'RECONCILE_REQUIRED'::withdrawal_state,
             hot_wallet_id = $2::uuid,
             updated_at = now()
         WHERE id = $1::uuid`,
        [withdrawalId, hotWalletId],
      );
      const attempt = await pool.query<{ id: string }>(
        `INSERT INTO withdrawal_attempts (
           withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
           valid_until, canonical_message_hash, signer_key_reference,
           dispatch_fencing_token, broadcast_result_state, broadcast_ambiguity_class,
           requires_state_init, signed_external_message_boc, signed_wallet_request_boc,
           normalized_external_message_hash, external_message_cell_hash,
           signing_started_at, broadcast_started_at, broadcast_submitted_at
         ) VALUES (
           $1::uuid, 1, $2::uuid, $3::bigint, $4::bigint,
           to_timestamp($5::bigint), $6, $7,
           1, 'UNKNOWN', 'UNKNOWN_SUBMIT_OUTCOME',
           false, $8, $9,
           $10, $11,
           now(), now(), now()
         )
         RETURNING id`,
        [
          withdrawalId,
          hotWalletId,
          input.seqno,
          QUERY_ID,
          input.validUntilUnix,
          canonical,
          ENCRYPTED_SIGNER_REF,
          externalBoc,
          walletBoc,
          normHash,
          cellHash,
        ],
      );
      return {
        withdrawalId,
        attemptId: attempt.rows[0]!.id,
        userId,
        signingMessageHashHex,
      };
    }

    it('DNP-1 EXPIRED + UNCONSUMED → DEFINITIVE_NONPAYMENT', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const observedAt = Math.floor(Date.now() / 1000);
      const { withdrawalId, attemptId, userId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const reservedBefore = await reservedBalance(userId);
      const availableBefore = await availableBalance(userId);

      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      const primary = trackingProvider(primaryInner);
      const secondary = trackingProvider(secondaryInner);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: primary.provider,
        secondary: secondary.provider,
        observedAtUnix: observedAt,
      });

      expect(result.classification).toBe('DEFINITIVE_NONPAYMENT');
      expect(result.resolution).toBe('DEFINITIVE_NONPAYMENT');
      expect(result.definitiveNonpaymentReason).toBe(
        'WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO',
      );
      expect(result.definitiveNonpaymentSupported).toBe(true);
      expect(result.withdrawalState).toBe('RECONCILE_REQUIRED');
      expect(result.expectedSeqno).toBe(71);
      expect(result.observedPrimarySeqno).toBe(71);
      expect(result.observedSecondarySeqno).toBe(71);
      expect(result.validUntil).toBe(validUntil);
      expect(result.safety.settled).toBe(false);
      expect(result.safety.confirmed).toBe(false);
      expect(result.safety.rejected).toBe(false);
      expect(result.safety.reservationReleased).toBe(false);
      expect(primary.sendBocCalls()).toBe(0);
      expect(secondary.sendBocCalls()).toBe(0);
      expect(await reservedBalance(userId)).toBe(reservedBefore);
      expect(await availableBalance(userId)).toBe(availableBefore);
      expect(await attemptCount(withdrawalId)).toBe(1);

      const proofs = await pool.query<{ resolution: string }>(
        `SELECT resolution::text AS resolution FROM withdrawal_payout_reconciliations
         WHERE withdrawal_attempt_id = $1::uuid`,
        [attemptId],
      );
      expect(proofs.rows.some((p) => p.resolution === 'DEFINITIVE_NONPAYMENT')).toBe(true);
    });

    it('DNP-2 NOT EXPIRED → AMBIGUOUS', async () => {
      const validUntil = Math.floor(Date.now() / 1000) + 3600;
      const observedAt = Math.floor(Date.now() / 1000);
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: observedAt,
      });
      expect(result.classification).toBe('AMBIGUOUS');
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.definitiveNonpaymentReason).toBeNull();
      expect(result.definitiveNonpaymentGap).toMatch(/not yet expired/i);
    });

    it('DNP-3 SEQNO ADVANCED (both) → not DEFINITIVE_NONPAYMENT', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 72);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 72);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).not.toBe('DEFINITIVE_NONPAYMENT');
      expect(result.definitiveNonpaymentGap).toMatch(/consumed|forensic/i);
    });

    it('DNP-4 PROVIDER SEQNO DISAGREEMENT → no definitive nonpayment', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 72);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.definitiveNonpaymentReason).toBeNull();
      expect(result.definitiveNonpaymentGap).toMatch(/disagreement/i);
    });

    it('DNP-5 PRIMARY SEQNO FAILURE → no definitive nonpayment', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqnoError(HOT_WALLET_RAW, new Error('primary seqno down'));
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.definitiveNonpaymentGap).toMatch(/Primary seqno unavailable/i);
    });

    it('DNP-6 SECONDARY SEQNO FAILURE → no definitive nonpayment', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqnoError(HOT_WALLET_RAW, new Error('secondary seqno down'));

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.definitiveNonpaymentGap).toMatch(/Secondary seqno unavailable/i);
    });

    it('DNP-7 EXISTING INTENDED_PAYOUT_PROVEN blocks DEFINITIVE_NONPAYMENT', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      await pool.query(
        `INSERT INTO withdrawal_payout_reconciliations (
           withdrawal_id, withdrawal_attempt_id, resolution, evidence_summary, resolved_at
         ) VALUES ($1::uuid, $2::uuid, 'INTENDED_PAYOUT_PROVEN', '{}'::jsonb, now())`,
        [withdrawalId, attemptId],
      );
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).not.toBe('DEFINITIVE_NONPAYMENT');
      expect(result.definitiveNonpaymentGap).toMatch(/INTENDED_PAYOUT_PROVEN/i);
      const dnp = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM withdrawal_payout_reconciliations
         WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'DEFINITIVE_NONPAYMENT'`,
        [attemptId],
      );
      expect(dnp.rows[0]?.c).toBe('0');
    });

    it('DNP-8 DUAL COMPLETE wins over expired+unconsumed', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      primaryInner.seedTransfer(completeEvidence({ providerKind: 'tonapi', jettonMaster }));
      secondaryInner.seedTransfer(completeEvidence({ providerKind: 'toncenter', jettonMaster }));

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.classification).toBe('DUAL_PROVIDER_COMPLETE');
      expect(result.resolution).toBe('INTENDED_PAYOUT_PROVEN');
      expect(result.definitiveNonpaymentReason).toBeNull();
    });

    it('DNP-9 SIGNED REQUEST HASH MISMATCH → fail closed', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
        tamperCanonicalHash: true,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.definitiveNonpaymentGap).toMatch(/CANONICAL_HASH_MISMATCH|identity/i);
    });

    it('DNP-10 WRONG / unsupported request → no definitive nonpayment', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
        unsupportedRequest: true,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).toBe('AMBIGUOUS');
      expect(result.definitiveNonpaymentReason).toBeNull();
    });

    it('DNP-11 IDEMPOTENT repeated definitive result', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      const observedAt = Math.floor(Date.now() / 1000);
      const primary = trackingProvider(primaryInner);
      const secondary = trackingProvider(secondaryInner);

      const first = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: primary.provider,
        secondary: secondary.provider,
        observedAtUnix: observedAt,
      });
      const second = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: primary.provider,
        secondary: secondary.provider,
        observedAtUnix: observedAt,
      });
      expect(first.resolution).toBe('DEFINITIVE_NONPAYMENT');
      expect(second.reconciliationId).toBe(first.reconciliationId);
      expect(second.evidenceCreated).toBe(false);
      const count = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM withdrawal_payout_reconciliations
         WHERE withdrawal_attempt_id = $1::uuid AND resolution = 'DEFINITIVE_NONPAYMENT'`,
        [attemptId],
      );
      expect(count.rows[0]?.c).toBe('1');
    });

    it('DNP-12 NO FINANCIAL MUTATION after definitive classification', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId, userId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const reservedBefore = await reservedBalance(userId);
      const availableBefore = await availableBalance(userId);
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);

      await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });

      const w = await pool.query<{ state: string; settlement: string | null }>(
        `SELECT state::text AS state, settlement_ledger_tx_id::text AS settlement
         FROM withdrawals WHERE id = $1::uuid`,
        [withdrawalId],
      );
      expect(w.rows[0]?.state).toBe('RECONCILE_REQUIRED');
      expect(w.rows[0]?.settlement).toBeNull();
      expect(await reservedBalance(userId)).toBe(reservedBefore);
      expect(await availableBalance(userId)).toBe(availableBefore);
      expect(await attemptCount(withdrawalId)).toBe(1);
    });

    it('DNP-13 NO SIGN/BROADCAST (sendBoc never called)', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      const primary = trackingProvider(primaryInner);
      const secondary = trackingProvider(secondaryInner);

      await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: primary.provider,
        secondary: secondary.provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(primary.sendBocCalls()).toBe(0);
      expect(secondary.sendBocCalls()).toBe(0);
    });

    it('DNP-14 Works while PAYOUT_DISPATCH_PAUSE=true', async () => {
      const pause = await pool.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags
         WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
      );
      expect(pause.rows[0]?.enabled).toBe(true);
      const validUntil = Math.floor(Date.now() / 1000) - 3600;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      primaryInner.seedSeqno(HOT_WALLET_RAW, 71);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 71);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).toBe('DEFINITIVE_NONPAYMENT');
      expect(result.safety.pauseBypassedForDispatch).toBe(false);
    });

    it('DNP-15 SEQNO INCREMENT SEMANTIC: current > expected never expired-unconsumed', async () => {
      const validUntil = Math.floor(Date.now() / 1000) - 7200;
      const { withdrawalId, attemptId } = await seedV5R1Attempt({
        seqno: 71,
        validUntilUnix: validUntil,
      });
      const primaryInner = new FakeTonChainProvider();
      const secondaryInner = new FakeTonChainProvider();
      // Model accepted V5R1 request: seqno advanced
      primaryInner.seedSeqno(HOT_WALLET_RAW, 75);
      secondaryInner.seedSeqno(HOT_WALLET_RAW, 75);

      const result = await reconcileRealWithdrawalAttemptOnly(pool, {
        withdrawalId,
        attemptId,
        primary: trackingProvider(primaryInner).provider,
        secondary: trackingProvider(secondaryInner).provider,
        observedAtUnix: Math.floor(Date.now() / 1000),
      });
      expect(result.resolution).not.toBe('DEFINITIVE_NONPAYMENT');
      expect(result.definitiveNonpaymentReason).toBeNull();
      expect(result.definitiveNonpaymentGap).toMatch(/consumed/i);
    });
  },
);
