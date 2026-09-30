/**
 * Phase 17 Step 1 — withdrawal.confirmed Outbox after settlement authority.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FakePayoutChain,
  advanceFakeReconciliation,
  persistIntendedPayoutProvenEvidence,
  runFakePayoutPipeline,
  settleWithdrawalReservation,
  WITHDRAWAL_CONFIRMED_OUTBOX_EVENT,
  withWithdrawalTransaction,
  withdrawalConfirmedDedupeKey,
} from '../src/index.js';
import { ensureWithdrawalConfirmedOutbox } from '../src/public-payout-outbox.js';
import {
  bindVerifiedPrimaryWallet,
  createApprovedWithdrawal,
  createTestUser,
  engineConfig,
  phase7DatabaseUrl,
  resetAndMigrate,
  seedPhase7Base,
  truncateWithdrawalTables,
} from './harness.js';

async function countConfirmedOutbox(pool: Pool, withdrawalId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM outbox_events
     WHERE event_type = $1 AND dedupe_key = $2`,
    [WITHDRAWAL_CONFIRMED_OUTBOX_EVENT, withdrawalConfirmedDedupeKey(withdrawalId)],
  );
  return Number(r.rows[0]?.c ?? '0');
}

async function outboxPayload(
  pool: Pool,
  withdrawalId: string,
): Promise<{ withdrawalId?: string; confirmedAttemptId?: string } | null> {
  const r = await pool.query<{ payload: { withdrawalId?: string; confirmedAttemptId?: string } }>(
    `SELECT payload FROM outbox_events WHERE dedupe_key = $1`,
    [withdrawalConfirmedDedupeKey(withdrawalId)],
  );
  return r.rows[0]?.payload ?? null;
}

describe.skipIf(phase7DatabaseUrl === '')('Phase17 withdrawal.confirmed Outbox', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let seq = 17_500;

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
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
  });

  async function approved(): Promise<string> {
    seq += 1;
    const userId = await createTestUser(pool, String(seq));
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    return createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
  }

  it('fake confirmation: CONFIRMED + settlement + Outbox same TX; replay is idempotent', async () => {
    const withdrawalId = await approved();
    const fakeChain = new FakePayoutChain(engineConfig);
    const result = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'CONFIRMED_SUCCESS',
    });
    expect(result.state).toBe('CONFIRMED');
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
    const payload = await outboxPayload(pool, withdrawalId);
    expect(payload?.withdrawalId).toBe(withdrawalId);
    expect(payload?.confirmedAttemptId).toBe(result.attemptId);

    await withWithdrawalTransaction(pool, async (client) => {
      const again = await settleWithdrawalReservation(client, { withdrawalId });
      expect(again.settled).toBe(false);
      expect(again.confirmedAttemptId).toBe(result.attemptId);
    });
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
  });

  it('reconcile INTENDED_PAYOUT_PROVEN: Outbox atomic; replay once', async () => {
    const withdrawalId = await approved();
    const fakeChain = new FakePayoutChain(engineConfig);
    const unknown = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION',
    });
    expect(unknown.state).toBe('RECONCILE_REQUIRED');
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(0);

    const advanced = await advanceFakeReconciliation(pool, engineConfig, fakeChain, {
      withdrawalId,
      attemptId: unknown.attemptId!,
      scenario: 'UNKNOWN_THEN_CONFIRMED_ON_RECONCILIATION',
    });
    expect(advanced.state).toBe('CONFIRMED');
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);

    await withWithdrawalTransaction(pool, async (client) => {
      await settleWithdrawalReservation(client, { withdrawalId });
    });
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
  });

  it('CONFIRMED before settlement does NOT create Outbox; resume creates exactly one', async () => {
    const withdrawalId = await approved();
    const fakeChain = new FakePayoutChain(engineConfig);
    // Drive to RECONCILE then manually confirm without settle to simulate crash window.
    await runFakePayoutPipeline(pool, engineConfig, withdrawalId, 'BROADCAST_RESULT_UNKNOWN');
    const attempt = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid LIMIT 1`,
      [withdrawalId],
    );
    const attemptId = attempt.rows[0]!.id;

    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId,
        observedRecipient: '0:recipient',
        observedAmountAtomic: '190000',
        observedQueryId: '1',
        evidenceSummary: { phase17: 'confirmed-before-settle' },
      });
      await client.query(
        `UPDATE withdrawals
         SET state = 'CONFIRMED', confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [withdrawalId],
      );
    });

    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(0);
    const settledRow = await pool.query<{ settlement_ledger_tx_id: string | null }>(
      `SELECT settlement_ledger_tx_id FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(settledRow.rows[0]?.settlement_ledger_tx_id).toBeNull();

    await withWithdrawalTransaction(pool, async (client) => {
      const settled = await settleWithdrawalReservation(client, {
        withdrawalId,
        confirmedAttemptId: attemptId,
      });
      expect(settled.settled).toBe(true);
      expect(settled.confirmedAttemptId).toBe(attemptId);
    });
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
    void fakeChain;
  });

  it('confirmedAttemptId is proven attempt, never latest-attempt guessing', async () => {
    const withdrawalId = await approved();
    const fakeChain = new FakePayoutChain(engineConfig);
    const result = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'CONFIRMED_SUCCESS',
    });
    const provenId = result.attemptId!;

    // Insert a newer attempt row with higher attempt_number (should not become Outbox identity).
    await pool.query(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, requires_state_init,
         broadcast_submitted_at, broadcast_started_at, signed_external_message_boc
       )
       SELECT withdrawal_id, attempt_number + 1, hot_wallet_id, expected_seqno + 1, query_id + 1,
              valid_until, 'phase17-newer-no-proof', signer_key_reference,
              dispatch_fencing_token, 'BROADCASTED', requires_state_init,
              now(), now(), 'bmV3ZXI='
       FROM withdrawal_attempts WHERE id = $1::uuid`,
      [provenId],
    );

    await withWithdrawalTransaction(pool, async (client) => {
      await settleWithdrawalReservation(client, { withdrawalId });
    });
    const payload = await outboxPayload(pool, withdrawalId);
    expect(payload?.confirmedAttemptId).toBe(provenId);
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
  });

  it('Outbox insert failure rolls back settlement finalization TX', async () => {
    const withdrawalId = await approved();
    await runFakePayoutPipeline(pool, engineConfig, withdrawalId, 'BROADCAST_RESULT_UNKNOWN');
    const attempt = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid LIMIT 1`,
      [withdrawalId],
    );
    const attemptId = attempt.rows[0]!.id;

    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId,
        observedRecipient: '0:recipient',
        observedAmountAtomic: '190000',
        observedQueryId: '1',
        evidenceSummary: { phase17: 'fail-outbox' },
      });
      await client.query(
        `UPDATE withdrawals
         SET state = 'CONFIRMED', confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [withdrawalId],
      );
    });

    await pool.query(`
      CREATE OR REPLACE FUNCTION phase17_fail_confirmed_outbox()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'withdrawal.confirmed'
           AND current_setting('alex.phase17_fail_outbox', true) = '1' THEN
          RAISE EXCEPTION 'injected outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS phase17_fail_confirmed_outbox ON outbox_events;
      CREATE TRIGGER phase17_fail_confirmed_outbox
        BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION phase17_fail_confirmed_outbox();
    `);

    await expect(
      withWithdrawalTransaction(pool, async (client) => {
        await client.query(`SELECT set_config('alex.phase17_fail_outbox', '1', true)`);
        await settleWithdrawalReservation(client, {
          withdrawalId,
          confirmedAttemptId: attemptId,
        });
      }),
    ).rejects.toThrow(/injected outbox failure/);

    const after = await pool.query<{
      settlement_ledger_tx_id: string | null;
      state: string;
    }>(
      `SELECT settlement_ledger_tx_id, state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [withdrawalId],
    );
    expect(after.rows[0]?.settlement_ledger_tx_id).toBeNull();
    expect(after.rows[0]?.state).toBe('CONFIRMED');
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(0);

    await pool.query(`DROP TRIGGER IF EXISTS phase17_fail_confirmed_outbox ON outbox_events`);
    await pool.query(`DROP FUNCTION IF EXISTS phase17_fail_confirmed_outbox()`);

    // Heal succeeds after injection removed
    await withWithdrawalTransaction(pool, async (client) => {
      await settleWithdrawalReservation(client, {
        withdrawalId,
        confirmedAttemptId: attemptId,
      });
    });
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
  });


  it('rejects owned-but-unsettled historical attempt for Outbox', async () => {
    const withdrawalId = await approved();
    const fakeChain = new FakePayoutChain(engineConfig);
    const result = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'CONFIRMED_SUCCESS',
    });
    const settledId = result.attemptId!;

    // Insert owned historical attempt without settled_at (not evidence-backed).
    const historical = await pool.query<{ id: string }>(
      `INSERT INTO withdrawal_attempts (
         withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
         valid_until, canonical_message_hash, signer_key_reference,
         dispatch_fencing_token, broadcast_result_state, requires_state_init,
         broadcast_submitted_at, broadcast_started_at, signed_external_message_boc
       )
       SELECT withdrawal_id, attempt_number + 1, hot_wallet_id, expected_seqno + 1, query_id + 1,
              valid_until, 'phase17-historical-no-settled', signer_key_reference,
              dispatch_fencing_token, 'BROADCASTED', requires_state_init,
              now(), now(), 'bmV3ZXI='
       FROM withdrawal_attempts WHERE id = $1::uuid
       RETURNING id::text AS id`,
      [settledId],
    );
    const historicalId = historical.rows[0]!.id;

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        ensureWithdrawalConfirmedOutbox(client, {
          withdrawalId,
          confirmedAttemptId: historicalId,
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    // Existing correct event remains the settled attempt from pipeline settle.
    const payload = await outboxPayload(pool, withdrawalId);
    expect(payload?.confirmedAttemptId).toBe(settledId);
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
  });

  it('accepts only settled_at-stamped attempt and is idempotent', async () => {
    const withdrawalId = await approved();
    const fakeChain = new FakePayoutChain(engineConfig);
    const result = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
      withdrawalId,
      scenario: 'CONFIRMED_SUCCESS',
    });
    const settledId = result.attemptId!;
    const stamp = await pool.query<{ settled_at: Date | null }>(
      `SELECT settled_at FROM withdrawal_attempts WHERE id = $1::uuid`,
      [settledId],
    );
    expect(stamp.rows[0]?.settled_at).not.toBeNull();

    await withWithdrawalTransaction(pool, async (client) => {
      const first = await ensureWithdrawalConfirmedOutbox(client, {
        withdrawalId,
        confirmedAttemptId: settledId,
      });
      expect(first.created).toBe(false);
      const second = await ensureWithdrawalConfirmedOutbox(client, {
        withdrawalId,
        confirmedAttemptId: settledId,
      });
      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);
    });
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(1);
  });


  it('ensureWithdrawalConfirmedOutbox requires settlement_ledger_tx_id', async () => {
    const withdrawalId = await approved();
    await runFakePayoutPipeline(pool, engineConfig, withdrawalId, 'BROADCAST_RESULT_UNKNOWN');
    const attemptId = (
      await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid LIMIT 1`,
        [withdrawalId],
      )
    ).rows[0]!.id;
    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId,
        observedRecipient: '0:recipient',
        observedAmountAtomic: '190000',
        observedQueryId: '1',
        evidenceSummary: { phase17: 'no-settle-yet' },
      });
      await client.query(
        `UPDATE withdrawals
         SET state = 'CONFIRMED', confirmed_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
        [withdrawalId],
      );
      await expect(
        ensureWithdrawalConfirmedOutbox(client, { withdrawalId, confirmedAttemptId: attemptId }),
      ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    });
    expect(await countConfirmedOutbox(pool, withdrawalId)).toBe(0);
    void randomUUID;
  });
});