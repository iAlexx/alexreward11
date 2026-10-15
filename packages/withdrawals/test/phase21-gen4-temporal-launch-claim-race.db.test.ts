/**
 * Disposable PostgreSQL concurrency regression: Gen-4 Temporal launch claim
 * revalidates under FOR UPDATE and unique outbox dedupe_key - exactly one winner.
 *
 * Uses PHASE7_DATABASE_URL (or PHASE7_WITHDRAWAL_TESTS=1 + DATABASE_URL).
 * Never touches production DB / Temporal / signing / broadcast.
 */
import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withdrawalWorkflowId } from '../src/outbox.js';
import {
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
} from '../src/phase21-canary-payout-plan.js';
import {
  PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
} from '../src/phase21-gen2-temporal-launch.js';
import {
  PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
} from '../src/phase21-gen3-temporal-launch.js';
import { mintPhase21Gen4IndependentChainReconciliationForTests } from '../src/phase21-gen4-recovery-plan.js';
import {
  buildPhase21Gen4TemporalLaunchClaimDedupeKey,
  claimPhase21Gen4TemporalLaunch,
} from '../src/phase21-gen4-temporal-launch.js';
import { PHASE21_CANARY_FROZEN_JETTON_MASTER } from '../src/phase21-manual-dispatch-permit.js';

