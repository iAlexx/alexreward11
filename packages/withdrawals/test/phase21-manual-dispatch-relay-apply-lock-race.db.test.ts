/**
 * Disposable PostgreSQL two-transaction race:
 * historical Gen-2 PENDING manual_dispatch relay vs concurrent APPLY-style Gen-4 insert.
 *
 * Proves the shared withdrawals FOR UPDATE lock closes the phantom-insert window that
 * permit-row locks alone cannot close. Never touches production / Temporal / signing.
 */
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
} from '../src/phase21-canary-payout-plan.js';
import { PHASE21_CANARY_FROZEN_JETTON_MASTER } from '../src/phase21-manual-dispatch-permit.js';
import {
  WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
  buildPhase21PayoutConfig,
  processWithdrawalPhase21ManualDispatchOutboxBatch,
  tryBuildPhase21ManualDispatchRelayAuthority,
  withdrawalWorkflowId,
  type Phase21ManualDispatchRelayAuthority,
  type TemporalWorkflowStarter,
} from '../src/index.js';

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

const RECIPIENT_RAW = '0:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const RECIPIENT_FRIENDLY = `EQ${RECIPIENT_RAW.slice(2, 50)}`;

const describeDb = phase7DatabaseUrl === '' ? describe.skip : describe;

function buildMainnetRelayAuthority(): Phase21ManualDispatchRelayAuthority {
  const phase21 = buildPhase21PayoutConfig({
    phase21MainnetEnabled: true,
    realChainEnabled: true,
    fakeChainEnabled: false,
    signerServiceToken: 'x'.repeat(32),
    primaryProviderKind: 'toncenter',
    primaryProviderUrl: 'https://toncenter.com/api/v2',
    secondaryProviderKind: 'tonapi',
    secondaryProviderUrl: 'https://tonapi.io',
    jettonMasterIdentity: 'EQ_owner_approved_mainnet_usdt_jetton_master',
    signerBaseUrl: 'https://signer.example.internal',
  });
  const authority = tryBuildPhase21ManualDispatchRelayAuthority({
    payoutAuthority: 'PHASE21_MAINNET',
    phase21MainnetEnabled: true,
    withdrawalNetworkCode: 'TON_MAINNET',
    realChainEnabled: true,
    fakeChainEnabled: false,
    phase21,
  });
  if (authority === null) {
    throw new Error('expected Phase21 Mainnet relay authority');
  }
  return authority;
}

function recordingStarter(): TemporalWorkflowStarter & {
  readonly starts: Array<{ workflowId: string }>;
} {
  const starts: Array<{ workflowId: string }> = [];
  return {
    starts,
    workflow: {
      async start(_type, options) {
        starts.push({ workflowId: options.workflowId });
        return {};
      },
      getHandle(_workflowId: string) {
        return {
          async describe() {
            return { status: { name: 'COMPLETED' } };
          },
        };
      },
    },
  };
}

