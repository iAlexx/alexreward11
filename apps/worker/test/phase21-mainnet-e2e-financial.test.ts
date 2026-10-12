/**
 * Phase 21 Mainnet USDT payout — full disposable-DB E2E + adversarial/recovery.
 *
 * SAFETY:
 * - Requires PHASE7_DATABASE_URL pointing at an approved *_test / *_phaseN DB.
 * - Uses FakeTonChainProvider(-239) + mock RealPayoutSignerPort only.
 * - Never touches production Postgres, Railway, Temporal, or real Mainnet.
 * - Exercises runRealTestnetPayoutPipeline (real production engine path).
 * - Lives under apps/worker so Turbo stays acyclic (worker depends on both
 *   @alex-rewards/signing and @alex-rewards/withdrawals; those packages must
 *   not depend on each other).
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  buildCanonicalSigningMessageAsync,
  PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
} from '@alex-rewards/signing';
import {
  FakeTonChainProvider,
  TonProviderHttpError,
  deriveWalletV5R1AddressRaw,
  TON_MAINNET_NETWORK_GLOBAL_ID,
  TON_TESTNET_NETWORK_GLOBAL_ID,
} from '@alex-rewards/ton';
import {
  PipelineCrashError,
  __mintPhase21MainnetRegistryApplyConfirmationForTests,
  __phase21TestSetApplyEnv,
  applyPhase21MainnetRegistryBootstrap,
  armPhase21ManualDispatchPermit,
  buildPhase21PayoutConfig,
  evaluatePhase21CanaryFailedPreZeroAttemptRecovery,
  evaluatePhase21ManualDispatchRestartSafety,
  isPhase21CanaryPriorWorkflowSafeToRestart,
  isPhase21CanaryWithdrawalStateAllowedForResume,
  localWithdrawalEngineFixtureConfig,
  mintAuthenticatedPhase21MainnetRegistryVerificationForTests,
  mintAuthenticatedPhase21OwnerCeremonyTrustForTests,
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_FROZEN_JETTON_MASTER,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  runRealTestnetPayoutPipeline,
  seedLockedInitialWithdrawalRules,
  withWithdrawalTransaction,
  WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
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

/** Production Worker/Signer Mainnet canonical hash path (no mocks). */
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

