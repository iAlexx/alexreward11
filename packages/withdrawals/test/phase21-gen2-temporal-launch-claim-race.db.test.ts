/**
 * Disposable PostgreSQL concurrency regression: Gen-2 Temporal launch claim
 * revalidates under FOR UPDATE and unique outbox dedupe_key — exactly one winner.
 *
 * Uses PHASE7_DATABASE_URL (or PHASE7_WITHDRAWAL_TESTS=1 + DATABASE_URL).
 * Never touches production DB / Temporal / signing / broadcast.
 */
import { createHash, randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PHASE21_CANARY_ATTACHED_GRAM_ATOMIC } from '../src/phase21-canary-payout-plan.js';
import { PHASE21_CANARY_FORWARD_TON_ATOMIC } from '../src/phase21-canary-payout-plan.js';
import { mintPhase21Gen2IndependentChainReconciliationForTests } from '../src/phase21-gen2-recovery-plan.js';
import {
  buildPhase21Gen2TemporalLaunchClaimDedupeKey,
  claimPhase21Gen2TemporalLaunch,
} from '../src/phase21-gen2-temporal-launch.js';
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

const RECIPIENT_RAW = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RECIPIENT_FRIENDLY = `EQ${RECIPIENT_RAW.slice(2, 50)}`;
const TEST_PUBLIC_KEY_HEX = '11'.repeat(32);
const ENCRYPTED_SIGNER_REF = createHash('sha256')
  .update(Buffer.from(TEST_PUBLIC_KEY_HEX, 'hex'))
  .digest('hex');

const describeDb = phase7DatabaseUrl === '' ? describe.skip : describe;

describeDb('phase21 Gen-2 Temporal launch claim race (disposable PG)', () => {
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
    adminUserId = await createOwnerAdmin(pool, `gen2-claim-race-${randomUUID()}@example.local`);
    await pool.query(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ('PAYOUT_DISPATCH_PAUSE', 'LOCAL', true, 'gen2 claim race pause ON')
       ON CONFLICT (flag_key, environment) DO UPDATE
         SET enabled = true, updated_at = now()`,
    );
  });

  async function seedGen2ClaimShape(): Promise<{
    readonly withdrawalId: string;
    readonly gen2PermitId: string;
  }> {
    const userId = await createTestUser(pool, String(9300000 + Math.floor(Math.random() * 1e6)));
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
         $5, 1, 'FAILED_PRE_BROADCAST',
         false
       )`,
      [attemptId, withdrawalId, hotWalletId, '11'.repeat(32), ENCRYPTED_SIGNER_REF],
    );

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
      [withdrawalId],
    );
    const w = row.rows[0]!;
    const gen1Id = randomUUID();
    const gen2PermitId = randomUUID();

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
         $1::uuid, $2::uuid, 1, $3,
         $4::bigint, $5::bigint, $6::bigint,
         $7, $8,
         'TON_TESTNET', 'USDT', $9,
         $10::bigint, $11::bigint,
         'CONSUMED'::phase21_manual_dispatch_permit_status, $12::uuid, $13,
         now(), $14::uuid
       )`,
      [
        gen1Id,
        withdrawalId,
        w.public_id,
        w.gross,
        w.fee,
        w.net,
        RECIPIENT_FRIENDLY,
        RECIPIENT_RAW,
        PHASE21_CANARY_FROZEN_JETTON_MASTER,
        PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10),
        PHASE21_CANARY_FORWARD_TON_ATOMIC.toString(10),
        adminUserId,
        `gen2-claim-race.gen1:${withdrawalId}`,
        attemptId,
      ],
    );

    await pool.query(
      `INSERT INTO phase21_manual_dispatch_permits (
         id, withdrawal_id, authorization_generation, public_id,
         authorized_gross_atomic, authorized_fee_atomic, authorized_net_atomic,
         authorized_recipient_friendly, authorized_recipient_raw,
         authorized_network_code, authorized_asset_symbol, authorized_jetton_master,
         authorized_attached_gram_atomic, authorized_forward_gram_atomic,
         status, created_by_admin_user_id, idempotency_key
       ) VALUES (
         $1::uuid, $2::uuid, 2, $3,
         $4::bigint, $5::bigint, $6::bigint,
         $7, $8,
         'TON_TESTNET', 'USDT', $9,
         $10::bigint, $11::bigint,
         'ARMED'::phase21_manual_dispatch_permit_status, $12::uuid, $13
       )`,
      [
        gen2PermitId,
        withdrawalId,
        w.public_id,
        w.gross,
        w.fee,
        w.net,
        RECIPIENT_FRIENDLY,
        RECIPIENT_RAW,
        PHASE21_CANARY_FROZEN_JETTON_MASTER,
        PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10),
        PHASE21_CANARY_FORWARD_TON_ATOMIC.toString(10),
        adminUserId,
        `gen2-claim-race.gen2:${withdrawalId}`,
      ],
    );

    return { withdrawalId, gen2PermitId };
  }

  it('concurrent claims: exactly one created=true; unique outbox claim preserved', async () => {
    const { withdrawalId, gen2PermitId } = await seedGen2ClaimShape();
    const chainReconciliation = mintPhase21Gen2IndependentChainReconciliationForTests();
    const dedupeKey = buildPhase21Gen2TemporalLaunchClaimDedupeKey({
      withdrawalId,
      gen2PermitId,
    });

    async function raceClaim(): Promise<{ created: boolean; refuseCode?: string }> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        try {
          const claim = await claimPhase21Gen2TemporalLaunch({
            client,
            withdrawalId,
            gen2PermitId,
            expectedGen1RunId: '01a13154-dc13-739c-92d1-8579627cc06e',
            identityMode: 'durable_gen1_terminal',
            chainReconciliation,
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
        }
      } finally {
        client.release();
      }
    }

    const results = await Promise.all([raceClaim(), raceClaim(), raceClaim()]);
    const winners = results.filter((r) => r.created);
    const losers = results.filter((r) => !r.created);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    for (const loser of losers) {
      expect(loser.refuseCode).toBe('GEN2_TEMPORAL_ALREADY_CLAIMED');
    }

    const outbox = await pool.query<{ c: number; status: string }>(
      `SELECT count(*)::int AS c, max(status::text) AS status
       FROM outbox_events WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    expect(outbox.rows[0]?.c).toBe(1);
    expect(outbox.rows[0]?.status).toBe('DISPATCHED');
  }, 60_000);

  it('claim refuses when payout pause is OFF inside the claim transaction', async () => {
    const { withdrawalId, gen2PermitId } = await seedGen2ClaimShape();
    await pool.query(
      `UPDATE feature_flags SET enabled = false, updated_at = now()
       WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE' AND environment = 'LOCAL'`,
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claim = await claimPhase21Gen2TemporalLaunch({
        client,
        withdrawalId,
        gen2PermitId,
        expectedGen1RunId: '01a13154-dc13-739c-92d1-8579627cc06e',
        identityMode: 'durable_gen1_terminal',
        chainReconciliation: mintPhase21Gen2IndependentChainReconciliationForTests(),
        deploymentEnvironment: 'LOCAL',
        allowNonCanaryWithdrawalIdForTests: true,
      });
      await client.query('ROLLBACK');
      expect(claim).toMatchObject({
        created: false,
        refuseCode: 'CLAIM_PAYOUT_PAUSE_NOT_ON',
      });
    } finally {
      client.release();
    }
  });
});
