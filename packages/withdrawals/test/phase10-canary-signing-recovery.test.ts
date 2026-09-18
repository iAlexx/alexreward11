/**
 * Expanded isolated dry-run for Phase 10 canary SIGNING+0-attempts recovery.
 * Uses alex_rewards_test only (PHASE7_DATABASE_URL). Never touches operational alex_rewards.
 */
import { createHash, randomBytes } from 'node:crypto';

import { FakeTonChainProvider, deriveWalletV5R1AddressRaw } from '@alex-rewards/ton';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
  PHASE10_CANARY_RECOVERY_REAUTH_MAX_AGE_MS,
  PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID,
  acquireHotWalletDispatchLease,
  buildPhase10PayoutConfig,
  executePhase10CanarySigningZeroAttemptsRecovery,
  hashPhase10CanaryOwnerSessionToken,
  hotWalletDispatchOwnerIdentity,
  isPhase10CanaryRecoveryCiEnvironment,
  isPhase10CanaryRecoveryWithdrawalAuthorized,
  localWithdrawalEngineFixtureConfig,
  planPhase10CanarySigningZeroAttemptsRecovery,
  runPhase10RestoreReconcileScan,
  runRealTestnetPayoutPipeline,
  withWithdrawalTransaction,
  type RealPayoutSignerPort,
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