describeDb('phase21 Mainnet disposable E2E financial validation', () => {
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
    expect(dbName.toLowerCase()).not.toBe('alex_rewards');

    const mig = await pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version LIKE '0059%' OR version = '0059'`,
    );
    expect(mig.rowCount).toBeGreaterThanOrEqual(1);
    const permits = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('public.phase21_manual_dispatch_permits')::text AS reg`,
    );
    expect(permits.rows[0]?.reg).toBe('phase21_manual_dispatch_permits');

    // Bootstrap TON_MAINNET + USDT via production registry APPLY path (ceremony test hooks).
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

    adminUserId = await createOwnerAdmin(pool, `phase21-e2e-owner-${Date.now()}@example.local`);
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
        reason: 'phase21-e2e-disposable-mainnet-registry',
      });
      expect(boot.applied).toBe(true);
    } finally {
      client.release();
    }

    const net = await pool.query<{ id: string; gci: string }>(
      `SELECT id::text AS id, global_chain_identifier AS gci
       FROM networks WHERE code = 'TON_MAINNET'`,
    );
    expect(net.rows[0]?.gci).toBe('ton:mainnet');
    networkId = net.rows[0]!.id;
    const asset = await pool.query<{ id: string; decimals: number; contract_identity: string }>(
      `SELECT id::text AS id, decimals, contract_identity
       FROM assets WHERE network_id = $1::uuid AND symbol = 'USDT' AND status = 'ACTIVE'`,
      [networkId],
    );
    expect(asset.rows[0]?.decimals).toBe(6);
    expect(asset.rows[0]?.contract_identity).toBe(JETTON_MASTER);
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
    // Keep Mainnet registry rows; re-seed operational fixtures per case.
    adminUserId = await createOwnerAdmin(pool, `phase21-e2e-${randomUUID()}@example.local`);
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
       VALUES ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'phase21-e2e pause')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = true, updated_at = now()`,
    );
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase21_e2e_hot',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
      label: 'phase21-e2e-hot',
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
    readonly fingerprint?: string;
  }): RealPayoutSignerPort {
    const fingerprint = overrides?.fingerprint ?? ENCRYPTED_SIGNER_REF;
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
        if (!signingReady) {
          throw new Error('SIGNER_LOCKED');
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

  async function prepareQueuedWithdrawal(amountAtomic = '200000'): Promise<{
    readonly withdrawalId: string;
    readonly publicId: string;
    readonly userId: string;
    readonly gross: string;
    readonly fee: string;
    readonly net: string;
  }> {
    const userId = await createTestUser(pool, String(9100000 + Math.floor(Math.random() * 1e6)));
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

  async function armPermit(input: {
    readonly withdrawalId: string;
    readonly publicId: string;
    readonly gross: string;
    readonly fee: string;
    readonly net: string;
    readonly recipientRaw?: string;
    readonly recipientFriendly?: string;
    readonly jettonMaster?: string;
  }) {
    return withWithdrawalTransaction(pool, async (client) =>
      armPhase21ManualDispatchPermit(client, {
        createdByAdminUserId: adminUserId,
        idempotencyKey: `phase21.e2e.manual_dispatch:${input.withdrawalId}`,
        bindings: {
          withdrawalId: input.withdrawalId,
          publicId: input.publicId,
          authorizedGrossAtomic: BigInt(input.gross),
          authorizedFeeAtomic: BigInt(input.fee),
          authorizedNetAtomic: BigInt(input.net),
          authorizedRecipientFriendly: input.recipientFriendly ?? RECIPIENT_FRIENDLY,
          authorizedRecipientRaw: input.recipientRaw ?? RECIPIENT_RAW,
          authorizedNetworkCode: 'TON_MAINNET',
          authorizedAssetSymbol: 'USDT',
          authorizedJettonMaster: input.jettonMaster ?? JETTON_MASTER,
          authorizedAttachedGramAtomic: PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
          authorizedForwardGramAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
        },
      }),
    );
  }

  function seedProviders(netAmount: string, withdrawalId: string, options?: {
    readonly primary?: FakeTonChainProvider;
    readonly secondary?: FakeTonChainProvider;
    readonly seqno?: number;
    readonly mismatchSecondaryAmount?: boolean;
    readonly omitSecondaryTransfer?: boolean;
  }) {
    const primary =
      options?.primary ??
      new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    const secondary =
      options?.secondary ??
      new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    const seqno = options?.seqno ?? 7;
    for (const fake of [primary, secondary]) {
      fake.seedActiveV5R1({
        address: HOT_WALLET_RAW,
        seqno,
        publicKeyHex: TEST_PUBLIC_KEY_HEX,
        networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      });
    }
    const queryId = deriveQueryId(withdrawalId, 1, RECIPIENT_RAW);
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
    if (!options?.omitSecondaryTransfer) {
      secondary.seedTransfer({
        ...evidence,
        amountAtomic: options?.mismatchSecondaryAmount ? '1' : netAmount,
        providerKind: 'toncenter',
      });
    }
    return { primary, secondary, queryId };
  }

  it('infra: disposable DB is independent of production alex_rewards', async () => {
    const row = await pool.query<{ name: string; addr: string | null }>(
      `SELECT current_database() AS name, inet_server_addr()::text AS addr`,
    );
    expect(row.rows[0]!.name).toBe(dbName);
    expect(row.rows[0]!.name.toLowerCase()).not.toBe('alex_rewards');
  });

  it('full Mainnet payout: permit ARM → pipeline → CONFIRMED + single settlement', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    const armed = await armPermit(w);
    expect(armed.permit.status).toBe('ARMED');

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
    const phase21 = buildPhase21();
    expect(phase21.networkGlobalId).toBe(-239);

    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21,
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });

    expect(result.state).toBe('CONFIRMED');
    expect(result.attemptId).not.toBeNull();
    expect(result.seqno).toBe(7);
    expect(primary.getSendBocCallCount()).toBe(1);
    expect(result.stagesCompleted).toEqual(
      expect.arrayContaining([
        'phase21_manual_dispatch_permit_pause_exception',
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

    const permit = await pool.query<{
      status: string;
      consumed_attempt_id: string | null;
    }>(
      `SELECT status::text AS status, consumed_attempt_id::text AS consumed_attempt_id
       FROM phase21_manual_dispatch_permits WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(permit.rows[0]?.status).toBe('CONSUMED');
    expect(permit.rows[0]?.consumed_attempt_id).toBe(result.attemptId);

    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(1);

    const wd = await pool.query<{
      state: string;
      settlement_ledger_tx_id: string | null;
    }>(
      `SELECT state::text AS state, settlement_ledger_tx_id::text AS settlement_ledger_tx_id
       FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(wd.rows[0]?.state).toBe('CONFIRMED');
    expect(wd.rows[0]?.settlement_ledger_tx_id).toBeTruthy();

    // Idempotent re-run must not double-send or double-settle.
    const again = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21,
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(again.state).toBe('CONFIRMED');
    expect(primary.getSendBocCallCount()).toBe(1);
    const settlements = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawals
       WHERE id = $1::uuid AND settlement_ledger_tx_id IS NOT NULL`,
      [w.withdrawalId],
    );
    expect(settlements.rows[0]?.c).toBe(1);
    await harnessAssertLedgerBalanced(pool);
  });

  it('refuses Mainnet/Testnet provider mismatch at admission', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const primary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    const secondary = new FakeTonChainProvider({ networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID });
    primary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 3,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
    });
    secondary.seedActiveV5R1({
      address: HOT_WALLET_RAW,
      seqno: 3,
      publicKeyHex: TEST_PUBLIC_KEY_HEX,
      networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
    });
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
    expect(result.state).toBe('BLOCKED');
    expect(String(result.reason)).toMatch(/PROVIDER_NETWORK_MISMATCH|NETWORK|seqno|ADMISSION/i);
    expect(primary.getSendBocCallCount()).toBe(0);
    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(0);
  });

  it('refuses wrong signer fingerprint (no unauthorized signature)', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner({ fingerprint: 'aa'.repeat(32) }),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(['BLOCKED', 'FAILED_PRE_BROADCAST']).toContain(result.state);
    expect(primary.getSendBocCallCount()).toBe(0);
  });

  it('blocks when signer locked', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
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
    expect(result.state).toBe('BLOCKED');
    expect(String(result.reason)).toMatch(/signer|locked|RESOURCE/i);
    expect(primary.getSendBocCallCount()).toBe(0);
  });

  it('provider HTTP 429 during seqno admission fails closed without attempt', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const primary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    const secondary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    primary.seedTransientAccountStateErrors(HOT_WALLET_RAW, [
      new TonProviderHttpError(429, 'rate limited', 'getAccountState'),
      new TonProviderHttpError(429, 'rate limited', 'getAccountState'),
      new TonProviderHttpError(429, 'rate limited', 'getAccountState'),
    ]);
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      seqnoAdmissionRateLimitMaxAttempts: 1,
      seqnoAdmissionRateLimitBaseDelayMs: 0,
      seqnoAdmissionSleepMs: async () => {},
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(['BLOCKED', 'FAILED_PRE_BROADCAST']).toContain(result.state);
    expect(primary.getSendBocCallCount()).toBe(0);
  });

  it('conflicting dual-provider transfer evidence does not settle', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, {
      mismatchSecondaryAmount: true,
    });
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
    expect(result.state).not.toBe('CONFIRMED');
    expect(['RECONCILE_REQUIRED', 'CONFIRMING', 'BROADCASTED', 'BLOCKED']).toContain(result.state);
    const wd = await pool.query<{ settlement_ledger_tx_id: string | null }>(
      `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(wd.rows[0]?.settlement_ledger_tx_id).toBeNull();
  });

  it('one-provider-only confirmation does not settle', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, {
      omitSecondaryTransfer: true,
    });
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
    expect(result.state).not.toBe('CONFIRMED');
    const wd = await pool.query<{ settlement_ledger_tx_id: string | null }>(
      `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(wd.rows[0]?.settlement_ledger_tx_id).toBeNull();
  });

  it('broadcast accepted=false never marks BROADCASTED / never settles', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const primary = new FakeTonChainProvider({
      networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
      sendBocAcceptedFalse: true,
    });
    const secondary = new FakeTonChainProvider({ networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID });
    const seeded = seedProviders(w.net, w.withdrawalId, { primary, secondary });
    const result = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: seeded.primary,
      secondaryChainProvider: seeded.secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    });
    expect(result.state).not.toBe('CONFIRMED');
    expect(result.state).not.toBe('BROADCASTED');
    const wd = await pool.query<{ state: string; settlement_ledger_tx_id: string | null }>(
      `SELECT state::text AS state, settlement_ledger_tx_id
       FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(wd.rows[0]?.settlement_ledger_tx_id).toBeNull();
    expect(wd.rows[0]?.state).not.toBe('BROADCASTED');
  });

  it('crash after signed BOC persist then resume does not duplicate sendBoc', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
    const base = {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true as const,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    };
    let crash: unknown;
    try {
      await runRealTestnetPayoutPipeline(pool, {
        ...base,
        crashAfter: 'AFTER_BOC_PERSISTED',
      });
    } catch (error) {
      crash = error;
    }
    expect(crash).toBeInstanceOf(PipelineCrashError);
    expect(primary.getSendBocCallCount()).toBe(0);
    const recovered = await runRealTestnetPayoutPipeline(pool, base);
    expect(recovered.state).toBe('CONFIRMED');
    expect(primary.getSendBocCallCount()).toBe(1);
    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(1);
  });

  it('crash after attempt create: resume consumes permit once and settles once', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
    const base = {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true as const,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    };
    await expect(
      runRealTestnetPayoutPipeline(pool, { ...base, crashAfter: 'AFTER_ATTEMPT_CREATED' }),
    ).rejects.toBeInstanceOf(PipelineCrashError);
    const midPermit = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(midPermit.rows[0]?.status).toBe('CONSUMED');
    const recovered = await runRealTestnetPayoutPipeline(pool, base);
    expect(recovered.state).toBe('CONFIRMED');
    expect(primary.getSendBocCallCount()).toBe(1);
  });

  it('duplicate concurrent pipeline runners: at most one sendBoc', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await armPermit(w);
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
    const input = {
      withdrawalId: w.withdrawalId,
      phase21: buildPhase21(),
      engine: mainnetEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer: createTestSigner(),
      allowTestExecutionPath: true as const,
      buildCanonicalMessageHash: buildMainnetCanonicalHash,
    };
    const [a, b] = await Promise.allSettled([
      runRealTestnetPayoutPipeline(pool, input),
      runRealTestnetPayoutPipeline(pool, input),
    ]);
    expect(a.status === 'fulfilled' || b.status === 'fulfilled').toBe(true);
    expect(primary.getSendBocCallCount()).toBeLessThanOrEqual(1);
    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(1);
    const wd = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    // One runner confirms; the other may pause/block/confirm idempotently.
    expect([
      'CONFIRMED',
      'PAUSED',
      'BLOCKED',
      'QUEUED',
      'SIGNING',
      'BROADCASTING',
      'FAILED_PRE_BROADCAST',
      'RECONCILE_REQUIRED',
    ]).toContain(wd.rows[0]?.state);
    if (wd.rows[0]?.state === 'CONFIRMED') {
      expect(primary.getSendBocCallCount()).toBe(1);
    }
  });

  it('without ARMED permit, PAYOUT_DISPATCH_PAUSE blocks dispatch', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
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
    expect(result.state).toBe('PAUSED');
    expect(primary.getSendBocCallCount()).toBe(0);
  });

  it('WD-000001-equivalent recovery: QUEUED+ARMED+0 attempts+DISPATCHED+COMPLETED allows payout', async () => {
    // Disposable reproduction of the last observed production state class.
    // Does NOT mutate live WD-000001; uses a fresh withdrawal + exact gate helpers.
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('QUEUED')).toBe(true);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('COMPLETED')).toBe(true);
    expect(PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    const w = await prepareQueuedWithdrawal('200000');
    const armed = await armPermit(w);
    expect(armed.permit.status).toBe('ARMED');

    await pool.query(
      `INSERT INTO outbox_events (
         aggregate_type, aggregate_id, event_type, dedupe_key, payload, status, dispatched_at
       ) VALUES (
         'withdrawal', $1::uuid, $2, $3,
         jsonb_build_object('withdrawalId', $1::text, 'simulatedPriorDispatch', true),
         'DISPATCHED', now()
       )`,
      [
        w.withdrawalId,
        WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
        ('withdrawal.phase21_manual_dispatch:' + w.withdrawalId + ':' + armed.permit.id),
      ],
    );

    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(0);

    const restart = await withWithdrawalTransaction(pool, async (client) =>
      evaluatePhase21ManualDispatchRestartSafety(client, w.withdrawalId),
    );
    expect(restart.allowDuplicate).toBe(true);
    expect(restart.permit?.status).toBe('ARMED');

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
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

    const permit = await pool.query<{ status: string; consumed_attempt_id: string | null }>(
      `SELECT status::text AS status, consumed_attempt_id::text AS consumed_attempt_id
       FROM phase21_manual_dispatch_permits WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(permit.rows[0]?.status).toBe('CONSUMED');
    expect(permit.rows[0]?.consumed_attempt_id).toBe(result.attemptId);

    const outbox = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM outbox_events
       WHERE aggregate_id = $1::uuid AND event_type = $2`,
      [w.withdrawalId, WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT],
    );
    expect(outbox.rows.some((r) => r.status === 'DISPATCHED')).toBe(true);

    // Second ALLOW_DUPLICATE restart must refuse once attempt exists / permit consumed.
    const restartAfter = await withWithdrawalTransaction(pool, async (client) =>
      evaluatePhase21ManualDispatchRestartSafety(client, w.withdrawalId),
    );
    expect(restartAfter.allowDuplicate).toBe(false);
    await harnessAssertLedgerBalanced(pool);
  });

  it('WD-000001 FAILED_PRE_BROADCAST recovery: ARMED+0 attempts+no evidence+COMPLETED → CONFIRMED', async () => {
    // Disposable only — never mutates live WD-000001 / production DB.
    expect(isPhase21CanaryWithdrawalStateAllowedForResume('FAILED_PRE_BROADCAST')).toBe(true);
    expect(isPhase21CanaryPriorWorkflowSafeToRestart('COMPLETED')).toBe(true);

    const eligible = evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
      withdrawalState: 'FAILED_PRE_BROADCAST',
      permitStatus: 'ARMED',
      attemptCount: 0,
      broadcastEvidenceCount: 0,
      priorWorkflowStatus: 'COMPLETED',
    });
    expect(eligible).toEqual({ eligible: true, reason: null });

    expect(
      evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        permitStatus: 'CONSUMED',
        attemptCount: 0,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'COMPLETED',
      }).eligible,
    ).toBe(false);
    expect(
      evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        permitStatus: 'ARMED',
        attemptCount: 1,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'COMPLETED',
      }).eligible,
    ).toBe(false);
    expect(
      evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        permitStatus: 'ARMED',
        attemptCount: 0,
        broadcastEvidenceCount: 1,
        priorWorkflowStatus: 'COMPLETED',
      }).eligible,
    ).toBe(false);
    expect(
      evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
        withdrawalState: 'FAILED_PRE_BROADCAST',
        permitStatus: 'ARMED',
        attemptCount: 0,
        broadcastEvidenceCount: 0,
        priorWorkflowStatus: 'RUNNING',
      }).eligible,
    ).toBe(false);

    const w = await prepareQueuedWithdrawal('200000');
    const armed = await armPermit(w);
    expect(armed.permit.status).toBe('ARMED');

    // Simulate pre-broadcast failure with zero attempts (hash/admission path).
    await pool.query(
      `UPDATE withdrawals SET state = 'FAILED_PRE_BROADCAST'::withdrawal_state WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    const stateRow = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(stateRow.rows[0]?.state).toBe('FAILED_PRE_BROADCAST');

    const attemptsBefore = await pool.query<{
      c: number;
      broadcast_evidence: number;
    }>(
      `SELECT count(*)::int AS c,
              count(*) FILTER (
                WHERE broadcast_started_at IS NOT NULL
                   OR broadcast_submitted_at IS NOT NULL
                   OR signed_external_message_boc IS NOT NULL
                   OR signed_wallet_request_boc IS NOT NULL
              )::int AS broadcast_evidence
       FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(attemptsBefore.rows[0]?.c).toBe(0);
    expect(attemptsBefore.rows[0]?.broadcast_evidence).toBe(0);

    const recovery = evaluatePhase21CanaryFailedPreZeroAttemptRecovery({
      withdrawalState: 'FAILED_PRE_BROADCAST',
      permitStatus: 'ARMED',
      attemptCount: attemptsBefore.rows[0]!.c,
      broadcastEvidenceCount: attemptsBefore.rows[0]!.broadcast_evidence,
      priorWorkflowStatus: 'COMPLETED',
    });
    expect(recovery.eligible).toBe(true);

    const restart = await withWithdrawalTransaction(pool, async (client) =>
      evaluatePhase21ManualDispatchRestartSafety(client, w.withdrawalId),
    );
    expect(restart.allowDuplicate).toBe(true);
    expect(restart.permit?.status).toBe('ARMED');

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId);
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

    const permit = await pool.query<{ status: string; consumed_attempt_id: string | null }>(
      `SELECT status::text AS status, consumed_attempt_id::text AS consumed_attempt_id
       FROM phase21_manual_dispatch_permits WHERE withdrawal_id = $1::uuid`,
      [w.withdrawalId],
    );
    expect(permit.rows[0]?.status).toBe('CONSUMED');
    expect(permit.rows[0]?.consumed_attempt_id).toBe(result.attemptId);

    const hashRow = await pool.query<{ canonical_message_hash: string }>(
      `SELECT canonical_message_hash FROM withdrawal_attempts WHERE id = $1::uuid`,
      [result.attemptId],
    );
    expect(hashRow.rows[0]?.canonical_message_hash).toMatch(/^[0-9a-f]{64}$/i);
    expect(hashRow.rows[0]?.canonical_message_hash.toLowerCase()).not.toBe('22'.repeat(32));

    await harnessAssertLedgerBalanced(pool);
  });
});