import {
  createApprovedWithdrawal,
  createOwnerAdmin,
  createTestUser,
  createVerifiedPrimaryWallet,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

const RECIPIENT_RAW = '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const RECIPIENT_FRIENDLY = `EQ${RECIPIENT_RAW.slice(2, 50)}`;
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');

const EXPECTED_GEN3_RUN_ID = '01a3cccc-dddd-eeee-ffff-000000000000';

const describeDb = phase7DatabaseUrl === '' ? describe.skip : describe;

describeDb('phase21 Gen-4 Temporal launch claim race (disposable PG)', () => {
  let pool: Pool;
  let networkId: string;
  let assetId: string;
  let hotWalletId: string;
  let adminUserId: string;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl, max: 8 });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    const base = await seedPhase7Base(pool);
    networkId = base.networkId;
    assetId = base.assetId;
    hotWalletId = base.hotWalletId;
    adminUserId = await createOwnerAdmin(pool, `gen4-claim-race-${randomUUID()}@example.local`);
    await pool.query(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'gen4 claim race pause ON')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = true, updated_at = now()`,
    );
  });

  async function insertAttempt(input: {
    readonly withdrawalId: string;
    readonly attemptNumber: number;
    readonly queryId: number;
    readonly signedEvidence?: boolean;
    readonly state?: string;
  }): Promise<string> {
    const attemptId = randomUUID();
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         id, withdrawal_id, attempt_number, hot_wallet_id,
         expected_seqno, query_id, valid_until, canonical_message_hash,
         signed_message_hash,
         signer_key_reference, dispatch_fencing_token, broadcast_result_state,
         requires_state_init
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4::uuid,
         7, $5::bigint, now() + interval '5 minutes', $6,
         $7,
         $8, $9::bigint, $10,
         false
       )`,
      [
        attemptId,
        input.withdrawalId,
        input.attemptNumber,
        hotWalletId,
        input.queryId,
        '11'.repeat(32),
        input.signedEvidence === true ? '22'.repeat(32) : null,
        ENCRYPTED_SIGNER_REF,
        input.attemptNumber,
        input.state ?? 'FAILED_PRE_BROADCAST',
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
    const row = await pool.query<{
      public_id: string;
      gross: string;
      fee: string;
      net: string;
    }>(
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
        `gen4-claim-race.gen${input.generation}:${input.withdrawalId}`,
        input.status === 'CONSUMED' ? new Date().toISOString() : null,
        input.consumedAttemptId ?? null,
      ],
    );
  }

  async function insertDispatchedClaim(input: {
    readonly withdrawalId: string;
    readonly eventType: string;
    readonly dedupeKey: string;
    readonly payload: Record<string, unknown>;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO outbox_events (
         aggregate_type, aggregate_id, event_type, payload, dedupe_key,
         status, available_at, dispatched_at
       ) VALUES (
         'withdrawal', $1::uuid, $2, $3::jsonb, $4,
         'DISPATCHED'::outbox_event_status, now(), now()
       )
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [input.withdrawalId, input.eventType, JSON.stringify(input.payload), input.dedupeKey],
    );
  }

  /**
   * Seeds the exact Gen-4 shape: three FAILED_PRE attempts with no evidence (query ids 1/2/3),
   * Gen-1/2/3 CONSUMED (bound to attempts #1/#2/#3), durable Gen-2 + bound Gen-3 launch
   * claims, and an ARMED Gen-4 permit.
   */
  async function seedGen4ClaimShape(options?: {
    readonly withGen2LaunchClaim?: boolean;
    readonly withGen3LaunchClaim?: boolean;
    readonly gen3ClaimPayloadPatch?: Record<string, unknown>;
    /** Which attempt (by number) each CONSUMED permit is bound to; default exact 1/2/3. */
    readonly permitAttemptNumbers?: {
      readonly gen1?: 1 | 2 | 3;
      readonly gen2?: 1 | 2 | 3;
      readonly gen3?: 1 | 2 | 3;
    };
  }): Promise<{
    readonly withdrawalId: string;
    readonly gen1PermitId: string;
    readonly gen2PermitId: string;
    readonly gen3PermitId: string;
    readonly gen4PermitId: string;
    readonly attemptIds: readonly [string, string, string];
  }> {
    const userId = await createTestUser(pool, String(9500000 + Math.floor(Math.random() * 1e6)));
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
    });
    await pool.query(
      `UPDATE withdrawals
       SET state = 'FAILED_PRE_BROADCAST'::withdrawal_state
       WHERE id = $1::uuid`,
      [withdrawalId],
    );

    const a1 = await insertAttempt({ withdrawalId, attemptNumber: 1, queryId: 1 });
    const a2 = await insertAttempt({ withdrawalId, attemptNumber: 2, queryId: 2 });
    const a3 = await insertAttempt({ withdrawalId, attemptNumber: 3, queryId: 3 });

    const gen1PermitId = randomUUID();
    const gen2PermitId = randomUUID();
    const gen3PermitId = randomUUID();
    const gen4PermitId = randomUUID();

    const byNumber = { 1: a1, 2: a2, 3: a3 } as const;
    const pn = options?.permitAttemptNumbers;
    await insertPermit({ id: gen1PermitId, withdrawalId, generation: 1, status: 'CONSUMED', consumedAttemptId: byNumber[pn?.gen1 ?? 1] });
    await insertPermit({ id: gen2PermitId, withdrawalId, generation: 2, status: 'CONSUMED', consumedAttemptId: byNumber[pn?.gen2 ?? 2] });
    await insertPermit({ id: gen3PermitId, withdrawalId, generation: 3, status: 'CONSUMED', consumedAttemptId: byNumber[pn?.gen3 ?? 3] });
    await insertPermit({ id: gen4PermitId, withdrawalId, generation: 4, status: 'ARMED' });

    if (options?.withGen2LaunchClaim !== false) {
      await insertDispatchedClaim({
        withdrawalId,
        eventType: PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
        dedupeKey: buildPhase21Gen2TemporalLaunchClaimDedupeKey({ withdrawalId, gen2PermitId }),
        payload: { withdrawalId, gen2PermitId, authorizationGeneration: 2 },
      });
    }
    if (options?.withGen3LaunchClaim !== false) {
      await insertDispatchedClaim({
        withdrawalId,
        eventType: PHASE21_GEN3_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
        dedupeKey: buildPhase21Gen3TemporalLaunchClaimDedupeKey({ withdrawalId, gen3PermitId }),
        payload: {
          withdrawalId,
          gen3PermitId,
          expectedGen2RunId: '01a2bbbb-cccc-dddd-eeee-ffffffffffff',
          identityMode: 'durable_gen2_terminal',
          workflowId: withdrawalWorkflowId(withdrawalId),
          authorizationGeneration: 3,
          broadcastPerformed: false,
          signed: false,
          ...(options?.gen3ClaimPayloadPatch ?? {}),
        },
      });
    }

    return {
      withdrawalId,
      gen1PermitId,
      gen2PermitId,
      gen3PermitId,
      gen4PermitId,
      attemptIds: [a1, a2, a3],
    };
  }

  async function runClaim(input: {
    readonly withdrawalId: string;
    readonly gen4PermitId: string;
    readonly commit?: boolean;
    readonly priorQueryIds?: readonly string[];
  }): Promise<{ created: boolean; refuseCode?: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const claim = await claimPhase21Gen4TemporalLaunch({
          client,
          withdrawalId: input.withdrawalId,
          gen4PermitId: input.gen4PermitId,
          expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
          identityMode: 'durable_gen3_terminal',
          chainReconciliation: mintPhase21Gen4IndependentChainReconciliationForTests({
            priorQueryIds: input.priorQueryIds ?? ['1', '2', '3'],
          }),
          deploymentEnvironment: 'LOCAL',
          allowNonCanaryWithdrawalIdForTests: true,
        });
        if (!claim.created) {
          await client.query('ROLLBACK');
          return { created: false, refuseCode: claim.refuseCode };
        }
        if (input.commit === false) {
          await client.query('ROLLBACK');
          return { created: true };
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
      }
    } finally {
      client.release();
    }
  }

  it('concurrent Gen-4 launches: exactly one created=true; unique outbox claim preserved', async () => {
    const seed = await seedGen4ClaimShape();
    const { withdrawalId, gen2PermitId, gen3PermitId, gen4PermitId } = seed;
    const gen4DedupeKey = buildPhase21Gen4TemporalLaunchClaimDedupeKey({ withdrawalId, gen4PermitId });

    const results = await Promise.all([
      runClaim({ withdrawalId, gen4PermitId }),
      runClaim({ withdrawalId, gen4PermitId }),
      runClaim({ withdrawalId, gen4PermitId }),
    ]);
    const winners = results.filter((r) => r.created);
    const losers = results.filter((r) => !r.created);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    for (const loser of losers) {
      expect(loser.refuseCode).toBe('GEN4_TEMPORAL_ALREADY_CLAIMED');
    }

    const outbox = await pool.query<{ c: number; status: string; payload: Record<string, unknown> }>(
      `SELECT count(*)::int AS c, max(status::text) AS status, (array_agg(payload))[1] AS payload
       FROM outbox_events WHERE dedupe_key = $1`,
      [gen4DedupeKey],
    );
    expect(outbox.rows[0]?.c).toBe(1);
    expect(outbox.rows[0]?.status).toBe('DISPATCHED');
    expect(outbox.rows[0]?.payload).toMatchObject({
      withdrawalId,
      gen4PermitId,
      expectedGen3RunId: EXPECTED_GEN3_RUN_ID,
      identityMode: 'durable_gen3_terminal',
      authorizationGeneration: 4,
      broadcastPerformed: false,
      signed: false,
    });

    // Gen-2 and Gen-3 durable claims are never cleared by the Gen-4 claim.
    for (const key of [
      buildPhase21Gen2TemporalLaunchClaimDedupeKey({ withdrawalId, gen2PermitId }),
      buildPhase21Gen3TemporalLaunchClaimDedupeKey({ withdrawalId, gen3PermitId }),
    ]) {
      const prior = await pool.query<{ c: number; status: string }>(
        `SELECT count(*)::int AS c, max(status::text) AS status
         FROM outbox_events WHERE dedupe_key = $1`,
        [key],
      );
      expect(prior.rows[0]?.c).toBe(1);
      expect(prior.rows[0]?.status).toBe('DISPATCHED');
    }

    // Repeated Owner request after the claim is refused (one-shot, never re-launched).
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'GEN4_TEMPORAL_ALREADY_CLAIMED',
    });

    // Permits untouched by the claim: Gen-1/2/3 CONSUMED, Gen-4 ARMED.
    const permits = await pool.query<{ authorization_generation: number; status: string }>(
      `SELECT authorization_generation, status::text AS status
       FROM phase21_manual_dispatch_permits
       WHERE withdrawal_id = $1::uuid
       ORDER BY authorization_generation`,
      [withdrawalId],
    );
    expect(permits.rows.map((r) => `${r.authorization_generation}:${r.status}`)).toEqual([
      '1:CONSUMED',
      '2:CONSUMED',
      '3:CONSUMED',
      '4:ARMED',
    ]);

    // No settlement/release and still exactly three attempts (no attempt #4 yet).
    const w = await pool.query<{ state: string; settled: string | null; released: string | null }>(
      `SELECT state::text AS state,
              settlement_ledger_tx_id::text AS settled,
              release_ledger_tx_id::text AS released
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]).toMatchObject({ state: 'FAILED_PRE_BROADCAST', settled: null, released: null });
    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(3);
  }, 60_000);

  it('claim refuses when payout pause is OFF inside the claim transaction', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape();
    await pool.query(
      `UPDATE feature_flags SET enabled = false, updated_at = now()
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_PAYOUT_PAUSE_NOT_ON',
    });
  });

  it('claim refuses when the durable Gen-2 launch claim is missing', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape({ withGen2LaunchClaim: false });
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_GEN2_LAUNCH_CLAIM_MISSING',
    });
  });

  it('claim refuses when the Gen-3 launch claim is missing', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape({ withGen3LaunchClaim: false });
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_GEN3_LAUNCH_CLAIM_GEN3_LAUNCH_CLAIM_MISSING',
    });
  });

  it('claim refuses a Gen-3 launch claim whose payload is bound to a different permit (presence is not enough)', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape({
      gen3ClaimPayloadPatch: { gen3PermitId: randomUUID() },
    });
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_GEN3_LAUNCH_CLAIM_GEN3_LAUNCH_CLAIM_PAYLOAD_WRONG_PERMIT',
    });
  });

  it('claim refuses a Gen-3 launch claim that is not DISPATCHED', async () => {
    const { withdrawalId, gen3PermitId, gen4PermitId } = await seedGen4ClaimShape();
    await pool.query(
      `UPDATE outbox_events SET status = 'PENDING'::outbox_event_status, dispatched_at = NULL
       WHERE dedupe_key = $1`,
      [buildPhase21Gen3TemporalLaunchClaimDedupeKey({ withdrawalId, gen3PermitId })],
    );
    const result = await runClaim({ withdrawalId, gen4PermitId });
    expect(result.created).toBe(false);
    expect(result.refuseCode).toBe('CLAIM_GEN3_LAUNCH_CLAIM_GEN3_LAUNCH_CLAIM_NOT_DISPATCHED');
  });

  it('claim refuses signed-but-lost evidence on a prior attempt (reconcile, never blind retry)', async () => {
    const { withdrawalId, gen4PermitId, attemptIds } = await seedGen4ClaimShape();
    await pool.query(
      `UPDATE withdrawal_attempts SET signed_message_hash = $2 WHERE id = $1::uuid`,
      [attemptIds[1], '22'.repeat(32)],
    );
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED',
    });
  });

  it('claim refuses when a fourth attempt already exists (one authorized attempt #4 only)', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape();
    await insertAttempt({ withdrawalId, attemptNumber: 4, queryId: 4 });
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED',
    });
  });

  it('claim refuses chain recon whose priorQueryIds do not equal the DB attempt query_ids', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape();
    expect(
      await runClaim({ withdrawalId, gen4PermitId, priorQueryIds: ['1', '2', '999'] }),
    ).toEqual({ created: false, refuseCode: 'CLAIM_CHAIN_RECON_PRIOR_QUERY_IDS_MISMATCH_DB' });
    expect(
      await runClaim({ withdrawalId, gen4PermitId, priorQueryIds: ['2', '1', '3'] }),
    ).toEqual({ created: false, refuseCode: 'CLAIM_CHAIN_RECON_PRIOR_QUERY_IDS_MISMATCH_DB' });
  });

  it('claim refuses swapped Gen-1/Gen-2 consumed attempts (Gen-1 bound to attempt 2, Gen-2 to attempt 1)', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape({
      permitAttemptNumbers: { gen1: 2, gen2: 1 },
    });
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_GEN1_NOT_BOUND_TO_ATTEMPT_1',
    });
    const claim = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM outbox_events WHERE dedupe_key = $1`,
      [buildPhase21Gen4TemporalLaunchClaimDedupeKey({ withdrawalId, gen4PermitId })],
    );
    expect(claim.rows[0]?.c).toBe(0);
  });

  it('claim refuses Gen-2 not bound to attempt 2 even when Gen-1 is exact (Gen-2 on attempt 3, Gen-3 on attempt 2)', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape({
      permitAttemptNumbers: { gen2: 3, gen3: 2 },
    });
    const r = await runClaim({ withdrawalId, gen4PermitId });
    expect(r.created).toBe(false);
    // Gen-3 launch-claim binding (attempt #3 identity) is verified first and refuses; the exact
    // binding gate is defence in depth behind it.
    expect(r.refuseCode).toMatch(
      /^CLAIM_(GEN3_LAUNCH_CLAIM_GEN3_ATTEMPT_NOT_ATTEMPT3|GEN2_NOT_BOUND_TO_ATTEMPT_2)$/,
    );
  });

  it('claim refuses Gen-3 consumed attempt bound to the wrong attempt number', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape({
      permitAttemptNumbers: { gen3: 1, gen1: 3 },
    });
    const r = await runClaim({ withdrawalId, gen4PermitId });
    expect(r.created).toBe(false);
    expect(r.refuseCode).toMatch(
      /^CLAIM_(GEN3_LAUNCH_CLAIM_GEN3_ATTEMPT_NOT_ATTEMPT3|GEN1_NOT_BOUND_TO_ATTEMPT_1|GEN3_NOT_BOUND_TO_ATTEMPT_3)$/,
    );
  });

  it('claim refuses a Gen-4 permit id that reuses a prior generation permit', async () => {
    const { withdrawalId, gen3PermitId, gen2PermitId } = await seedGen4ClaimShape();
    for (const reused of [gen3PermitId, gen2PermitId]) {
      expect(await runClaim({ withdrawalId, gen4PermitId: reused })).toEqual({
        created: false,
        refuseCode: 'CLAIM_GEN4_NOT_ARMED',
      });
    }
  });

  it('claim refuses once the withdrawal is no longer FAILED_PRE_BROADCAST', async () => {
    const { withdrawalId, gen4PermitId } = await seedGen4ClaimShape();
    await pool.query(
      `UPDATE withdrawals SET state = 'BROADCASTING'::withdrawal_state WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(await runClaim({ withdrawalId, gen4PermitId })).toEqual({
      created: false,
      refuseCode: 'CLAIM_WITHDRAWAL_STATE_REFUSED',
    });
  });

  it('claim waits on the attempt-row lock (shape is read UNDER the FOR UPDATE), then proceeds', async () => {
    const { withdrawalId, gen4PermitId, attemptIds } = await seedGen4ClaimShape();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE withdrawal_attempts SET updated_at = now() WHERE id = $1::uuid`, [
        attemptIds[2],
      ]);

      let settled = false;
      const claim = runClaim({ withdrawalId, gen4PermitId }).then((r) => {
        settled = true;
        return r;
      });
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false); // blocked on the attempt-row lock held by the other txn

      await holder.query('COMMIT');
      const result = await claim;
      expect(result).toEqual({ created: true });
    } finally {
      try {
        await holder.query('ROLLBACK');
      } catch {
        // already committed
      }
      holder.release();
    }
  }, 60_000);
});