describe.skipIf(phase7DatabaseUrl === '')('phase10 canary signing recovery (isolated)', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let ownerSessionToken: string;
  let hotWalletId: string;
  let jettonMaster: string;
  let userId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    delete process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
    await pool?.end();
  });

  async function provisionAuthenticatedOwner(adminId: string): Promise<string> {
    const role = await pool.query<{ id: string }>(
      `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
    );
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) throw new Error('OWNER role missing');
    await pool.query(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT (admin_user_id, role_id) DO UPDATE SET revoked_at = NULL`,
      [adminId, roleId],
    );
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = hashPhase10CanaryOwnerSessionToken(rawToken);
    await pool.query(`UPDATE admin_users SET last_reauthenticated_at = now() WHERE id = $1::uuid`, [
      adminId,
    ]);
    await pool.query(
      `INSERT INTO admin_sessions (
         admin_user_id, session_token_hash, idle_expires_at, absolute_expires_at, reauthenticated_at
       ) VALUES (
         $1::uuid, $2, now() + interval '1 hour', now() + interval '8 hours', now()
       )`,
      [adminId, tokenHash],
    );
    return rawToken;
  }

  beforeEach(async () => {
    delete process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    ownerSessionToken = await provisionAuthenticatedOwner(adminUserId);
    userId = await createTestUser(pool, '9101001');
    await createVerifiedPrimaryWallet(pool, {
      userId,
      networkId,
      rawAddress: '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    hotWalletId = await ensureEncryptedPayoutHotWallet(pool, {
      networkId,
      address: HOT_WALLET_RAW,
      friendlyAddress: 'EQ_phase10_canary_recovery',
      signerReference: ENCRYPTED_SIGNER_REF,
      payoutJettonWalletAddress: PAYOUT_JETTON_WALLET,
    });
    const master = await pool.query<{ contract_identity: string }>(
      `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
      [assetId],
    );
    jettonMaster = master.rows[0]!.contract_identity;
  });

  async function seedStuckSigning(options?: {
    readonly expireLease?: boolean;
    readonly releaseLease?: boolean;
    readonly wrongToken?: boolean;
  }): Promise<{ withdrawalId: string; fencingToken: bigint }> {
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
      engineConfig: nonFakeEngine,
    });
    process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID = withdrawalId;

    await pool.query(
      `UPDATE withdrawals
       SET state = 'SIGNING',
           workflow_id = $2,
           updated_at = now()
       WHERE id = $1::uuid`,
      [withdrawalId, `withdrawal/${withdrawalId}`],
    );

    const owner = hotWalletDispatchOwnerIdentity(withdrawalId);
    let fencingToken = 0n;
    await withWithdrawalTransaction(pool, async (client) => {
      const lease = await acquireHotWalletDispatchLease(client, hotWalletId, owner);
      expect(lease.status).toBe('ACQUIRED');
      if (lease.status === 'ACQUIRED') fencingToken = lease.fencingToken;
    });

    if (options?.expireLease !== false) {
      await pool.query(
        `UPDATE hot_wallet_dispatch_leases
         SET acquired_at = now() - interval '10 minutes',
             renewed_at = now() - interval '10 minutes',
             expires_at = now() - interval '5 minutes',
             released_at = NULL
         WHERE hot_wallet_id = $1::uuid AND owner_identity = $2`,
        [hotWalletId, owner],
      );
    }

    if (options?.releaseLease === true) {
      await pool.query(
        `UPDATE hot_wallet_dispatch_leases
         SET released_at = now()
         WHERE hot_wallet_id = $1::uuid`,
        [hotWalletId],
      );
    }

    if (options?.wrongToken === true) {
      fencingToken = fencingToken + 99n;
    }

    return { withdrawalId, fencingToken };
  }

  function mutateAuth(withdrawalId: string, fencingToken: bigint) {
    return {
      withdrawalId,
      mode: 'mutate' as const,
      confirmationPhrase: PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
      ownerAdminUserId: adminUserId,
      ownerSessionToken,
      temporalTerminatedConfirmed: true,
      payoutWorkerStoppedConfirmed: true,
      expectedFencingToken: fencingToken,
    };
  }

  it('refuses non-canary withdrawal id', async () => {
    const plan = await planPhase10CanarySigningZeroAttemptsRecovery(pool, {
      withdrawalId: '00000000-0000-4000-8000-000000000099',
    });
    expect(plan.accepted).toBe(false);
    expect(plan.refusalReasons.some((r) => r.includes('non-canary'))).toBe(true);
  });

  it('dry-run plans successful recovery without mutating', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const before = await pool.query<{ state: string; released: boolean }>(
      `SELECT w.state::text AS state, (l.released_at IS NOT NULL) AS released
       FROM withdrawals w
       JOIN hot_wallet_dispatch_leases l ON l.hot_wallet_id = w.hot_wallet_id
       WHERE w.id = $1::uuid`,
      [withdrawalId],
    );

    const plan = await planPhase10CanarySigningZeroAttemptsRecovery(pool, {
      withdrawalId,
      expectedFencingToken: fencingToken,
    });
    expect(plan.accepted).toBe(true);
    expect(plan.mode).toBe('dry-run');
    expect(plan.plannedTransition?.from).toBe('SIGNING');
    expect(plan.plannedTransition?.to).toBe('FAILED_PRE_BROADCAST');
    expect(plan.temporalNotes.originalWorkflowMustBeTerminatedNotCompleted).toBe(true);
    expect(plan.temporalNotes.directPipelineRequiresNewWorkflow).toBe(false);
    expect(plan.prerequisites.migration0023Applied).toBe(true);

    const after = await pool.query<{ state: string; released: boolean }>(
      `SELECT w.state::text AS state, (l.released_at IS NOT NULL) AS released
       FROM withdrawals w
       JOIN hot_wallet_dispatch_leases l ON l.hot_wallet_id = w.hot_wallet_id
       WHERE w.id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.state).toBe(before.rows[0]?.state);
    expect(after.rows[0]?.released).toBe(before.rows[0]?.released);
  });

  it('mutate without confirmation phrase refuses', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      withdrawalId,
      mode: 'mutate',
      confirmationPhrase: 'WRONG',
      ownerAdminUserId: adminUserId,
      ownerSessionToken,
      temporalTerminatedConfirmed: true,
      payoutWorkerStoppedConfirmed: true,
      expectedFencingToken: fencingToken,
    });
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('confirmationPhrase'))).toBe(true);
    const state = await pool.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(state.rows[0]?.state).toBe('SIGNING');
  });

  it('mutate without ownerAdminUserId refuses (phrase is not authentication)', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      withdrawalId,
      mode: 'mutate',
      confirmationPhrase: PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
      ownerSessionToken,
      temporalTerminatedConfirmed: true,
      payoutWorkerStoppedConfirmed: true,
      expectedFencingToken: fencingToken,
    });
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('ownerAdminUserId'))).toBe(true);
  });

  it('ACTIVE admin without OWNER binding refuses (P1)', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    await pool.query(
      `UPDATE admin_role_bindings SET revoked_at = now() WHERE admin_user_id = $1::uuid`,
      [adminUserId],
    );
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('OWNER role binding'))).toBe(true);
  });

  it('ACTIVE OWNER without session token refuses (P1)', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      ...mutateAuth(withdrawalId, fencingToken),
      ownerSessionToken: null,
    });
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('ownerSessionToken'))).toBe(true);
  });

  it('ACTIVE OWNER with stale reauthentication refuses (P1)', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const staleMs = PHASE10_CANARY_RECOVERY_REAUTH_MAX_AGE_MS + 60_000;
    await pool.query(
      `UPDATE admin_sessions
       SET reauthenticated_at = now() - ($2::text || ' milliseconds')::interval
       WHERE admin_user_id = $1::uuid`,
      [adminUserId, String(staleMs)],
    );
    await pool.query(
      `UPDATE admin_users
       SET last_reauthenticated_at = now() - ($2::text || ' milliseconds')::interval
       WHERE id = $1::uuid`,
      [adminUserId, String(staleMs)],
    );
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('reauthentication expired'))).toBe(true);
  });

  it('non-Owner ACTIVE admin cannot mutate even with a session (P1)', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const otherAdmin = await createOwnerAdmin(pool, `non-owner-${Date.now()}@example.local`);
    const otherToken = await provisionAuthenticatedOwner(otherAdmin);
    await pool.query(
      `UPDATE admin_role_bindings SET revoked_at = now() WHERE admin_user_id = $1::uuid`,
      [otherAdmin],
    );
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      ...mutateAuth(withdrawalId, fencingToken),
      ownerAdminUserId: otherAdmin,
      ownerSessionToken: otherToken,
    });
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('OWNER role binding'))).toBe(true);
  });

  it('fixture override is refused against operational database name (P2)', () => {
    const fixtureId = '00000000-0000-4000-8000-000000000042';
    process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID = fixtureId;
    expect(isPhase10CanaryRecoveryWithdrawalAuthorized(fixtureId, 'alex_rewards')).toBe(false);
    expect(isPhase10CanaryRecoveryWithdrawalAuthorized(fixtureId, 'alex_rewards_test')).toBe(true);
    expect(
      isPhase10CanaryRecoveryWithdrawalAuthorized(
        PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID,
        'alex_rewards',
      ),
    ).toBe(true);
  });

  it('mutate in CI refuses operational recovery (production canary ID)', async () => {
    const prevCi = process.env.CI;
    const prevActions = process.env.GITHUB_ACTIONS;
    const prevFixture = process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
    process.env.CI = 'true';
    process.env.GITHUB_ACTIONS = 'true';
    delete process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
    try {
      const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
        withdrawalId: PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID,
        mode: 'mutate',
        confirmationPhrase: PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
        ownerAdminUserId: adminUserId,
        ownerSessionToken,
        temporalTerminatedConfirmed: true,
        payoutWorkerStoppedConfirmed: true,
        expectedFencingToken: 1n,
      });
      expect(result.accepted).toBe(false);
      expect(result.refusalReasons.some((r) => r.includes('CI'))).toBe(true);
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
      if (prevActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prevActions;
      if (prevFixture === undefined) delete process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
      else process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID = prevFixture;
    }
  });

  it('CI marker detection is fail-closed for nonempty variants (P2)', () => {
    const prevCi = process.env.CI;
    const prevActions = process.env.GITHUB_ACTIONS;
    try {
      delete process.env.GITHUB_ACTIONS;
      for (const value of ['1', 'TRUE', 'true', 'yes', 'on', 'ci']) {
        process.env.CI = value;
        expect(isPhase10CanaryRecoveryCiEnvironment()).toBe(true);
      }
      for (const value of ['0', 'false', 'FALSE', 'no', 'off', '']) {
        process.env.CI = value;
        expect(isPhase10CanaryRecoveryCiEnvironment()).toBe(false);
      }
      delete process.env.CI;
      process.env.GITHUB_ACTIONS = '1';
      expect(isPhase10CanaryRecoveryCiEnvironment()).toBe(true);
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
      if (prevActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prevActions;
    }
  });

  it('mutate in CI with isolated test DB + matching non-production fixture is allowed', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const dbName = await pool.query<{ current_database: string }>(`SELECT current_database()`);
    expect(dbName.rows[0]?.current_database).not.toBe('alex_rewards');
    expect(withdrawalId).not.toBe(PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID);

    const prevCi = process.env.CI;
    const prevActions = process.env.GITHUB_ACTIONS;
    process.env.CI = 'true';
    process.env.GITHUB_ACTIONS = 'true';
    try {
      const result = await executePhase10CanarySigningZeroAttemptsRecovery(
        pool,
        mutateAuth(withdrawalId, fencingToken),
      );
      expect(result.accepted).toBe(true);
      expect(result.after?.state).toBe('FAILED_PRE_BROADCAST');
    } finally {
      if (prevCi === undefined) delete process.env.CI;
      else process.env.CI = prevCi;
      if (prevActions === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prevActions;
    }
  });

  it('mutate without temporal/worker attestations refuses', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      withdrawalId,
      mode: 'mutate',
      confirmationPhrase: PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE,
      ownerAdminUserId: adminUserId,
      ownerSessionToken,
      expectedFencingToken: fencingToken,
    });
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('temporalTerminatedConfirmed'))).toBe(true);
    expect(result.refusalReasons.some((r) => r.includes('payoutWorkerStoppedConfirmed'))).toBe(
      true,
    );
  });

  it('successful recovery state transaction preserves reservation', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const beforeRes = await pool.query<{
      reservation_ledger_tx_id: string;
      release_ledger_tx_id: string | null;
      settlement_ledger_tx_id: string | null;
    }>(
      `SELECT reservation_ledger_tx_id::text, release_ledger_tx_id::text, settlement_ledger_tx_id::text
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(true);
    expect(result.after?.state).toBe('FAILED_PRE_BROADCAST');
    expect(result.leaseReleased).toBe(true);
    expect(result.auditLogId).not.toBeNull();

    const after = await pool.query<{
      state: string;
      reservation_ledger_tx_id: string;
      release_ledger_tx_id: string | null;
      settlement_ledger_tx_id: string | null;
      released: boolean;
      attempts: number;
    }>(
      `SELECT w.state::text AS state,
              w.reservation_ledger_tx_id::text,
              w.release_ledger_tx_id::text,
              w.settlement_ledger_tx_id::text,
              (l.released_at IS NOT NULL) AS released,
              (SELECT count(*)::int FROM withdrawal_attempts a WHERE a.withdrawal_id = w.id) AS attempts
       FROM withdrawals w
       JOIN hot_wallet_dispatch_leases l ON l.hot_wallet_id = w.hot_wallet_id
       WHERE w.id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.state).toBe('FAILED_PRE_BROADCAST');
    expect(after.rows[0]?.reservation_ledger_tx_id).toBe(
      beforeRes.rows[0]?.reservation_ledger_tx_id,
    );
    expect(after.rows[0]?.release_ledger_tx_id).toBeNull();
    expect(after.rows[0]?.settlement_ledger_tx_id).toBeNull();
    expect(after.rows[0]?.released).toBe(true);
    expect(after.rows[0]?.attempts).toBe(0);

    const restore = await runPhase10RestoreReconcileScan(pool);
    expect(
      restore.findings.some(
        (f) =>
          f.withdrawalId === withdrawalId &&
          f.category === 'signing_zero_attempts_recovery_required',
      ),
    ).toBe(false);
  });

  it('incorrect withdrawal state refuses', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    await pool.query(`UPDATE withdrawals SET state = 'QUEUED' WHERE id = $1::uuid`, [withdrawalId]);
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('SIGNING'))).toBe(true);
  });

  it('wrong fencing token refuses', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning({ wrongToken: true });
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('fencing token'))).toBe(true);
  });

  it('lease already released refuses', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning({ releaseLease: true });
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('already released'))).toBe(true);
  });

  it('unexpected attempt refuses', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference, dispatch_fencing_token,
         broadcast_result_state, requires_state_init
       ) VALUES (
         $1::uuid, 1, $2::uuid, 0, 1,
         now() + interval '5 minutes', $3, $4, $5::bigint,
         'PENDING', false
       )`,
      [
        withdrawalId,
        hotWalletId,
        TEST_CANONICAL_HASH,
        ENCRYPTED_SIGNER_REF,
        fencingToken.toString(),
      ],
    );
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('attemptCount'))).toBe(true);
  });

  it('broadcast evidence refuses', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference, dispatch_fencing_token,
         broadcast_result_state, requires_state_init, broadcast_started_at
       ) VALUES (
         $1::uuid, 1, $2::uuid, 0, 1,
         now() + interval '5 minutes', $3, $4, $5::bigint,
         'PENDING', false, now()
       )`,
      [
        withdrawalId,
        hotWalletId,
        TEST_CANONICAL_HASH,
        ENCRYPTED_SIGNER_REF,
        fencingToken.toString(),
      ],
    );
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('broadcast evidence'))).toBe(true);
  });

  it('temporal termination failure simulation blocks mutate', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const result = await executePhase10CanarySigningZeroAttemptsRecovery(pool, {
      ...mutateAuth(withdrawalId, fencingToken),
      temporalTerminatedConfirmed: false,
    });
    expect(result.accepted).toBe(false);
    expect(result.refusalReasons.some((r) => r.includes('temporalTerminatedConfirmed'))).toBe(true);
  });

  it('migration failure simulation blocks when 0023 missing', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    await pool.query(
      `DELETE FROM schema_migrations WHERE version = '0023_attempt_requires_state_init'`,
    );
    const plan = await planPhase10CanarySigningZeroAttemptsRecovery(pool, {
      withdrawalId,
      expectedFencingToken: fencingToken,
    });
    expect(plan.accepted).toBe(false);
    expect(plan.refusalReasons.some((r) => r.includes('0023'))).toBe(true);
    // Restore migration bookkeeping for subsequent tests (column already exists).
    await pool.query(
      `INSERT INTO schema_migrations (version) VALUES ('0023_attempt_requires_state_init')
       ON CONFLICT (version) DO NOTHING`,
    );
  });

  it('repeated recovery invocation is rejected (idempotence)', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const first = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(first.accepted).toBe(true);
    const second = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(second.accepted).toBe(false);
    expect(second.refusalReasons.some((r) => r.includes('already recovered'))).toBe(true);
  });

  it('re-entry uses same withdrawal+reservation and stops before broadcast', async () => {
    const { withdrawalId, fencingToken } = await seedStuckSigning();
    const reservationBefore = await pool.query<{ reservation_ledger_tx_id: string }>(
      `SELECT reservation_ledger_tx_id::text FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const recovered = await executePhase10CanarySigningZeroAttemptsRecovery(
      pool,
      mutateAuth(withdrawalId, fencingToken),
    );
    expect(recovered.accepted).toBe(true);

    const primary = new FakeTonChainProvider();
    const secondary = new FakeTonChainProvider();
    primary.seedAccountState(HOT_WALLET_RAW, { status: 'uninit', codeHash: null });
    secondary.seedAccountState(HOT_WALLET_RAW, { status: 'uninit', codeHash: null });

    const phase10 = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: jettonMaster,
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });

    let reachedSign = false;
    const signer: RealPayoutSignerPort = {
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
        reachedSign = true;
        throw new Error('DRYRUN_STOP_BEFORE_BROADCAST');
      },
    };

    const pipeline = await runRealTestnetPayoutPipeline(pool, {
      withdrawalId,
      phase10,
      engine: nonFakeEngine,
      chainProvider: primary,
      secondaryChainProvider: secondary,
      signer,
      allowTestExecutionPath: true,
      buildCanonicalMessageHash: async () => TEST_CANONICAL_HASH,
    });

    expect(reachedSign).toBe(true);
    expect(pipeline.state).toBe('FAILED_PRE_BROADCAST');
    expect(pipeline.reason).toMatch(/DRYRUN_STOP_BEFORE_BROADCAST/);

    const after = await pool.query<{
      id: string;
      reservation_ledger_tx_id: string;
      attempt_number: number;
      expected_seqno: string;
      requires_state_init: boolean;
      has_boc: boolean;
      broadcast_started: boolean;
    }>(
      `SELECT w.id::text, w.reservation_ledger_tx_id::text,
              a.attempt_number, a.expected_seqno::text, a.requires_state_init,
              a.signed_external_message_boc IS NOT NULL AS has_boc,
              a.broadcast_started_at IS NOT NULL AS broadcast_started
       FROM withdrawals w
       JOIN withdrawal_attempts a ON a.withdrawal_id = w.id
       WHERE w.id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.id).toBe(withdrawalId);
    expect(after.rows[0]?.reservation_ledger_tx_id).toBe(
      reservationBefore.rows[0]?.reservation_ledger_tx_id,
    );
    expect(after.rows[0]?.attempt_number).toBe(1);
    expect(after.rows[0]?.expected_seqno).toBe('0');
    expect(after.rows[0]?.requires_state_init).toBe(true);
    expect(after.rows[0]?.has_boc).toBe(false);
    expect(after.rows[0]?.broadcast_started).toBe(false);

    // No second withdrawal.approved outbox for this recovery path.
    const outbox = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events
       WHERE event_type = 'withdrawal.approved'
         AND (aggregate_id = $1::uuid OR dedupe_key = $2)`,
      [withdrawalId, `withdrawal.approved:${withdrawalId}`],
    );
    // At most the original approve event (0 or 1) — recovery must not insert another.
    expect(outbox.rows[0]?.c).toBeLessThanOrEqual(1);
  });

  it('documents production canary id constant', () => {
    expect(PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID).toBe('01a0afbd-2550-742b-967d-5aec6ee75a83');
  });
});
