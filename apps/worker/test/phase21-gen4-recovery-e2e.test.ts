/**
 * Phase 21 Gen-4 Owner-authorized recovery - disposable DB E2E (focused port).
 *
 * Covers the Gen-4 APPLY + Temporal-launch contract against a REAL disposable PostgreSQL
 * schema and a REAL disposable local Temporal test server:
 *   - APPLY arms generation 4 only (Gen-1/2/3 CONSUMED preserved), enqueues the audit-only
 *     PENDING manual-dispatch outbox row and NEVER writes the Gen-4 launch claim / starts Temporal
 *   - refuses forged / missing Gen-3 launch claim, query-id mismatch, wrong attempt shape,
 *     evidence on a prior attempt, Gen-3 not CONSUMED
 *   - idempotent + concurrent APPLY (exactly one permit / one outbox row)
 *   - Temporal one-shot launch: durable Gen-3 terminal identity (history absent), exactly one
 *     DISPATCHED claim + one workflow start, repeated Owner request refused
 *
 * The full attempt #4 signing pipeline (FakeTon + mock signer) is covered by the Gen-3 e2e
 * pipeline tests and is intentionally not duplicated here: no signing, no broadcast, no KMS.
 *
 * Never touches production DB / Railway / Mainnet. Requires PHASE7_DATABASE_URL (or
 * PHASE7_WITHDRAWAL_TESTS=1 + DATABASE_URL) pointing at a disposable `*_test` database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import {
  __mintPhase21Gen4RecoveryApplyConfirmationForTests,
  applyPhase21Gen4Recovery,
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
  buildPhase21Gen4TemporalLaunchClaimDedupeKey,
  executePhase21Gen4TemporalLaunch,
  mintAuthenticatedPhase21OwnerCeremonyTrustForTests,
  mintPhase21Gen4IndependentChainReconciliationForTests,
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_FROZEN_JETTON_MASTER,
  PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
  PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  planPhase21Gen4Recovery,
  planPhase21Gen4TemporalLaunch,
  withdrawalWorkflowId,
  WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
  type Phase21ManualDispatchPermitBindings,
} from '@alex-rewards/withdrawals';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createApprovedWithdrawal,
  createOwnerAdmin,
  createTestUser,
  createVerifiedPrimaryWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from '../../../packages/withdrawals/test/harness.js';
const RECIPIENT_RAW = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT_FRIENDLY = `EQ${RECIPIENT_RAW.slice(2, 50)}`;
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from('11'.repeat(32), 'hex'))
  .digest('hex');
const EXPECTED_GEN3_RUN_ID = '01a3cccc-dddd-eeee-ffff-000000000000';

const describeDb = phase7DatabaseUrl === '' ? describe.skip : describe;

describeDb('phase21 Gen-4 recovery disposable E2E', () => {
  let pool: Pool;
  let testEnv: TestWorkflowEnvironment;
  let networkId: string;
  let assetId: string;
  let hotWalletId: string;
  let adminUserId: string;
  const prevEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const targetDbName = new URL(phase7DatabaseUrl).pathname.replace(/^\//, '');
    expect(targetDbName).not.toBe('alex_rewards');
    expect(targetDbName).toMatch(/(_test|_tests|_phase\d+)/i);
    for (const k of ['NODE_ENV', 'ALEX_PHASE21_CEREMONY_TEST_HOOKS'] as const) {
      prevEnv[k] = process.env[k];
    }
    process.env.NODE_ENV = 'test';
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl, max: 8 });
    testEnv = await TestWorkflowEnvironment.createLocal();
  }, 240_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await testEnv?.teardown();
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    networkId = base.networkId;
    assetId = base.assetId;
    hotWalletId = base.hotWalletId;
    adminUserId = await createOwnerAdmin(pool, `gen4-e2e-${randomUUID()}@example.local`);
    await pool.query(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'gen4 e2e pause ON')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = true, updated_at = now()`,
    );
  });

  async function insertAttempt(withdrawalId: string, attemptNumber: number): Promise<string> {
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         id, withdrawal_id, attempt_number, hot_wallet_id,
         expected_seqno, query_id, valid_until, canonical_message_hash,
         signer_key_reference, dispatch_fencing_token, broadcast_result_state,
         requires_state_init
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4::uuid,
         7, $7::bigint, now() + interval '5 minutes', $5,
         $6, $7::bigint, 'FAILED_PRE_BROADCAST',
         false
       )`,
      [
        attemptId,
        withdrawalId,
        attemptNumber,
        hotWalletId,
        '11'.repeat(32),
        ENCRYPTED_SIGNER_REF,
        attemptNumber,
      ],
    );
    return attemptId;
  }

  async function insertPermit(input: {
    readonly id: string;
    readonly withdrawalId: string;
    readonly generation: number;
    readonly status: 'ARMED' | 'CONSUMED';
    readonly consumedAttemptId?: string;
  }): Promise<void> {
    const row = await pool.query<{ public_id: string; gross: string; fee: string; net: string }>(
      `SELECT public_id,
              requested_amount_atomic::text AS gross,
              fee_amount_atomic::text AS fee,
              net_amount_atomic::text AS net
       FROM withdrawals WHERE id = $1::uuid`,
      [input.withdrawalId],
    );
    const w = row.rows[0]!;
    await pool.query(
      `INSERT INTO phase21_manual_dispatch_permits (
         id, withdrawal_id, authorization_generation, public_id,
         authorized_gross_atomic, authorized_fee_atomic, authorized_net_atomic,
         authorized_recipient_friendly, authorized_recipient_raw,
         authorized_network_code, authorized_asset_symbol, authorized_jetton_master,
         authorized_attached_gram_atomic, authorized_forward_gram_atomic,
         status, created_by_admin_user_id, idempotency_key,
         consumed_at, consumed_attempt_id
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4,
         $5::bigint, $6::bigint, $7::bigint,
         $8, $9,
         'TON_TESTNET', 'USDT', $10,
         $11::bigint, $12::bigint,
         $13::phase21_manual_dispatch_permit_status, $14::uuid, $15,
         $16::timestamptz, $17::uuid
       )`,
      [
        input.id,
        input.withdrawalId,
        input.generation,
        w.public_id,
        w.gross,
        w.fee,
        w.net,
        RECIPIENT_FRIENDLY,
        RECIPIENT_RAW,
        PHASE21_CANARY_FROZEN_JETTON_MASTER,
        PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10),
        PHASE21_CANARY_FORWARD_TON_ATOMIC.toString(10),
        input.status,
        adminUserId,
        `gen4-e2e.gen${input.generation}:${input.withdrawalId}`,
        input.status === 'CONSUMED' ? new Date().toISOString() : null,
        input.consumedAttemptId ?? null,
      ],
    );
  }

  async function insertDispatchedClaim(
    withdrawalId: string,
    eventType: string,
    dedupeKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await pool.query(
      `INSERT INTO outbox_events (
         aggregate_type, aggregate_id, event_type, payload, dedupe_key,
         status, available_at, dispatched_at
       ) VALUES (
         'withdrawal', $1::uuid, $2, $3::jsonb, $4,
         'DISPATCHED'::outbox_event_status, now(), now()
       ) ON CONFLICT (dedupe_key) DO NOTHING`,
      [withdrawalId, eventType, JSON.stringify(payload), dedupeKey],
    );
  }

  /** Gen-1/2/3 CONSUMED + three FAILED_PRE attempts (query ids 1/2/3) + Gen-2 and bound Gen-3 launch claims. */
  async function seedPreGen4(options?: {
    readonly gen3Armed?: boolean;
    /** Gen-1 bound to attempt #2 and Gen-2 bound to attempt #1 (exact-binding violation). */
    readonly swapGen1Gen2Attempts?: boolean;
  }) {
    const userId = await createTestUser(pool, String(9600000 + Math.floor(Math.random() * 1e6)));
    await createVerifiedPrimaryWallet(pool, { userId, networkId, rawAddress: RECIPIENT_RAW });
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    await pool.query(
      `UPDATE withdrawals SET state = 'FAILED_PRE_BROADCAST'::withdrawal_state WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const a1 = await insertAttempt(withdrawalId, 1);
    const a2 = await insertAttempt(withdrawalId, 2);
    const a3 = await insertAttempt(withdrawalId, 3);
    const gen1PermitId = randomUUID();
    const gen2PermitId = randomUUID();
    const gen3PermitId = randomUUID();
    const swap = options?.swapGen1Gen2Attempts === true;
    await insertPermit({ id: gen1PermitId, withdrawalId, generation: 1, status: 'CONSUMED', consumedAttemptId: swap ? a2 : a1 });
    await insertPermit({ id: gen2PermitId, withdrawalId, generation: 2, status: 'CONSUMED', consumedAttemptId: swap ? a1 : a2 });
    await insertPermit({
      id: gen3PermitId,
      withdrawalId,
      generation: 3,
      status: options?.gen3Armed === true ? 'ARMED' : 'CONSUMED',
      ...(options?.gen3Armed === true ? {} : { consumedAttemptId: a3 }),
    });
    await insertDispatchedClaim(
      withdrawalId,
      PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
      buildPhase21Gen2TemporalLaunchClaimDedupeKey({ withdrawalId, gen2PermitId }),
      { withdrawalId, gen2PermitId, authorizationGeneration: 2 },
    );
    await insertDispatchedClaim(
      withdrawalId,
      PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
      buildPhase21Gen3TemporalLaunchClaimDedupeKey({ withdrawalId, gen3PermitId }),
      {
        withdrawalId,
        gen3PermitId,
        expectedGen2RunId: '01a2bbbb-cccc-dddd-eeee-ffffffffffff',
        identityMode: 'durable_gen2_terminal',
        workflowId: withdrawalWorkflowId(withdrawalId),
        authorizationGeneration: 3,
        broadcastPerformed: false,
        signed: false,
      },
    );
    const w = await pool.query<{ public_id: string; gross: string; fee: string; net: string }>(
      `SELECT public_id,
              requested_amount_atomic::text AS gross,
              fee_amount_atomic::text AS fee,
              net_amount_atomic::text AS net
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const bindings: Phase21ManualDispatchPermitBindings = {
      withdrawalId,
      publicId: w.rows[0]!.public_id,
      authorizedGrossAtomic: BigInt(w.rows[0]!.gross),
      authorizedFeeAtomic: BigInt(w.rows[0]!.fee),
      authorizedNetAtomic: BigInt(w.rows[0]!.net),
      authorizedRecipientFriendly: RECIPIENT_FRIENDLY,
      authorizedRecipientRaw: RECIPIENT_RAW,
      authorizedNetworkCode: 'TON_TESTNET',
      authorizedAssetSymbol: 'USDT',
      authorizedJettonMaster: PHASE21_CANARY_FROZEN_JETTON_MASTER,
      authorizedAttachedGramAtomic: PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
      authorizedForwardGramAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
    };
    return { withdrawalId, gen1PermitId, gen2PermitId, gen3PermitId, attemptIds: [a1, a2, a3], bindings };
  }

  const recon = (ids: readonly string[] = ['1', '2', '3']) =>
    mintPhase21Gen4IndependentChainReconciliationForTests({ priorQueryIds: ids });

  async function runApply(
    seed: { withdrawalId: string; bindings: Phase21ManualDispatchPermitBindings },
    chainReconciliation = recon(),
  ) {
    const client = await pool.connect();
    try {
      const sid = await client.query<{ sid: string }>(
        `SELECT system_identifier::text AS sid FROM pg_control_system()`,
      );
      const db = await client.query<{ name: string }>(`SELECT current_database() AS name`);
      return await applyPhase21Gen4Recovery(client, {
        withdrawalId: seed.withdrawalId,
        ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
          adminUserId,
          currentDatabase: db.rows[0]!.name,
          systemIdentifier: sid.rows[0]!.sid,
        }),
        applyConfirmation: __mintPhase21Gen4RecoveryApplyConfirmationForTests(),
        chainReconciliation,
        bindings: seed.bindings,
        deploymentEnvironment: 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
    } finally {
      client.release();
    }
  }

  async function permitStatuses(withdrawalId: string): Promise<string[]> {
    const r = await pool.query<{ g: number; s: string }>(
      `SELECT authorization_generation AS g, status::text AS s
       FROM phase21_manual_dispatch_permits WHERE withdrawal_id = $1::uuid
       ORDER BY authorization_generation`,
      [withdrawalId],
    );
    return r.rows.map((x) => `${x.g}:${x.s}`);
  }

  async function outboxCount(where: string, params: readonly unknown[]): Promise<number> {
    const r = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events WHERE ${where}`,
      [...params],
    );
    return r.rows[0]!.c;
  }

  it('PLAN is ready and read-only on the exact Gen-4 pre-state', async () => {
    const seed = await seedPreGen4();
    const client = await pool.connect();
    try {
      const plan = await planPhase21Gen4Recovery(client, {
        withdrawalId: seed.withdrawalId,
        chainReconciliation: recon(),
        deploymentEnvironment: 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
      expect(plan.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
      expect(plan.readyForGen4Apply).toBe(true);
      expect(plan.gen3TemporalLaunchClaimBound).toBe(true);
      expect(plan.mutated).toBe(false);
    } finally {
      client.release();
    }
    expect(await permitStatuses(seed.withdrawalId)).toEqual(['1:CONSUMED', '2:CONSUMED', '3:CONSUMED']);
  });

  it('APPLY arms generation 4 only; enqueues audit-only outbox; never claims or starts Temporal', async () => {
    const seed = await seedPreGen4();
    const r = await runApply(seed);
    expect(r.refuseCode).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.created).toBe(true);
    expect(r.temporalStarted).toBe(false);
    expect(r.broadcastPerformed).toBe(false);
    expect(r.signed).toBe(false);
    expect(r.outboxRelayStillDisabled).toBe(true);

    expect(await permitStatuses(seed.withdrawalId)).toEqual([
      '1:CONSUMED',
      '2:CONSUMED',
      '3:CONSUMED',
      '4:ARMED',
    ]);
    const gen4PermitId = r.permitId!;
    // Audit-only PENDING manual-dispatch row exists; NO Gen-4 launch claim row.
    expect(
      await outboxCount(`event_type = $1 AND aggregate_id = $2::uuid AND status = 'PENDING'`, [
        WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
        seed.withdrawalId,
      ]),
    ).toBe(1);
    expect(await outboxCount(`event_type = $1`, [PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE])).toBe(0);
    expect(
      await outboxCount(`dedupe_key = $1`, [
        buildPhase21Gen4TemporalLaunchClaimDedupeKey({
          withdrawalId: seed.withdrawalId,
          gen4PermitId,
        }),
      ]),
    ).toBe(0);
    // Prior launch claims preserved, attempts unchanged, withdrawal untouched.
    expect(await outboxCount(`event_type = $1`, [PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE])).toBe(1);
    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [seed.withdrawalId],
    );
    expect(attempts.rows[0]!.c).toBe(3);
    const w = await pool.query<{ state: string; settled: string | null; released: string | null }>(
      `SELECT state::text AS state, settlement_ledger_tx_id::text AS settled,
              release_ledger_tx_id::text AS released
       FROM withdrawals WHERE id = $1::uuid`,
      [seed.withdrawalId],
    );
    expect(w.rows[0]).toMatchObject({ state: 'FAILED_PRE_BROADCAST', settled: null, released: null });
  }, 60_000);

  it('APPLY is idempotent and concurrency-safe (one Gen-4 permit, one outbox row)', async () => {
    const seed = await seedPreGen4();
    const results = await Promise.all([runApply(seed), runApply(seed), runApply(seed)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.permitId)).size).toBe(1);
    const again = await runApply(seed);
    expect(again.ok).toBe(true);
    expect(again.reused).toBe(true);
    expect(await permitStatuses(seed.withdrawalId)).toEqual([
      '1:CONSUMED',
      '2:CONSUMED',
      '3:CONSUMED',
      '4:ARMED',
    ]);
    expect(
      await outboxCount(`event_type = $1 AND aggregate_id = $2::uuid`, [
        WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
        seed.withdrawalId,
      ]),
    ).toBe(1);
  }, 60_000);

  describe('APPLY refusals (no Gen-4 permit, no outbox row)', () => {
    async function expectRefused(
      seed: { withdrawalId: string; bindings: Phase21ManualDispatchPermitBindings },
      failedId: string,
      chainReconciliation = recon(),
    ) {
      const r = await runApply(seed, chainReconciliation);
      expect(r.ok).toBe(false);
      expect(r.applied).toBe(false);
      expect(r.refuseCode).toBe('GEN4_APPLY_PRECONDITIONS_FAILED');
      expect(r.planChecksFailed).toContain(failedId);
      expect(await permitStatuses(seed.withdrawalId)).not.toContain('4:ARMED');
      expect(
        await outboxCount(`event_type = $1 AND aggregate_id = $2::uuid`, [
          WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
          seed.withdrawalId,
        ]),
      ).toBe(0);
    }

    it('Gen-3 launch claim forged (payload bound to a different permit)', async () => {
      const seed = await seedPreGen4();
      await pool.query(
        `UPDATE outbox_events SET payload = jsonb_set(payload, '{gen3PermitId}', to_jsonb($2::text))
         WHERE dedupe_key = $1`,
        [
          buildPhase21Gen3TemporalLaunchClaimDedupeKey({
            withdrawalId: seed.withdrawalId,
            gen3PermitId: seed.gen3PermitId,
          }),
          randomUUID(),
        ],
      );
      await expectRefused(seed, 'gen3_temporal_launch_claim_bound');
    });

    it('Gen-3 launch claim missing', async () => {
      const seed = await seedPreGen4();
      await pool.query(`DELETE FROM outbox_events WHERE event_type = $1`, [
        PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
      ]);
      await expectRefused(seed, 'gen3_temporal_launch_claim_bound');
    });

    it('Gen-3 permit not CONSUMED', async () => {
      const seed = await seedPreGen4({ gen3Armed: true });
      // Gen-3 ARMED means no Gen-4 arm is possible (one ARMED permit per withdrawal).
      await expectRefused(seed, 'gen3_consumed_preserved');
    });

    it('recon priorQueryIds differ from the DB attempt query_ids', async () => {
      const seed = await seedPreGen4();
      await expectRefused(seed, 'chain_recon_prior_query_ids_match_db', recon(['1', '2', '999']));
      await expectRefused(seed, 'chain_recon_prior_query_ids_match_db', recon(['3', '2', '1']));
    });

    it('signed-but-lost evidence on a prior attempt', async () => {
      const seed = await seedPreGen4();
      await pool.query(`UPDATE withdrawal_attempts SET signed_message_hash = $2 WHERE id = $1::uuid`, [
        seed.attemptIds[1],
        '22'.repeat(32),
      ]);
      await expectRefused(seed, 'no_signature_or_broadcast_evidence');
    });

    it('Gen-1/Gen-2 consumed attempts swapped (exact permit→attempt_number binding)', async () => {
      const seed = await seedPreGen4({ swapGen1Gen2Attempts: true });
      await expectRefused(seed, 'gen1_bound_to_attempt_1');
    });

    it('chain recon without the mandatory external provider attestation', async () => {
      const seed = await seedPreGen4();
      const labelsOnly = {
        ...recon(),
        externalProviderObservationAttestation: undefined,
      } as never;
      const r = await runApply(seed, labelsOnly);
      expect(r.ok).toBe(false);
      expect(r.applied).toBe(false);
      expect(r.refuseCode).toBe('GEN4_CHAIN_RECON_REQUIRED');
      expect(r.message).toContain('external_attestation_missing');
      expect(await permitStatuses(seed.withdrawalId)).not.toContain('4:ARMED');
    });

    it('a fourth attempt already exists', async () => {
      const seed = await seedPreGen4();
      await insertAttempt(seed.withdrawalId, 4);
      await expectRefused(seed, 'prior_attempts_exactly_three_failed_pre');
    });
  });

  it('Temporal one-shot launch after APPLY: durable Gen-3 terminal identity, exactly one claim + one start, repeat refused', async () => {
    const seed = await seedPreGen4();
    const applied = await runApply(seed);
    expect(applied.ok).toBe(true);
    const gen4PermitId = applied.permitId!;
    const taskQueue = `phase21-gen4-e2e-${Date.now()}`;

    const activities = {
      async executeWithdrawalFakePayout() {
        return { state: 'CONFIRMED', attemptId: null };
      },
      async executeWithdrawalTestnetPayout() {
        await new Promise((r) => setTimeout(r, 500));
        return { state: 'CONFIRMED', attemptId: 'attempt-4-sim' };
      },
    };
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('../src/workflows.ts', import.meta.url)),
      activities,
    });

    await worker.runUntil(async () => {
      const planClient = await pool.connect();
      const claimClient = await pool.connect();
      try {
        const plan = await planPhase21Gen4TemporalLaunch(planClient, {
          withdrawalId: seed.withdrawalId,
          chainReconciliation: recon(),
          expectedDeploySha: 'd427269',
          liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
          globalRelayEnabled: false,
          signerReady: true,
          signerUnlocked: true,
          expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
          priorWorkflowFound: false, // Temporal history expired: durable DB terminal evidence path
          observedPriorRunId: null,
          priorWorkflowStatus: '',
          workflowStillRunning: false,
          taskQueue,
          deploymentEnvironment: 'LOCAL',
          allowNonCanaryWithdrawalIdForTests: true,
        });
        expect(plan.checks.filter((c) => c.status === 'FAIL')).toEqual([]);
        expect(plan.readyForExecute).toBe(true);
        expect(plan.priorWorkflowIdentityMode).toBe('durable_gen3_terminal');
        expect(plan.gen4PermitId).toBe(gen4PermitId);

        // PLAN preflight while the Signer is LOCKED: safety PASS, but not ready for EXECUTE.
        const lockedPlan = await planPhase21Gen4TemporalLaunch(planClient, {
          withdrawalId: seed.withdrawalId,
          chainReconciliation: recon(),
          expectedDeploySha: 'd427269',
          liveDeploySha: 'd427269798ac23c50bfebb762357eb84a945d67c',
          globalRelayEnabled: false,
          signerReady: true,
          signerUnlocked: false,
          expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
          priorWorkflowFound: false,
          observedPriorRunId: null,
          priorWorkflowStatus: '',
          workflowStillRunning: false,
          taskQueue,
          deploymentEnvironment: 'LOCAL',
          allowNonCanaryWithdrawalIdForTests: true,
        });
        expect(lockedPlan.ok).toBe(true);
        expect(lockedPlan.readyForExecute).toBe(false);
        expect(
          lockedPlan.checks.filter((c) => c.status === 'FAIL').map((c) => c.id),
        ).toEqual(['signer_unlocked_for_execute']);
        const lockedExec = await executePhase21Gen4TemporalLaunch({
          confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
          plan: lockedPlan,
          temporal: testEnv.client,
          claimClient,
          expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
          signerReady: true,
          signerUnlocked: true,
          chainReconciliation: recon(),
          deploymentEnvironment: 'LOCAL',
          allowNonCanaryWithdrawalIdForTests: true,
        });
        expect(lockedExec).toMatchObject({ started: false, refuseCode: 'PLAN_NOT_READY' });
        const lockedAtExecute = await executePhase21Gen4TemporalLaunch({
          confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
          plan,
          temporal: testEnv.client,
          claimClient,
          expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
          signerReady: true,
          signerUnlocked: false,
          chainReconciliation: recon(),
          deploymentEnvironment: 'LOCAL',
          allowNonCanaryWithdrawalIdForTests: true,
        });
        expect(lockedAtExecute).toMatchObject({
          started: false,
          refuseCode: 'SIGNER_NOT_READY_FOR_EXECUTE',
        });
        expect(
          await outboxCount(`event_type = $1`, [PHASE21_GEN4_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE]),
        ).toBe(0);

        const exec = () =>
          executePhase21Gen4TemporalLaunch({
            confirmationPhrase: PHASE21_GEN4_TEMPORAL_LAUNCH_ACK,
            plan,
            temporal: testEnv.client,
            claimClient,
            expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
            signerReady: true,
            signerUnlocked: true,
            chainReconciliation: recon(),
            deploymentEnvironment: 'LOCAL',
            allowNonCanaryWithdrawalIdForTests: true,
          });

        const launched = await exec();
        expect(launched).toMatchObject({
          ok: true,
          started: true,
          relayEnabled: false,
          signed: false,
          broadcastPerformed: false,
        });
        expect(launched.runId).toBeTruthy();

        // Exactly one DISPATCHED claim with the Gen-4 payload bindings.
        const claim = await pool.query<{ status: string; payload: Record<string, unknown> }>(
          `SELECT status::text AS status, payload FROM outbox_events WHERE dedupe_key = $1`,
          [
            buildPhase21Gen4TemporalLaunchClaimDedupeKey({
              withdrawalId: seed.withdrawalId,
              gen4PermitId,
            }),
          ],
        );
        expect(claim.rows).toHaveLength(1);
        expect(claim.rows[0]!.status).toBe('DISPATCHED');
        expect(claim.rows[0]!.payload).toMatchObject({
          gen4PermitId,
          expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
          identityMode: 'durable_gen3_terminal',
          authorizationGeneration: 4,
          broadcastPerformed: false,
        });

        // A repeated Owner request is refused by the durable claim; no second start.
        const repeated = await exec();
        expect(repeated).toMatchObject({ started: false, refuseCode: 'GEN4_TEMPORAL_ALREADY_CLAIMED' });

        const handle = testEnv.client.workflow.getHandle(withdrawalWorkflowId(seed.withdrawalId));
        await handle.result();
        const described = await handle.describe();
        expect(described.runId).toBe(launched.runId);
      } finally {
        planClient.release();
        claimClient.release();
      }
    });

    // Permits are not consumed by the launch claim (only the canonical pipeline consumes Gen-4).
    expect(await permitStatuses(seed.withdrawalId)).toEqual([
      '1:CONSUMED',
      '2:CONSUMED',
      '3:CONSUMED',
      '4:ARMED',
    ]);
  }, 180_000);
});