async function waitUntilRelayWaitingOnWithdrawalLock(
  pool: Pool,
  applyClient: PoolClient,
  timeoutMs = 15_000,
): Promise<void> {
  const backend = await applyClient.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
  const applyPid = backend.rows[0]!.pid;
  const started = Date.now();
  for (;;) {
    const waiting = await pool.query<{ waiting_pid: number }>(
      `SELECT l.pid AS waiting_pid
       FROM pg_locks l
       JOIN pg_locks held
         ON held.locktype = l.locktype
        AND held.database IS NOT DISTINCT FROM l.database
        AND held.relation IS NOT DISTINCT FROM l.relation
        AND held.page IS NOT DISTINCT FROM l.page
        AND held.tuple IS NOT DISTINCT FROM l.tuple
        AND held.virtualxid IS NOT DISTINCT FROM l.virtualxid
        AND held.transactionid IS NOT DISTINCT FROM l.transactionid
        AND held.classid IS NOT DISTINCT FROM l.classid
        AND held.objid IS NOT DISTINCT FROM l.objid
        AND held.objsubid IS NOT DISTINCT FROM l.objsubid
       WHERE held.pid = $1::int
         AND held.granted = true
         AND l.granted = false
         AND l.pid <> $1::int`,
      [applyPid],
    );
    if (waiting.rows.length > 0) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error('timed out waiting for relay to block on withdrawal FOR UPDATE');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

describeDb('phase21 manual-dispatch relay vs APPLY withdrawal-lock race (disposable PG)', () => {
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
    adminUserId = await createOwnerAdmin(pool, `relay-apply-race-${randomUUID()}@example.local`);
  });

  async function insertArmedGen2(withdrawalId: string, permitId: string): Promise<void> {
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
        permitId,
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
        `phase21.manual_dispatch.canary:${withdrawalId}:gen:2`,
      ],
    );
  }

  it('APPLY holds withdrawal FOR UPDATE + inserts Gen-4 → relay dead-letters Gen-2 event, zero Temporal starts', async () => {
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

    const gen2PermitId = randomUUID();
    const gen4PermitId = randomUUID();
    const binderAttemptId = randomUUID();

    await insertArmedGen2(withdrawalId, gen2PermitId);

    await pool.query(
      `INSERT INTO outbox_events (
         aggregate_type, aggregate_id, event_type, payload, dedupe_key,
         status, available_at
       ) VALUES (
         'withdrawal', $1::uuid, $2, $3::jsonb, $4,
         'PENDING'::outbox_event_status, now() - interval '1 minute'
       )`,
      [
        withdrawalId,
        WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
        JSON.stringify({
          withdrawalId,
          workflowId: withdrawalWorkflowId(withdrawalId),
          permitId: gen2PermitId,
          phase21ManualDispatch: true,
        }),
        `phase21.manual_dispatch.relay-race:${withdrawalId}:${gen2PermitId}`,
      ],
    );

    const applyClient = await pool.connect();
    const starter = recordingStarter();
    try {
      await applyClient.query('BEGIN');
      await applyClient.query(`SELECT id FROM withdrawals WHERE id = $1::uuid FOR UPDATE`, [
        withdrawalId,
      ]);

      const relayPromise = processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
        client: starter,
        taskQueue: 'tq-relay-apply-race',
        authority: buildMainnetRelayAuthority(),
      });

      await waitUntilRelayWaitingOnWithdrawalLock(pool, applyClient);

      await applyClient.query(
        `INSERT INTO withdrawal_attempts (
           id, withdrawal_id, attempt_number, hot_wallet_id,
           expected_seqno, query_id, valid_until, canonical_message_hash,
           signer_key_reference, dispatch_fencing_token, broadcast_result_state,
           requires_state_init
         ) VALUES (
           $1::uuid, $2::uuid, 1, $3::uuid,
           7, 1::bigint, now() + interval '5 minutes', $4,
           $5, 1::bigint, 'FAILED_PRE_BROADCAST',
           false
         )`,
        [binderAttemptId, withdrawalId, hotWalletId, '11'.repeat(32), '22'.repeat(32)],
      );

      await applyClient.query(
        `UPDATE phase21_manual_dispatch_permits
         SET status = 'CONSUMED'::phase21_manual_dispatch_permit_status,
             consumed_at = now(),
             consumed_attempt_id = $2::uuid
         WHERE id = $1::uuid
           AND status = 'ARMED'::phase21_manual_dispatch_permit_status`,
        [gen2PermitId, binderAttemptId],
      );

      const w = await applyClient.query<{
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
      const row = w.rows[0]!;
      await applyClient.query(
        `INSERT INTO phase21_manual_dispatch_permits (
           id, withdrawal_id, authorization_generation, public_id,
           authorized_gross_atomic, authorized_fee_atomic, authorized_net_atomic,
           authorized_recipient_friendly, authorized_recipient_raw,
           authorized_network_code, authorized_asset_symbol, authorized_jetton_master,
           authorized_attached_gram_atomic, authorized_forward_gram_atomic,
           status, created_by_admin_user_id, idempotency_key
         ) VALUES (
           $1::uuid, $2::uuid, 4, $3,
           $4::bigint, $5::bigint, $6::bigint,
           $7, $8,
           'TON_TESTNET', 'USDT', $9,
           $10::bigint, $11::bigint,
           'ARMED'::phase21_manual_dispatch_permit_status, $12::uuid, $13
         )`,
        [
          gen4PermitId,
          withdrawalId,
          row.public_id,
          row.gross,
          row.fee,
          row.net,
          RECIPIENT_FRIENDLY,
          RECIPIENT_RAW,
          PHASE21_CANARY_FROZEN_JETTON_MASTER,
          PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10),
          PHASE21_CANARY_FORWARD_TON_ATOMIC.toString(10),
          adminUserId,
          `phase21.manual_dispatch.canary:${withdrawalId}:gen:4`,
        ],
      );

      await applyClient.query('COMMIT');

      const batch = await relayPromise;
      expect(batch).toEqual({ claimed: 1, dispatched: 0, retried: 0, deadLetter: 1 });
      expect(starter.starts).toHaveLength(0);

      const event = await pool.query<{ status: string; last_error_redacted: string | null }>(
        `SELECT status::text AS status, last_error_redacted
         FROM outbox_events
         WHERE aggregate_id = $1::uuid
           AND event_type = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [withdrawalId, WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT],
      );
      expect(event.rows[0]?.status).toBe('DEAD_LETTER');
      expect(event.rows[0]?.last_error_redacted).toContain(
        'phase21_stale_manual_dispatch_superseded_by_newer_generation_authorization',
      );
    } finally {
      try {
        await applyClient.query('ROLLBACK');
      } catch {
        // already committed / rolled back
      }
      applyClient.release();
    }
  }, 60_000);
});
