/**
 * Disposable PostgreSQL concurrency regression: Gen-3 Temporal launch claim
 * revalidates under FOR UPDATE and unique outbox dedupe_key - exactly one winner.
 *
 * Uses PHASE7_DATABASE_URL (or PHASE7_WITHDRAWAL_TESTS=1 + DATABASE_URL).
 * Never touches production DB / Temporal / signing / broadcast.
 */
import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PHASE21_CANARY_ATTACHED_GRAM_ATOMIC } from '../src/phase21-canary-payout-plan.js';
import { PHASE21_CANARY_FORWARD_TON_ATOMIC } from '../src/phase21-canary-payout-plan.js';
import {
  PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
} from '../src/phase21-gen2-temporal-launch.js';
import { mintPhase21Gen3IndependentChainReconciliationForTests } from '../src/phase21-gen3-recovery-plan.js';
import {
  buildPhase21Gen3TemporalLaunchClaimDedupeKey,
  claimPhase21Gen3TemporalLaunch,
} from '../src/phase21-gen3-temporal-launch.js';
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

const EXPECTED_GEN2_RUN_ID = '01a2bbbb-cccc-dddd-eeee-ffffffffffff';

const describeDb = phase7DatabaseUrl === '' ? describe.skip : describe;

describeDb('phase21 Gen-3 Temporal launch claim race (disposable PG)', () => {
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
    adminUserId = await createOwnerAdmin(pool, `gen3-claim-race-${randomUUID()}@example.local`);
    await pool.query(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'gen3 claim race pause ON')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = true, updated_at = now()`,
    );
  });

  async function insertAttempt(input: {
    readonly withdrawalId: string;
    readonly attemptNumber: number;
    readonly queryId: number;
    readonly signedEvidence?: boolean;
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
         $8, $9::bigint, 'FAILED_PRE_BROADCAST',
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
        `gen3-claim-race.gen${input.generation}:${input.withdrawalId}`,
        input.status === 'CONSUMED' ? new Date().toISOString() : null,
        input.consumedAttemptId ?? null,
      ],
    );
  }

  async function insertGen2LaunchClaim(input: {
    readonly withdrawalId: string;
    readonly gen2PermitId: string;
  }): Promise<string> {
    const dedupeKey = buildPhase21Gen2TemporalLaunchClaimDedupeKey(input);
    await pool.query(
      `INSERT INTO outbox_events (
         aggregate_type, aggregate_id, event_type, payload, dedupe_key,
         status, available_at, dispatched_at
       ) VALUES (
         'withdrawal', $1::uuid, $2, $3::jsonb, $4,
         'DISPATCHED'::outbox_event_status, now(), now()
       )
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.withdrawalId,
        PHASE21_GEN2_TEMPORAL_LAUNCH_CLAIM_EVENT_TYPE,
        JSON.stringify({
          withdrawalId: input.withdrawalId,
          gen2PermitId: input.gen2PermitId,
          authorizationGeneration: 2,
        }),
        dedupeKey,
      ],
    );
    return dedupeKey;
  }

  /**
   * Seeds the exact Gen-3 shape: two FAILED_PRE attempts with no evidence,
   * Gen-1 + Gen-2 CONSUMED (bound to distinct attempts), durable Gen-2 launch
   * claim present, Gen-3 ARMED.
   */
  async function seedGen3ClaimShape(options?: {
    readonly withGen2LaunchClaim?: boolean;
    readonly attempt2SignedEvidence?: boolean;
    readonly onlyOneAttempt?: boolean;
  }): Promise<{
    readonly withdrawalId: string;
    readonly gen2PermitId: string;
    readonly gen3PermitId: string;
    readonly attempt1Id: string;
    readonly attempt2Id: string | null;
  }> {
    const userId = await createTestUser(pool, String(9400000 + Math.floor(Math.random() * 1e6)));
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

    const attempt1Id = await insertAttempt({ withdrawalId, attemptNumber: 1, queryId: 1 });
    const attempt2Id =
      options?.onlyOneAttempt === true
        ? null
        : await insertAttempt({
            withdrawalId,
            attemptNumber: 2,
            queryId: 2,
            ...(options?.attempt2SignedEvidence === true ? { signedEvidence: true } : {}),
          });

    const gen1PermitId = randomUUID();
    const gen2PermitId = randomUUID();
    const gen3PermitId = randomUUID();

    await insertPermit({
      id: gen1PermitId,
      withdrawalId,
      generation: 1,
      status: 'CONSUMED',
      consumedAttemptId: attempt1Id,
    });
    await insertPermit({
      id: gen2PermitId,
      withdrawalId,
      generation: 2,
      // Without an attempt #2 the only consistent DB state is an unconsumed Gen-2 permit.
      status: attempt2Id !== null ? 'CONSUMED' : 'ARMED',
      ...(attempt2Id !== null ? { consumedAttemptId: attempt2Id } : {}),
    });
    await insertPermit({
      id: gen3PermitId,
      withdrawalId,
      generation: 3,
      status: 'ARMED',
    });

    if (options?.withGen2LaunchClaim !== false) {
      await insertGen2LaunchClaim({ withdrawalId, gen2PermitId });
    }

    return { withdrawalId, gen2PermitId, gen3PermitId, attempt1Id, attempt2Id };
  }

  async function runClaim(input: {
    readonly withdrawalId: string;
    readonly gen3PermitId: string;
    readonly commit: boolean;
  }): Promise<{ created: boolean; refuseCode?: string }> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const claim = await claimPhase21Gen3TemporalLaunch({
          client,
          withdrawalId: input.withdrawalId,
          gen3PermitId: input.gen3PermitId,
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
        if (!input.commit) {
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

  it('concurrent Gen-3 launches: exactly one created=true; unique outbox claim preserved', async () => {
    const { withdrawalId, gen2PermitId, gen3PermitId } = await seedGen3ClaimShape();
    const gen3DedupeKey = buildPhase21Gen3TemporalLaunchClaimDedupeKey({
      withdrawalId,
      gen3PermitId,
    });

    const results = await Promise.all([
      runClaim({ withdrawalId, gen3PermitId, commit: true }),
      runClaim({ withdrawalId, gen3PermitId, commit: true }),
      runClaim({ withdrawalId, gen3PermitId, commit: true }),
    ]);
    const winners = results.filter((r) => r.created);
    const losers = results.filter((r) => !r.created);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    for (const loser of losers) {
      expect(loser.refuseCode).toBe('GEN3_TEMPORAL_ALREADY_CLAIMED');
    }

    const outbox = await pool.query<{ c: number; status: string }>(
      `SELECT count(*)::int AS c, max(status::text) AS status
       FROM outbox_events WHERE dedupe_key = $1`,
      [gen3DedupeKey],
    );
    expect(outbox.rows[0]?.c).toBe(1);
    expect(outbox.rows[0]?.status).toBe('DISPATCHED');

    // Gen-2 durable claim is never cleared by the Gen-3 claim.
    const gen2Claim = await pool.query<{ c: number; status: string }>(
      `SELECT count(*)::int AS c, max(status::text) AS status
       FROM outbox_events WHERE dedupe_key = $1`,
      [buildPhase21Gen2TemporalLaunchClaimDedupeKey({ withdrawalId, gen2PermitId })],
    );
    expect(gen2Claim.rows[0]?.c).toBe(1);
    expect(gen2Claim.rows[0]?.status).toBe('DISPATCHED');

    // Repeated Owner request after the claim is refused (one-shot, never re-launched).
    const repeat = await runClaim({ withdrawalId, gen3PermitId, commit: true });
    expect(repeat).toEqual({ created: false, refuseCode: 'GEN3_TEMPORAL_ALREADY_CLAIMED' });

    // Permits are untouched by the claim: Gen-1/Gen-2 remain CONSUMED, Gen-3 ARMED.
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
      '3:ARMED',
    ]);

    // No settlement/release and still exactly two attempts (no attempt #3 yet).
    const w = await pool.query<{ state: string; settled: string | null; released: string | null }>(
      `SELECT state::text AS state,
              settlement_ledger_tx_id::text AS settled,
              release_ledger_tx_id::text AS released
       FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(w.rows[0]).toMatchObject({
      state: 'FAILED_PRE_BROADCAST',
      settled: null,
      released: null,
    });
    const attempts = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(attempts.rows[0]?.c).toBe(2);
  }, 60_000);

  it('claim refuses when payout pause is OFF inside the claim transaction', async () => {
    const { withdrawalId, gen3PermitId } = await seedGen3ClaimShape();
    await pool.query(
      `UPDATE feature_flags SET enabled = false, updated_at = now()
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
    const result = await runClaim({ withdrawalId, gen3PermitId, commit: true });
    expect(result).toEqual({ created: false, refuseCode: 'CLAIM_PAYOUT_PAUSE_NOT_ON' });
  });

  it('claim refuses when the durable Gen-2 launch claim is missing', async () => {
    const { withdrawalId, gen3PermitId } = await seedGen3ClaimShape({
      withGen2LaunchClaim: false,
    });
    const result = await runClaim({ withdrawalId, gen3PermitId, commit: true });
    expect(result).toEqual({ created: false, refuseCode: 'CLAIM_GEN2_LAUNCH_CLAIM_MISSING' });
  });

  it('claim refuses signed-but-lost evidence on attempt #2 (reconcile, never blind retry)', async () => {
    const { withdrawalId, gen3PermitId } = await seedGen3ClaimShape({
      attempt2SignedEvidence: true,
    });
    const result = await runClaim({ withdrawalId, gen3PermitId, commit: true });
    expect(result).toEqual({ created: false, refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED' });
  });

  it('Gen-3 can never be ARMED on a Gen-2 shape: one ARMED permit per withdrawal is enforced', async () => {
    await expect(seedGen3ClaimShape({ onlyOneAttempt: true })).rejects.toThrow(
      /one_armed_per_withdrawal/,
    );
  });

  it('claim refuses when a third attempt already exists (one authorized attempt #3 only)', async () => {
    const { withdrawalId, gen3PermitId } = await seedGen3ClaimShape();
    await insertAttempt({ withdrawalId, attemptNumber: 3, queryId: 3 });
    const result = await runClaim({ withdrawalId, gen3PermitId, commit: true });
    expect(result).toEqual({ created: false, refuseCode: 'CLAIM_ATTEMPT_SHAPE_REFUSED' });
  });
  it('claim refuses a Gen-3 permit id that reuses a prior generation permit', async () => {
    const { withdrawalId, gen2PermitId } = await seedGen3ClaimShape();
    const result = await runClaim({ withdrawalId, gen3PermitId: gen2PermitId, commit: true });
    expect(result).toEqual({ created: false, refuseCode: 'CLAIM_GEN3_NOT_ARMED' });
  });

  it('claim refuses once the withdrawal is no longer FAILED_PRE_BROADCAST', async () => {
    const { withdrawalId, gen3PermitId } = await seedGen3ClaimShape();
    await pool.query(
      `UPDATE withdrawals SET state = 'BROADCASTING'::withdrawal_state WHERE id = $1::uuid`,
      [withdrawalId],
    );
    const result = await runClaim({ withdrawalId, gen3PermitId, commit: true });
    expect(result).toEqual({ created: false, refuseCode: 'CLAIM_WITHDRAWAL_STATE_REFUSED' });
  });
});
