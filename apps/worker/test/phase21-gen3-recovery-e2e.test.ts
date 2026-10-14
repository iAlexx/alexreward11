/**
 * Phase 21 Gen-3 Owner-authorized recovery - disposable DB E2E.
 *
 * Covers: Gen-3 APPLY gating, happy-path attempt #3, duplicate execution,
 * network timeout / signed-but-lost, expired signature, chain UNKNOWN refusal,
 * wrong seqno, concurrent arms/claims, repeated Owner requests, restart after
 * claim, and "never settle on failure".
 *
 * FakeTon + mock signer only. Never touches production DB / Railway / Mainnet.
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
  __mintPhase21Gen3RecoveryApplyConfirmationForTests,
  __mintPhase21MainnetRegistryApplyConfirmationForTests,
  __phase21TestSetApplyEnv,
  applyPhase21Gen2Recovery,
  applyPhase21Gen3Recovery,
  applyPhase21MainnetRegistryBootstrap,
  armPhase21ManualDispatchPermit,
  armPhase21ManualDispatchPermitGeneration,
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
  buildPhase21PayoutConfig,
  claimPhase21Gen2TemporalLaunch,
  claimPhase21Gen3TemporalLaunch,
  evaluatePhase21Gen3ConsumedFailedPreRecovery,
  evaluatePhase21ManualDispatchRestartSafety,
  localWithdrawalEngineFixtureConfig,
  mintAuthenticatedPhase21MainnetRegistryVerificationForTests,
  mintAuthenticatedPhase21OwnerCeremonyTrustForTests,
  mintPhase21Gen2IndependentChainReconciliationForTests,
  mintPhase21Gen3IndependentChainReconciliationForTests,
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_FROZEN_JETTON_MASTER,
  PHASE21_GEN3_AUTHORIZATION_GENERATION,
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
const EXPECTED_GEN1_RUN_ID = '01a13154-dc13-739c-92d1-8579627cc06e';
const EXPECTED_GEN2_RUN_ID = '01a2bbbb-cccc-dddd-eeee-ffffffffffff';
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

describeDb('phase21 Gen-3 recovery disposable E2E', () => {
  let pool: Pool;
  let dbName: string;
  let networkId: string;
  let assetId: string;
  let adminUserId: string;
  let hotWalletId: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    // Disposable DB guard: never a production-like database name.
    const targetDbName = new URL(phase7DatabaseUrl).pathname.replace(/^\//, '');
    expect(targetDbName).not.toBe('alex_rewards');
    expect(targetDbName).toMatch(/(_test|_tests|_phase\d+)/i);
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

    adminUserId = await createOwnerAdmin(pool, `phase21-gen3-owner-${Date.now()}@example.local`);
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
        reason: 'phase21-gen3-e2e-registry',
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
    adminUserId = await createOwnerAdmin(pool, `phase21-gen3-${randomUUID()}@example.local`);
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
       VALUES ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'phase21-gen3-e2e pause')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = true, updated_at = now()`,
    );
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase21_gen3_e2e_hot',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
      label: 'phase21-gen3-e2e-hot',
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

  type PreparedWithdrawal = Awaited<ReturnType<typeof prepareQueuedWithdrawal>>;

  function bindingsFor(w: PreparedWithdrawal) {
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

  async function armGen1(w: PreparedWithdrawal) {
    return withWithdrawalTransaction(pool, async (client) =>
      armPhase21ManualDispatchPermit(client, {
        createdByAdminUserId: adminUserId,
        idempotencyKey: `phase21.e2e.manual_dispatch:${w.withdrawalId}`,
        bindings: bindingsFor(w),
      }),
    );
  }

  function seedProviders(
    netAmount: string,
    withdrawalId: string,
    attemptNumber = 1,
    options?: { readonly withTransfer?: boolean },
  ) {
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
    if (options?.withTransfer === false) {
      return { primary, secondary };
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

  async function synthesizeFailedPreAttempt(input: {
    readonly withdrawalId: string;
    readonly attemptNumber: number;
    readonly generation: number;
  }): Promise<string> {
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         id, withdrawal_id, attempt_number, hot_wallet_id,
         expected_seqno, query_id, valid_until, canonical_message_hash,
         signer_key_reference, dispatch_fencing_token, broadcast_result_state,
         requires_state_init
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4::uuid,
         7, $5::bigint, now() + interval '5 minutes', $6,
         $7, $8::bigint, 'FAILED_PRE_BROADCAST'::withdrawal_attempt_result,
         false
       )`,
      [
        attemptId,
        input.withdrawalId,
        input.attemptNumber,
        hotWalletId,
        input.attemptNumber,
        '11'.repeat(32),
        ENCRYPTED_SIGNER_REF,
        input.attemptNumber,
      ],
    );
    await pool.query(
      `UPDATE phase21_manual_dispatch_permits
       SET status = 'CONSUMED'::phase21_manual_dispatch_permit_status,
           consumed_at = now(),
           consumed_attempt_id = $3::uuid
       WHERE withdrawal_id = $1::uuid
         AND authorization_generation = $2::int
         AND status = 'ARMED'::phase21_manual_dispatch_permit_status`,
      [input.withdrawalId, input.generation, attemptId],
    );
    return attemptId;
  }

  async function clearAttemptEvidence(withdrawalId: string): Promise<void> {
    await pool.query(
      `UPDATE withdrawal_attempts
       SET broadcast_result_state = 'FAILED_PRE_BROADCAST'::withdrawal_attempt_result,
           signed_external_message_boc = NULL,
           signed_wallet_request_boc = NULL,
           broadcast_submitted_at = NULL,
           chain_reference = NULL
       WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
  }

  async function countAttempts(withdrawalId: string): Promise<number> {
    const r = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    return r.rows[0]?.c ?? 0;
  }

  async function permitRows(withdrawalId: string) {
    const r = await pool.query<{ gen: number; status: string; id: string }>(
      `SELECT authorization_generation AS gen, status::text AS status, id::text AS id
       FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid
       ORDER BY authorization_generation`,
      [withdrawalId],
    );
    return r.rows;
  }

  /** Gen-1 ARMED -> attempt #1 FAILED_PRE with zero evidence -> Gen-1 CONSUMED. */
  async function forceFailedPreAttempt1(w: PreparedWithdrawal) {
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
    await pool.query(
      `UPDATE withdrawals SET state = 'FAILED_PRE_BROADCAST'::withdrawal_state WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    if ((await countAttempts(w.withdrawalId)) === 0) {
      await synthesizeFailedPreAttempt({
        withdrawalId: w.withdrawalId,
        attemptNumber: 1,
        generation: 1,
      });
    } else {
      await clearAttemptEvidence(w.withdrawalId);
    }
    const permits = await permitRows(w.withdrawalId);
    expect(permits[0]).toMatchObject({ gen: 1, status: 'CONSUMED' });
  }

  async function armGen2ViaApply(w: PreparedWithdrawal) {
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
      return await applyPhase21Gen2Recovery(client, {
        withdrawalId: w.withdrawalId,
        ownerTrust,
        applyConfirmation: __mintPhase21Gen2RecoveryApplyConfirmationForTests(),
        chainReconciliation: mintPhase21Gen2IndependentChainReconciliationForTests(),
        bindings: bindingsFor(w),
        deploymentEnvironment: 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
    } finally {
      client.release();
    }
  }

  /** Durable Gen-2 one-shot Temporal launch claim (real claim path, no Temporal start). */
  async function claimGen2Launch(withdrawalId: string, gen2PermitId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await claimPhase21Gen2TemporalLaunch({
        client,
        withdrawalId,
        gen2PermitId,
        expectedGen1RunId: EXPECTED_GEN1_RUN_ID,
        identityMode: 'durable_gen1_terminal',
        chainReconciliation: mintPhase21Gen2IndependentChainReconciliationForTests(),
        deploymentEnvironment: 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
      expect(claim.created).toBe(true);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Full WD-000001-class Gen-3 precondition shape:
   * attempts #1 and #2 FAILED_PRE with zero evidence, Gen-1 + Gen-2 CONSUMED,
   * durable Gen-2 launch claim DISPATCHED, Gen-3 absent.
   */
  async function forceTwoFailedPreAttempts(w: PreparedWithdrawal): Promise<{
    readonly gen2PermitId: string;
  }> {
    await forceFailedPreAttempt1(w);
    const applied = await armGen2ViaApply(w);
    expect(applied.ok).toBe(true);
    const gen2PermitId = applied.permitId!;
    expect(gen2PermitId).toBeTruthy();

    await claimGen2Launch(w.withdrawalId, gen2PermitId);

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
    expect(['FAILED_PRE_BROADCAST', 'BLOCKED', 'PAUSED']).toContain(result.state);
    expect(primary.getSendBocCallCount()).toBe(0);
    await pool.query(
      `UPDATE withdrawals SET state = 'FAILED_PRE_BROADCAST'::withdrawal_state WHERE id = $1::uuid`,
      [w.withdrawalId],
    );
    if ((await countAttempts(w.withdrawalId)) < 2) {
      await synthesizeFailedPreAttempt({
        withdrawalId: w.withdrawalId,
        attemptNumber: 2,
        generation: 2,
      });
    } else {
      await clearAttemptEvidence(w.withdrawalId);
    }

    const permits = await permitRows(w.withdrawalId);
    expect(permits.map((p) => `${p.gen}:${p.status}`)).toEqual(['1:CONSUMED', '2:CONSUMED']);
    expect(await countAttempts(w.withdrawalId)).toBe(2);
    return { gen2PermitId };
  }

  async function applyGen3(
    w: PreparedWithdrawal,
    overrides?: {
      readonly chainReconciliation?: ReturnType<
        typeof mintPhase21Gen3IndependentChainReconciliationForTests
      >;
      readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    },
  ) {
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
      return await applyPhase21Gen3Recovery(client, {
        withdrawalId: w.withdrawalId,
        ownerTrust,
        applyConfirmation: __mintPhase21Gen3RecoveryApplyConfirmationForTests(),
        chainReconciliation:
          overrides?.chainReconciliation ??
          mintPhase21Gen3IndependentChainReconciliationForTests(),
        bindings: bindingsFor(w),
        deploymentEnvironment: overrides?.deploymentEnvironment ?? 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
    } finally {
      client.release();
    }
  }

  async function settlementState(withdrawalId: string) {
    const r = await pool.query<{
      state: string;
      settlement: string | null;
      release: string | null;
      reservation: string | null;
    }>(
      `SELECT state::text AS state,
              settlement_ledger_tx_id::text AS settlement,
              release_ledger_tx_id::text AS release,
              reservation_ledger_tx_id::text AS reservation
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    return r.rows[0]!;
  }

  it('Gen-3 APPLY arms generation 3 while preserving Gen-1 + Gen-2 CONSUMED', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);

    const applied = await applyGen3(w);
    expect(applied.ok).toBe(true);
    expect(applied.applied).toBe(true);
    expect(applied.authorizationGeneration).toBe(PHASE21_GEN3_AUTHORIZATION_GENERATION);
    expect(applied.authorizationGeneration).toBe(3);
    expect(applied.broadcastPerformed).toBe(false);
    expect(applied.signed).toBe(false);
    expect(applied.outboxRelayStillDisabled).toBe(true);
    expect(applied.gen1PermitStatus).toBe('CONSUMED');
    expect(applied.gen2PermitStatus).toBe('CONSUMED');

    const permits = await permitRows(w.withdrawalId);
    expect(permits.map((p) => `${p.gen}:${p.status}`)).toEqual([
      '1:CONSUMED',
      '2:CONSUMED',
      '3:ARMED',
    ]);
    // Gen-3 permit id must differ from Gen-1 and Gen-2.
    expect(new Set(permits.map((p) => p.id)).size).toBe(3);

    const restart = await withWithdrawalTransaction(pool, async (client) =>
      evaluatePhase21ManualDispatchRestartSafety(client, w.withdrawalId),
    );
    expect(restart.allowDuplicate).toBe(true);
    expect(restart.permit?.authorizationGeneration).toBe(3);
    expect(restart.permit?.status).toBe('ARMED');

    // Repeated Owner APPLY is idempotent: still exactly one ARMED Gen-3 permit.
    const again = await applyGen3(w);
    expect(again.permitId).toBe(applied.permitId);
    const permitsAfter = await permitRows(w.withdrawalId);
    expect(permitsAfter.map((p) => `${p.gen}:${p.status}`)).toEqual([
      '1:CONSUMED',
      '2:CONSUMED',
      '3:ARMED',
    ]);
    expect(await countAttempts(w.withdrawalId)).toBe(2);
    const settle = await settlementState(w.withdrawalId);
    expect(settle.settlement).toBeNull();
    expect(settle.release).toBeNull();
  });

  it('Gen-3 APPLY refuses on a Gen-2 shape (single attempt, Gen-2 still ARMED)', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    expect((await armGen2ViaApply(w)).ok).toBe(true);

    const refused = await applyGen3(w);
    expect(refused.ok).toBe(false);
    expect(refused.applied).toBe(false);
    expect(refused.refuseCode).toMatch(/GEN3_/);
    const permits = await permitRows(w.withdrawalId);
    expect(permits.some((p) => p.gen === 3)).toBe(false);
  });

  it('Gen-3 APPLY refuses when the durable Gen-2 Temporal launch claim is missing', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceFailedPreAttempt1(w);
    const applied = await armGen2ViaApply(w);
    expect(applied.ok).toBe(true);
    // Attempt #2 fails pre-broadcast, but the Gen-2 one-shot launch claim is absent.
    await synthesizeFailedPreAttempt({
      withdrawalId: w.withdrawalId,
      attemptNumber: 2,
      generation: 2,
    });

    const refused = await applyGen3(w);
    expect(refused.ok).toBe(false);
    expect(refused.applied).toBe(false);
    expect(refused.refuseCode).toMatch(/GEN3_/);
    const permits = await permitRows(w.withdrawalId);
    expect(permits.some((p) => p.gen === 3)).toBe(false);
  });

  it('Gen-3 APPLY refuses stale and non-HIGH (chain UNKNOWN) reconciliation', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);

    const stale = await applyGen3(w, {
      chainReconciliation: mintPhase21Gen3IndependentChainReconciliationForTests({
        performedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    });
    expect(stale.ok).toBe(false);
    expect(stale.refuseCode).toMatch(/CHAIN_RECON/);

    const unknown = await applyGen3(w, {
      chainReconciliation: {
        ...mintPhase21Gen3IndependentChainReconciliationForTests(),
        confidence: 'UNKNOWN',
      } as ReturnType<typeof mintPhase21Gen3IndependentChainReconciliationForTests>,
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.refuseCode).toMatch(/CHAIN_RECON/);

    const permits = await permitRows(w.withdrawalId);
    expect(permits.some((p) => p.gen === 3)).toBe(false);
  });

  it('Gen-3 APPLY refuses when PRODUCTION is unpaused even if LOCAL/STAGING pauses are on', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);

    // Unsafe compensation scenario: non-PRODUCTION envs remain paused, but the
    // Owner ceremony target environment (PRODUCTION) is explicitly unpaused.
    await pool.query(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES
         ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'gen3-pause-cross-env-local'),
         ('PAYOUT_DISPATCH_PAUSE', 'STAGING', true, 'gen3-pause-cross-env-staging'),
         ('PAYOUT_DISPATCH_PAUSE', 'PRODUCTION', false, 'gen3-pause-cross-env-prod-off')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = EXCLUDED.enabled, updated_at = now()`,
    );

    const refused = await applyGen3(w, { deploymentEnvironment: 'PRODUCTION' });
    expect(refused.ok).toBe(false);
    expect(refused.applied).toBe(false);
    expect(refused.refuseCode).toMatch(
      /GEN3_APPLY_(PRECONDITIONS|REVALIDATION)_FAILED/,
    );
    expect(refused.planChecksFailed ?? []).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/payout_dispatch_pause/),
      ]),
    );
    const permits = await permitRows(w.withdrawalId);
    expect(permits.some((p) => p.gen === 3)).toBe(false);

    // Legitimate disposable LOCAL path must still succeed when LOCAL pause is ON.
    await pool.query(
      `UPDATE feature_flags
       SET enabled = true, updated_at = now()
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
    const localOk = await applyGen3(w, { deploymentEnvironment: 'LOCAL' });
    expect(localOk.ok).toBe(true);
    expect(localOk.applied).toBe(true);
    expect(localOk.authorizationGeneration).toBe(3);
  });

  it('Gen-3 APPLY refuses when signature/broadcast evidence exists on a prior attempt', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);
    await pool.query(
      `UPDATE withdrawal_attempts SET signed_message_hash = $2
       WHERE withdrawal_id = $1::uuid AND attempt_number = 2`,
      [w.withdrawalId, '22'.repeat(32)],
    );

    const refused = await applyGen3(w);
    expect(refused.ok).toBe(false);
    expect(refused.applied).toBe(false);
    const permits = await permitRows(w.withdrawalId);
    expect(permits.some((p) => p.gen === 3)).toBe(false);
  });

  it('Gen-3 happy path: attempt #3 CONFIRMED once; prior generations preserved; no double settle', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);
    expect((await applyGen3(w)).ok).toBe(true);

    const gate = evaluatePhase21Gen3ConsumedFailedPreRecovery({
      withdrawalState: 'FAILED_PRE_BROADCAST',
      gen1PermitStatus: 'CONSUMED',
      gen2PermitStatus: 'CONSUMED',
      gen3PermitStatus: 'ARMED',
      gen3AuthorizationGeneration: PHASE21_GEN3_AUTHORIZATION_GENERATION,
      attemptCount: 2,
      failedPreAttemptCount: 2,
      broadcastEvidenceCount: 0,
      priorWorkflowStatus: 'COMPLETED',
    });
    expect(gate.eligible).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 3);
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
    expect(await countAttempts(w.withdrawalId)).toBe(3);

    const permits = await permitRows(w.withdrawalId);
    expect(permits.map((p) => `${p.gen}:${p.status}`)).toEqual([
      '1:CONSUMED',
      '2:CONSUMED',
      '3:CONSUMED',
    ]);

    const settle = await settlementState(w.withdrawalId);
    expect(settle.settlement).not.toBeNull();
    expect(settle.release).toBeNull();
    await harnessAssertLedgerBalanced(pool);

    // Duplicate execution must not double-pay or double-settle.
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
    expect(await countAttempts(w.withdrawalId)).toBe(3);
    const settleAgain = await settlementState(w.withdrawalId);
    expect(settleAgain.settlement).toBe(settle.settlement);
    await harnessAssertLedgerBalanced(pool);
  }, 120_000);

  it('signed-but-lost on attempt #3 (sendBoc RPC timeout, no payment): never settles, never blind-retries', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);
    expect((await applyGen3(w)).ok).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 3, {
      withTransfer: false,
    });
    primary.setSendBocTimeout(true);
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
    expect(primary.getSendBocCallCount()).toBe(1);

    const settle = await settlementState(w.withdrawalId);
    expect(settle.settlement).toBeNull();
    expect(settle.release).toBeNull();
    expect(settle.reservation).not.toBeNull();

    // No blind retry: a second run must not sign/broadcast again.
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
    expect(again.state).not.toBe('CONFIRMED');
    expect(primary.getSendBocCallCount()).toBe(1);
    const settleAgain = await settlementState(w.withdrawalId);
    expect(settleAgain.settlement).toBeNull();
    await harnessAssertLedgerBalanced(pool);
  }, 120_000);

  it('pre-submit network failure on attempt #3: FAILED_PRE, no settlement, Gen-1/Gen-2 preserved', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);
    expect((await applyGen3(w)).ok).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 3, {
      withTransfer: false,
    });
    primary.setSendBocFailBeforeSubmit(true);
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

    const settle = await settlementState(w.withdrawalId);
    expect(settle.settlement).toBeNull();
    const permits = await permitRows(w.withdrawalId);
    expect(permits[0]).toMatchObject({ gen: 1, status: 'CONSUMED' });
    expect(permits[1]).toMatchObject({ gen: 2, status: 'CONSUMED' });
    await harnessAssertLedgerBalanced(pool);
  }, 120_000);

  it('expired / rejected signature on attempt #3: no sendBoc, no settlement, permits preserved', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);
    expect((await applyGen3(w)).ok).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 3);
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
    const settle = await settlementState(w.withdrawalId);
    expect(settle.settlement).toBeNull();
    const permits = await permitRows(w.withdrawalId);
    expect(permits[0]).toMatchObject({ gen: 1, status: 'CONSUMED' });
    expect(permits[1]).toMatchObject({ gen: 2, status: 'CONSUMED' });
  }, 120_000);

  it('wrong seqno (provider disagreement) on attempt #3: blocked before signing, never settles', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);
    expect((await applyGen3(w)).ok).toBe(true);

    const { primary, secondary } = seedProviders(w.net, w.withdrawalId, 3);
    secondary.seedSeqno(HOT_WALLET_RAW, 9);
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
    expect(primary.getSendBocCallCount()).toBe(0);
    expect(String(result.reason ?? '')).toMatch(/SEQNO|ADMISSION|DISAGREEMENT/i);
    const settle = await settlementState(w.withdrawalId);
    expect(settle.settlement).toBeNull();
    await harnessAssertLedgerBalanced(pool);
  }, 120_000);

  it('concurrent Gen-3 arm: only one ARMED generation-3 row', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    await forceTwoFailedPreAttempts(w);
    const b = bindingsFor(w);
    const key = phase21ManualDispatchGenerationIdempotencyKey(w.withdrawalId, 3);

    const [a, c] = await Promise.allSettled([
      withWithdrawalTransaction(pool, async (client) =>
        armPhase21ManualDispatchPermitGeneration(client, {
          bindings: b,
          authorizationGeneration: 3,
          createdByAdminUserId: adminUserId,
          idempotencyKey: key,
        }),
      ),
      withWithdrawalTransaction(pool, async (client) =>
        armPhase21ManualDispatchPermitGeneration(client, {
          bindings: b,
          authorizationGeneration: 3,
          createdByAdminUserId: adminUserId,
          idempotencyKey: key,
        }),
      ),
    ]);
    expect(a.status === 'fulfilled' || c.status === 'fulfilled').toBe(true);
    const armed = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid AND authorization_generation = 3 AND status = 'ARMED'`,
      [w.withdrawalId],
    );
    expect(armed.rows[0]?.c).toBe(1);
  }, 120_000);

  it('concurrent Gen-3 Temporal launch claims: one winner; restart after claim stays refused', async () => {
    const w = await prepareQueuedWithdrawal('200000');
    const { gen2PermitId } = await forceTwoFailedPreAttempts(w);
    const applied = await applyGen3(w);
    expect(applied.ok).toBe(true);
    const gen3PermitId = applied.permitId!;

    async function attemptClaim(): Promise<{ created: boolean; refuseCode?: string }> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const claim = await claimPhase21Gen3TemporalLaunch({
          client,
          withdrawalId: w.withdrawalId,
          gen3PermitId,
          expectedGen2RunId: EXPECTED_GEN2_RUN_ID,
          identityMode: 'durable_gen2_terminal',
          chainReconciliation: mintPhase21Gen3IndependentChainReconciliationForTests(),
          deploymentEnvironment: 'LOCAL',
          allowNonCanaryWithdrawalIdForTests: true,
        });
        if (!claim.created) {
          await client.query('ROLLBACK');
          return { created: false, refuseCode: claim.refuseCode };
        }
        await client.query('COMMIT');
        return { created: true };
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // best-effort
        }
        throw error;
      } finally {
        client.release();
      }
    }

    const results = await Promise.all([attemptClaim(), attemptClaim(), attemptClaim()]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    for (const loser of results.filter((r) => !r.created)) {
      expect(loser.refuseCode).toBe('GEN3_TEMPORAL_ALREADY_CLAIMED');
    }

    // Service restart after the claim: the Owner retry is still refused (one-shot).
    const afterRestart = await attemptClaim();
    expect(afterRestart).toEqual({
      created: false,
      refuseCode: 'GEN3_TEMPORAL_ALREADY_CLAIMED',
    });

    const claims = await pool.query<{ dedupe_key: string; status: string }>(
      `SELECT dedupe_key, status::text AS status FROM outbox_events
       WHERE dedupe_key = ANY($1::text[]) ORDER BY dedupe_key`,
      [
        [
          buildPhase21Gen2TemporalLaunchClaimDedupeKey({
            withdrawalId: w.withdrawalId,
            gen2PermitId,
          }),
          buildPhase21Gen3TemporalLaunchClaimDedupeKey({
            withdrawalId: w.withdrawalId,
            gen3PermitId,
          }),
        ],
      ],
    );
    expect(claims.rowCount).toBe(2);
    for (const row of claims.rows) {
      expect(row.status).toBe('DISPATCHED');
    }

    // Claims never settle anything by themselves.
    const settle = await settlementState(w.withdrawalId);
    expect(settle.settlement).toBeNull();
    expect(settle.release).toBeNull();
    expect(await countAttempts(w.withdrawalId)).toBe(2);
  }, 120_000);
});
