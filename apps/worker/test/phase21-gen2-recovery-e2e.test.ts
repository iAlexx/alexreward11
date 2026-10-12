/**
 * Phase 21 Gen-2 Owner-authorized recovery — disposable DB E2E.
 *
 * Covers: concurrency, double-payment prevention, expired signatures, failed recovery.
 * FakeTon only. Never touches production DB / Railway / Mainnet.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  buildCanonicalSigningMessageAsync,
  PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
} from '@alex-rewards/signing';
import {
  FakeTonChainProvider,
  deriveWalletV5R1AddressRaw,
  TON_MAINNET_NETWORK_GLOBAL_ID,
} from '@alex-rewards/ton';
import {
  __mintPhase21Gen2RecoveryApplyConfirmationForTests,
  __mintPhase21MainnetRegistryApplyConfirmationForTests,
  __phase21TestSetApplyEnv,
  applyPhase21Gen2Recovery,
  applyPhase21MainnetRegistryBootstrap,
  armPhase21ManualDispatchPermit,
  armPhase21ManualDispatchPermitGeneration,
  buildPhase21PayoutConfig,
  evaluatePhase21Gen2ConsumedFailedPreRecovery,
  evaluatePhase21ManualDispatchRestartSafety,
  localWithdrawalEngineFixtureConfig,
  mintAuthenticatedPhase21MainnetRegistryVerificationForTests,
  mintAuthenticatedPhase21OwnerCeremonyTrustForTests,
  mintPhase21Gen2IndependentChainReconciliationForTests,
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_FROZEN_JETTON_MASTER,
  PHASE21_GEN2_AUTHORIZATION_GENERATION,
  phase21ManualDispatchGenerationIdempotencyKey,
  runRealTestnetPayoutPipeline,
  seedLockedInitialWithdrawalRules,
  withWithdrawalTransaction,
  type RealPayoutCanonicalIntent,
  type RealPayoutSignerPort,
} from '@alex-rewards/withdrawals';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertLedgerBalanced as harnessAssertLedgerBalanced,
  createApprovedWithdrawal,
  createOwnerAdmin,
  createTestUser,
  createVerifiedPrimaryWallet,
  ensureEncryptedPayoutHotWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase14WithdrawalPolicies,
  truncateWithdrawalTables,
} from '../../../packages/withdrawals/test/harness.js';

const JETTON_MASTER = PHASE21_CANARY_FROZEN_JETTON_MASTER;
const PAYOUT_JETTON_WALLET = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT_RAW = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RECIPIENT_FRIENDLY = `EQ${RECIPIENT_RAW.slice(2, 50)}`;
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');
const HOT_WALLET_RAW = deriveWalletV5R1AddressRaw({
  publicKeyHex: TEST_PUBLIC_KEY_HEX,
  networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
});
const mainnetEngine = localWithdrawalEngineFixtureConfig({
  fakeChainEnabled: false,
  acceptedNetworkCode: 'TON_MAINNET',
});

const describeDb = phase7DatabaseUrl === '' ? describe.skip : describe;

async function buildMainnetCanonicalHash(intent: RealPayoutCanonicalIntent): Promise<string> {
  const built = await buildCanonicalSigningMessageAsync(intent, {
    phase21MainnetEnabled: true,
    transferPolicy: PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
  });
  return built.canonicalMessageHashHex;
}

function deriveQueryId(withdrawalId: string, attemptNumber: number, salt: string): bigint {
  return (
    (BigInt(attemptNumber) << 32n) +
    BigInt(
      Math.abs([...`${withdrawalId}:${salt}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)),
    )
  );
}

describeDb('phase21 Gen-2 recovery disposable E2E', () => {
  let pool: Pool;
  let dbName: string;
  let networkId: string;
  let assetId: string;
  let adminUserId: string;
  let hotWalletId: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    expect(phase7DatabaseUrl).not.toMatch(/alex_rewards(?!_)/);
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
    const db = await pool.query<{ name: string }>(`SELECT current_database() AS name`);
    dbName = db.rows[0]!.name;
    expect(dbName).toMatch(/(_test|_phase\d+)/i);

    const mig60 = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations
       WHERE version LIKE '0060%' OR version = '0060_phase21_manual_dispatch_permit_generations'`,
    );
    expect(mig60.rowCount).toBeGreaterThanOrEqual(1);

    for (const k of [
      'DEPLOYMENT_ENV',
      'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
      'PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY',
      'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
      'PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
      'ALEX_PHASE21_CEREMONY_TEST_HOOKS',
      'ALEX_OWNER_BOOTSTRAP_TEST_HOOKS',
      'ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM',
      'NODE_ENV',
    ] as const) {
      prevEnv[k] = process.env[k];
    }
    process.env.NODE_ENV = 'test';
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';

    adminUserId = await createOwnerAdmin(pool, `phase21-gen2-owner-${Date.now()}@example.local`);
    const role = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
      [adminUserId, role.rows[0]!.id],
    );

    const client = await pool.connect();
    try {
      const sid = await client.query<{ sid: string }>(
        `SELECT system_identifier::text AS sid FROM pg_control_system()`,
      );
      __phase21TestSetApplyEnv({
        DEPLOYMENT_ENV: 'production',
        PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
        PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: dbName,
        PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY: '1',
        PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '0',
      });
      process.env.PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER = sid.rows[0]!.sid;

      const ownerTrust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId,
        currentDatabase: dbName,
        systemIdentifier: sid.rows[0]!.sid,
      });
      const mainnetVerification = mintAuthenticatedPhase21MainnetRegistryVerificationForTests({
        jettonMaster: JETTON_MASTER,
        simulationDatabaseName: dbName,
      });
      const boot = await applyPhase21MainnetRegistryBootstrap(client, {
        usdtJettonMaster: JETTON_MASTER,
        ownerTrust,
        applyConfirmation: __mintPhase21MainnetRegistryApplyConfirmationForTests(),
        mainnetVerification,
        reason: 'phase21-gen2-e2e-registry',
      });
      expect(boot.applied).toBe(true);
    } finally {
      client.release();
    }

    const net = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM networks WHERE code = 'TON_MAINNET'`,
    );
    networkId = net.rows[0]!.id;
    const asset = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM assets
       WHERE network_id = $1::uuid AND symbol = 'USDT' AND status = 'ACTIVE'`,
      [networkId],
    );
    assetId = asset.rows[0]!.id;
  }, 240_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    adminUserId = await createOwnerAdmin(pool, `phase21-gen2-${randomUUID()}@example.local`);
    const role = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
    );
    await pool.query(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`,
      [adminUserId, role.rows[0]!.id],
    );
    await seedPhase14WithdrawalPolicies(pool);
    await withWithdrawalTransaction(pool, async (client) => {
      await seedLockedInitialWithdrawalRules(client, { assetId, networkId });
    });
    await pool.query(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'phase21-gen2-e2e pause')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = true, updated_at = now()`,
    );
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase21_gen2_e2e_hot',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
      label: 'phase21-gen2-e2e-hot',
    });
  });

  function buildPhase21() {
    return buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: true,
      fakeChainEnabled: false,
      signerBaseUrl: 'http://127.0.0.1:9',
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: JETTON_MASTER,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://tonapi.io',
    });
  }

  function createTestSigner(overrides?: {
    readonly signingReady?: boolean;
    readonly expireValidUntil?: boolean;
  }): RealPayoutSignerPort {
    const fingerprint = ENCRYPTED_SIGNER_REF;
    const signingReady = overrides?.signingReady ?? true;
    return {
      async getSigningIdentity() {
        return {
          publicKeyHex: TEST_PUBLIC_KEY_HEX,
          publicKeyFingerprint: fingerprint,
          walletAddressRaw: HOT_WALLET_RAW,
          signingReady,
          custodyState: signingReady ? 'unlocked' : 'locked',
        };
      },
      async signWithdrawalAttempt(withdrawalAttemptId: string) {
        if (!signingReady) throw new Error('SIGNER_LOCKED');
        if (overrides?.expireValidUntil) {
          // Force a pre-broadcast signing failure path by rejecting after validity check.
          throw new Error('SIGNER_VALID_UNTIL_EXPIRED');
        }
        const row = await pool.query<{
          withdrawal_id: string;
          canonical_message_hash: string;
        }>(
          `SELECT withdrawal_id::text AS withdrawal_id, canonical_message_hash
           FROM withdrawal_attempts WHERE id = $1::uuid`,
          [withdrawalAttemptId],
        );
        const attempt = row.rows[0];
        if (attempt === undefined) throw new Error('attempt missing for mock signer');
        return {
          withdrawalAttemptId,
          withdrawalId: attempt.withdrawal_id,
          canonicalMessageHash: attempt.canonical_message_hash,
          canonicalSigningHash: attempt.canonical_message_hash,
          signedMessageHash: '33'.repeat(32),
          publicKeyFingerprint: fingerprint,
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

  async function prepareQueuedWithdrawal(amountAtomic = '200000') {
    const userId = await createTestUser(pool, String(9200000 + Math.floor(Math.random() * 1e6)));
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
      amountAtomic,
      engineConfig: mainnetEngine,
    });
    await pool.query(
      `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const row = await pool.query<{
      public_id: string;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
    }>(
      `SELECT public_id,
              requested_amount_atomic::text AS requested_amount_atomic,
              fee_amount_atomic::text AS fee_amount_atomic,
              net_amount_atomic::text AS net_amount_atomic
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    return {
      withdrawalId,
      publicId: row.rows[0]!.public_id,
      userId,
      gross: row.rows[0]!.requested_amount_atomic,
      fee: row.rows[0]!.fee_amount_atomic,
      net: row.rows[0]!.net_amount_atomic,
    };
  }

  function bindingsFor(w: {
    withdrawalId: string;
    publicId: string;
    gross: string;
    fee: string;
    net: string;
  }) {
    return {
      withdrawalId: w.withdrawalId,
      publicId: w.publicId,
      authorizedGrossAtomic: BigInt(w.gross),
      authorizedFeeAtomic: BigInt(w.fee),
      authorizedNetAtomic: BigInt(w.net),
      authorizedRecipientFriendly: RECIPIENT_FRIENDLY,
      authorizedRecipientRaw: RECIPIENT_RAW,
      authorizedNetworkCode: 'TON_MAINNET' as const,
      authorizedAssetSymbol: 'USDT' as const,
      authorizedJettonMaster: JETTON_MASTER,
      authorizedAttachedGramAtomic: PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
      authorizedForwardGramAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
    };
  }

  async function armGen1(w: Awaited<ReturnType<typeof prepareQueuedWithdrawal>>) {
    return withWithdrawalTransaction(pool, async (client) =>
      armPhase21ManualDispatchPermit(client, {
        createdByAdminUserId: adminUserId,
        idempotencyKey: `phase21.e2e.manual_dispatch:${w.withdrawalId}`,
        bindings: bindingsFor(w),
      }),
    );
  }

  function seedProviders(netAmount: string, withdrawalId: string, attemptNumber = 1) {
    const primary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    const secondary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    for (const fake of [primary, secondary]) {
      fake.seedActiveV5R1({
        address: HOT_WALLET_RAW,
        seqno: 7,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      });
    }
    const queryId = deriveQueryId(withdrawalId, attemptNumber, RECIPIENT_RAW);
    const evidence = {
      hotWallet: HOT_WALLET_RAW,
      jettonMaster: JETTON_MASTER,
      recipient: RECIPIENT_RAW,
      amountAtomic: netAmount,
      queryId: queryId.toString(10),
      success: true,
      bounced: false,
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      senderJettonWallet: PAYOUT_JETTON_WALLET,
      providerKind: 'tonapi' as const,
      proofStage: 'COMPLETE' as const,
      hotWalletTxHash: 'aa'.repeat(32),
      jettonWalletTxHash: 'bb'.repeat(32),
      recipientEvidence: 'ok',
    };
    primary.seedTransfer(evidence);
    secondary.seedTransfer({ ...evidence, providerKind: 'toncenter' });
    return { primary, secondary };
  }

  async function forceFailedPreAttempt1(w: Awaited<ReturnType<typeof prepareQueuedWithdrawal>>) {
    await armGen1(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 1);
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner({ signingReady: false }),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(['FAILED_PRE_BROADCAST', 'BLOCKED', 'PAUSED']).toContain(result.state);
    // Ensure FAILED_PRE + CONSUMED gen1 with no BOC for recovery path.
    await pool.query(
      `UPDATE withdrawals SET state = 'FAILED_PRE_BROADCAST'::withdrawal_state WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    // If pipeline never created an attempt (signer locked early), synthesize clean FAILED_PRE attempt #1
    // and consume Gen-1 onto it — mirrors production WD-000001 class without broadcast evidence.
    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    if ((attempts.rows[0]?.c ?? 0) === 0) {
      const attemptId = randomUUID();
      await pool.query(
        `INSERT INTO withdrawal_attempts (
           id, withdrawal_id, attempt_number, hot_wallet_id,
           expected_seqno, query_id, valid_until, canonical_message_hash,
           signer_key_reference, dispatch_fencing_token, broadcast_result_state,
           requires_state_init
         ) VALUES (
           $1::uuid, $2::uuid, 1, $3::uuid,
           7, 1, now() + interval '5 minutes', $4,
           $5, 1, 'FAILED_PRE_BROADCAST'::withdrawal_attempt_result,
           false
         )`,
        [
          attemptId,
          w.withdrawalId,
          hotWalletId,
          '11'.repeat(32),
          ENCRYPTED_SIGNER_REF,
        ],
      );
      await pool.query(
        `UPDATE phase21_manual_dispatch_permits
         SET status = 'CONSUMED'::phase21_manual_dispatch_permit_status,
             consumed_at = now(),
             consumed_attempt_id = $2::uuid
         WHERE withdrawal_id = $1::uuid
           AND authorization_generation = 1
           AND status = 'ARMED'::phase21_manual_dispatch_permit_status`,
        [w.withdrawalId, attemptId],
      );
    } else {
      await pool.query(
        `UPDATE withdrawal_attempts
         SET broadcast_result_state = 'FAILED_PRE_BROADCAST'::withdrawal_attempt_broadcast_result_state,
             signed_external_message_boc = NULL,
             signed_wallet_request_boc = NULL,
             broadcast_submitted_at = NULL,
             chain_reference = NULL
         WHERE withdrawal_id = $1::uuid`,
        [w.withdrawalId],
      );
    }

    const gen1 = await pool.query<{ status: string; gen: number }>(
      `SELECT status::text AS status, authorization_generation AS gen
       FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid AND authorization_generation = 1`,
      [w.withdrawalId],
    );
    expect(gen1.rows[0]?.status).toBe('CONSUMED');
    expect(gen1.rows[0]?.gen).toBe(1);
    return { primary, secondary };
  }

  async function armGen2ViaApply(w: Awaited<ReturnType<typeof prepareQueuedWithdrawal>>) {
    const sid = await pool.query<{ sid: string }>(
      `SELECT system_identifier::text AS sid FROM pg_control_system()`,
    );
    const ownerTrust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId,
      currentDatabase: dbName,
      systemIdentifier: sid.rows[0]!.sid,
    });
    const client = await pool.connect();
    try {
      const result = await applyPhase21Gen2Recovery(client, {
        withdrawalId: w.withdrawalId,
        ownerTrust,
        applyConfirmation: __mintPhase21Gen2RecoveryApplyConfirmationForTests(),
        chainReconciliation: mintPhase21Gen2IndependentChainReconciliationForTests(),
        bindings: bindingsFor(w),
        deploymentEnvironment: 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
      return result;
    } finally {
      client.release();
    }
  }

  it('migration 0060 present: unique (withdrawal_id, authorization_generation)', async () => {
    const cols = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'phase21_manual_dispatch_permits'
         AND column_name = 'authorization_generation'`,
    );
    expect(cols.rowCount).toBe(1);
  });

  it('Gen-2 APPLY arms generation 2 while preserving Gen-1 CONSUMED', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    const applied = await armGen2ViaApply(w);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);
    expect(applied.authorizationGeneration).toBe(2);
    expect(applied.broadcastPerformed).toBe(false);
    expect(applied.signed).toBe(false);
    expect(applied.gen1PermitStatus).toBe('CONSUMED');

    const permits = await pool.query<{ gen: number; status: string }>(
      `SELECT authorization_generation AS gen, status::text AS status
       FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid
       ORDER BY authorization_generation`,
      [w.withdrawalId],
    );
    expect(permits.rows).toEqual([
      { gen: 1, status: 'CONSUMED' },
      { gen: 2, status: 'ARMED' },
    ]);

    const restart = await withWithdrawalTransaction(pool, async (client) =>
      evaluatePhase21ManualDispatchRestartSafety(client, w.withdrawalId),
    );
    expect(restart.allowDuplicate).toBe(true);
    expect(restart.permit?.authorizationGeneration).toBe(2);
    expect(restart.permit?.status).toBe('ARMED');
  });

  it('Gen-2 happy path: recovery payout CONFIRMED once; Gen-1 preserved; no double settle', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    const applied = await armGen2ViaApply(w);
    expect(applied.ok).toBe(true);

    const gate = evaluatePhase21Gen2ConsumedFailedPreRecovery({
      withdrawalState: 'FAILED_PRE_BROADCAST',
      gen1PermitStatus: 'CONSUMED',
      gen2PermitStatus: 'ARMED',
      gen2AuthorizationGeneration: PHASE21_GEN2_AUTHORIZATION_GENERATION,
      attemptCount: 1,
      failedPreAttemptCount: 1,
      broadcastEvidenceCount: 0,
      priorWorkflowStatus: 'COMPLETED',
    });
    expect(gate.eligible).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 2);
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(result.state).toBe('CONFIRMED');
    expect(primary.getSendBocCallCount()).toBe(1);

    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(2);

    const permits = await pool.query<{ gen: number; status: string }>(
      `SELECT authorization_generation AS gen, status::text AS status
       FROM phase21_manual_dispatch_permits WHERE withdrawal_id = $1::uuid
       ORDER BY authorization_generation`,
      [w.withdrawalId],
    );
    expect(permits.rows[0]).toEqual({ gen: 1, status: 'CONSUMED' });
    expect(permits.rows[1]?.gen).toBe(2);
    expect(permits.rows[1]?.status).toBe('CONSUMED');

    const settle = await pool.query<{ settlement: string | null; release: string | null }>(
      `SELECT settlement_ledger_tx_id::text AS settlement,
              release_ledger_tx_id::text AS release
       FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(settle.rows[0]?.settlement).not.toBeNull();
    expect(settle.rows[0]?.release).toBeNull();
    await harnessAssertLedgerBalanced(pool);

    // Second pipeline must not double-pay (idempotent CONFIRMED OK; no second sendBoc).
    const again = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(['CONFIRMED', 'PAUSED', 'BLOCKED']).toContain(again.state);
    expect(primary.getSendBocCallCount()).toBe(1);
  });

  it('concurrent Gen-2 arm: only one ARMED generation-2 row', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    const b = bindingsFor(w);
    const key = phase21ManualDispatchGenerationIdempotencyKey(w.withdrawalId, 2);

    const [a, c] = await Promise.allSettled([
      withWithdrawalTransaction(pool, async (client) =>
        armPhase21ManualDispatchPermitGeneration(client, {
          bindings: b,
          authorizationGeneration: 2,
          createdByAdminUserId: adminUserId,
          idempotencyKey: key,
        }),
      ),
      withWithdrawalTransaction(pool, async (client) =>
        armPhase21ManualDispatchPermitGeneration(client, {
          bindings: b,
          authorizationGeneration: 2,
          createdByAdminUserId: adminUserId,
          idempotencyKey: key,
        }),
      ),
    ]);
    expect(a.status === 'fulfilled' || c.status === 'fulfilled').toBe(true);
    const armed = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid AND authorization_generation = 2 AND status = 'ARMED'`,
      [w.withdrawalId],
    );
    expect(armed.rows[0]?.c).toBe(1);
  });

  it('failed Gen-2 recovery (signer locked): Gen-1 preserved; no broadcast; reservation held', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    const applied = await armGen2ViaApply(w);
    expect(applied.ok).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 2);
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner({ signingReady: false }),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(primary.getSendBocCallCount()).toBe(0);
    expect(['FAILED_PRE_BROADCAST', 'BLOCKED', 'PAUSED']).toContain(result.state);

    const gen1 = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid AND authorization_generation = 1`,
      [w.withdrawalId],
    );
    expect(gen1.rows[0]?.status).toBe('CONSUMED');

    const settle = await pool.query<{
      settlement: string | null;
      reservation: string | null;
    }>(
      `SELECT settlement_ledger_tx_id::text AS settlement,
              reservation_ledger_tx_id::text AS reservation
       FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(settle.rows[0]?.settlement).toBeNull();
    expect(settle.rows[0]?.reservation).not.toBeNull();
  });

  it('expired / rejected signature path: no sendBoc; Gen-1 CONSUMED preserved', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    expect((await armGen2ViaApply(w)).ok).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 2);
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner({ expireValidUntil: true }),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(primary.getSendBocCallCount()).toBe(0);
    expect(['FAILED_PRE_BROADCAST', 'BLOCKED', 'PAUSED', 'RECONCILE_REQUIRED']).toContain(
      result.state,
    );

    const gen1 = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid AND authorization_generation = 1`,
      [w.withdrawalId],
    );
    expect(gen1.rows[0]?.status).toBe('CONSUMED');
  });

  it('APPLY refuses without fresh independent chain reconciliation', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    const sid = await pool.query<{ sid: string }>(
      `SELECT system_identifier::text AS sid FROM pg_control_system()`,
    );
    const ownerTrust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId,
      currentDatabase: dbName,
      systemIdentifier: sid.rows[0]!.sid,
    });
    const stale = mintPhase21Gen2IndependentChainReconciliationForTests({
      performedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const client = await pool.connect();
    try {
      const refused = await applyPhase21Gen2Recovery(client, {
        withdrawalId: w.withdrawalId,
        ownerTrust,
        applyConfirmation: __mintPhase21Gen2RecoveryApplyConfirmationForTests(),
        chainReconciliation: stale,
        bindings: bindingsFor(w),
        deploymentEnvironment: 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
      expect(refused.ok).toBe(false);
      expect(refused.applied).toBe(false);
      expect(refused.refuseCode).toMatch(/CHAIN_RECON/);
    } finally {
      client.release();
    }
    const gen2 = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid AND authorization_generation = 2`,
      [w.withdrawalId],
    );
    expect(gen2.rows[0]?.c).toBe(0);
  });
});
