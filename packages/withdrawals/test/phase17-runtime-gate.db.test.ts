/**
 * Phase 17 Mega Step 5 — consolidating runtime gate (acceptance matrix).
 * Reuses seed patterns from other phase17 tests (copied, not imported).
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FakePayoutChain,
  claimAndDeliverPublicPayoutBatch,
  createConfirmedPayoutPublication,
  persistIntendedPayoutProvenEvidence,
  processWithdrawalConfirmedPublicPayoutOutboxBatch,
  runFakePayoutPipeline,
  withWithdrawalTransaction,
} from '../src/index.js';
import { formatAtomicAmount } from '../src/public-payout-format.js';
import { renderPublicPayoutMessage } from '../src/public-payout-render.js';
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

type FeatureEnvironment = 'LOCAL' | 'STAGING' | 'PRODUCTION';

type SendCall = {
  chatId: string;
  topicThreadId: number | null;
  text: string;
  explorerUrl: string;
};

function createFakeSender(options?: {
  mode?: 'success' | 'definite' | 'unknown';
}): { calls: SendCall[]; sendPublicPayout: (input: SendCall) => Promise<{ telegramMessageId: string }> } {
  const calls: SendCall[] = [];
  const mode = options?.mode ?? 'success';
  return {
    calls,
    async sendPublicPayout(input) {
      calls.push(input);
      if (mode === 'definite') {
        throw Object.assign(new Error('telegram rejected (definite)'), {
          classification: 'DEFINITE_FAILURE',
        });
      }
      if (mode === 'unknown') {
        throw new Error('socket hang up / unknown after write');
      }
      return { telegramMessageId: String(1000 + calls.length) };
    },
  };
}

async function setFeatureFlag(
  pool: Pool,
  environment: FeatureEnvironment,
  enabled: boolean | null,
): Promise<void> {
  if (enabled === null) {
    await pool.query(
      `DELETE FROM feature_flags
       WHERE flag_key = 'PUBLIC_PAYOUT_LOGS_ENABLED'
         AND environment = $1::environment_name`,
      [environment],
    );
    return;
  }
  await pool.query(
    `INSERT INTO feature_flags (flag_key, environment, enabled, description)
     VALUES ('PUBLIC_PAYOUT_LOGS_ENABLED', $1::environment_name, $2, 'phase17 runtime gate')
     ON CONFLICT (flag_key, environment)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [environment, enabled],
  );
}

async function seedDestination(
  pool: Pool,
  environment: FeatureEnvironment = 'LOCAL',
  enabled = true,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO telegram_destinations (environment, purpose, chat_id, title, enabled)
     VALUES ($1::environment_name, 'PUBLIC_PAYOUT_LOGS', $2::bigint, 'phase17-gate', $3)
     RETURNING id::text AS id`,
    [environment, String(9_500_000_000 + Math.floor(Math.random() * 1_000_000)), enabled],
  );
  return inserted.rows[0]!.id;
}

async function confirmWithdrawal(
  pool: Pool,
  input: {
    userId: string;
    networkId: string;
    assetId: string;
    adminUserId: string;
    hotWalletId: string;
    amountAtomic?: string;
    withProven?: boolean;
  },
): Promise<{ withdrawalId: string; attemptId: string }> {
  const withdrawalId = await createApprovedWithdrawal(pool, {
    userId: input.userId,
    networkId: input.networkId,
    assetId: input.assetId,
    adminUserId: input.adminUserId,
    hotWalletId: input.hotWalletId,
    amountAtomic: input.amountAtomic ?? '200000',
  });
  const fakeChain = new FakePayoutChain(engineConfig);
  const result = await runFakePayoutPipeline(pool, engineConfig, fakeChain, {
    withdrawalId,
    scenario: 'CONFIRMED_SUCCESS',
  });
  expect(result.state).toBe('CONFIRMED');
  expect(result.attemptId).toBeTruthy();
  const attemptId = result.attemptId!;
  if (input.withProven !== false) {
    const meta = await pool.query<{
      net_amount_atomic: string;
      raw_address: string;
      query_id: string;
    }>(
      `SELECT w.net_amount_atomic::text AS net_amount_atomic,
              uw.raw_address,
              a.query_id::text AS query_id
       FROM withdrawals w
       JOIN user_wallets uw ON uw.id = w.wallet_id
       JOIN withdrawal_attempts a ON a.id = $2::uuid
       WHERE w.id = $1::uuid`,
      [withdrawalId, attemptId],
    );
    const m = meta.rows[0]!;
    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId,
        observedRecipient: m.raw_address,
        observedAmountAtomic: m.net_amount_atomic,
        observedQueryId: m.query_id,
        evidenceSummary: { phase17: 'runtime-gate-proven' },
      });
    });
  }
  return { withdrawalId, attemptId };
}

async function insertConfirmedChainTx(
  pool: Pool,
  input: {
    withdrawalId: string;
    attemptId: string;
    amountAtomic?: string;
    chainTxReference?: string;
  },
): Promise<void> {
  const w = await pool.query<{
    network_id: string;
    asset_id: string;
    net_amount_atomic: string;
    hot_wallet_id: string;
    wallet_id: string;
  }>(
    `SELECT network_id::text, asset_id::text, net_amount_atomic::text,
            hot_wallet_id::text, wallet_id::text
     FROM withdrawals WHERE id = $1::uuid`,
    [input.withdrawalId],
  );
  const row = w.rows[0]!;
  const wallet = await pool.query<{ raw_address: string }>(
    `SELECT raw_address FROM user_wallets WHERE id = $1::uuid`,
    [row.wallet_id],
  );
  await pool.query(
    `INSERT INTO blockchain_transactions (
       network_id, hot_wallet_id, withdrawal_attempt_id, recipient_wallet_id,
       asset_id, chain_tx_reference, recipient_address, amount_atomic, state, confirmed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, $6, $7, $8::bigint, 'CONFIRMED', now()
     )`,
    [
      row.network_id,
      row.hot_wallet_id,
      input.attemptId,
      row.wallet_id,
      row.asset_id,
      input.chainTxReference ?? `tx-${randomUUID()}`,
      wallet.rows[0]!.raw_address,
      input.amountAtomic ?? row.net_amount_atomic,
    ],
  );
}

async function countPublications(pool: Pool, withdrawalId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM payout_publications WHERE withdrawal_id = $1::uuid`,
    [withdrawalId],
  );
  return Number(r.rows[0]?.c ?? '0');
}

async function readWithdrawalFinancials(
  pool: Pool,
  withdrawalId: string,
): Promise<{
  state: string;
  requested_amount_atomic: string;
  net_amount_atomic: string;
  fee_amount_atomic: string;
  settlement_ledger_tx_id: string | null;
}> {
  const r = await pool.query<{
    state: string;
    requested_amount_atomic: string;
    net_amount_atomic: string;
    fee_amount_atomic: string;
    settlement_ledger_tx_id: string | null;
  }>(
    `SELECT state::text AS state,
            requested_amount_atomic::text AS requested_amount_atomic,
            net_amount_atomic::text AS net_amount_atomic,
            fee_amount_atomic::text AS fee_amount_atomic,
            settlement_ledger_tx_id::text AS settlement_ledger_tx_id
     FROM withdrawals WHERE id = $1::uuid`,
    [withdrawalId],
  );
  return r.rows[0]!;
}

describe.skipIf(phase7DatabaseUrl === '')('Phase17 runtime gate', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let destinationId: string;
  let seq = 17_900;

  beforeAll(async () => {
    await resetAndMigrate(phase7DatabaseUrl);
    pool = new Pool({ connectionString: phase7DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await truncateWithdrawalTables(pool);
    await pool.query(
      `TRUNCATE TABLE payout_publications, telegram_destinations RESTART IDENTITY CASCADE`,
    );
    const base = await seedPhase7Base(pool);
    assetId = base.assetId;
    networkId = base.networkId;
    adminUserId = base.adminUserId;
    hotWalletId = base.hotWalletId;
    await pool.query(
      `UPDATE networks
       SET public_explorer_base_url = 'https://testnet.tonviewer.com/'
       WHERE code = 'TON_TESTNET'`,
    );
    await setFeatureFlag(pool, 'LOCAL', true);
    await setFeatureFlag(pool, 'PRODUCTION', false);
    await setFeatureFlag(pool, 'STAGING', false);
    destinationId = await seedDestination(pool, 'LOCAL', true);
  });

  async function nextUser(username?: string | null): Promise<string> {
    seq += 1;
    const userId = await createTestUser(pool, String(seq));
    if (username !== undefined) {
      await pool.query(`UPDATE users SET username = $2 WHERE id = $1::uuid`, [userId, username]);
    }
    await bindVerifiedPrimaryWallet(pool, userId, networkId);
    return userId;
  }

  it('1 CONFIRMED-only: REQUESTED/APPROVED/BROADCASTED/CONFIRMING cannot create publication', async () => {
    const userId = await nextUser();
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const attemptId = randomUUID();

    for (const state of ['REQUESTED', 'APPROVED', 'BROADCASTED', 'CONFIRMING'] as const) {
      await pool.query(`UPDATE withdrawals SET state = $2::withdrawal_state WHERE id = $1::uuid`, [
        withdrawalId,
        state,
      ]);
      await expect(
        withWithdrawalTransaction(pool, async (client) =>
          createConfirmedPayoutPublication(client, {
            withdrawalId,
            confirmedAttemptId: attemptId,
            environment: 'LOCAL',
          }),
        ),
      ).rejects.toMatchObject({
        code: 'STATE_CONFLICT',
        details: expect.objectContaining({ state }),
      });
      expect(await countPublications(pool, withdrawalId)).toBe(0);
    }
  });

  it('2 CONFIRMED before settlement: no publication', async () => {
    const userId = await nextUser();
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
       SET state = 'CONFIRMED'::withdrawal_state,
           confirmed_at = now(),
           settlement_ledger_tx_id = NULL,
           updated_at = now()
       WHERE id = $1::uuid`,
      [withdrawalId],
    );
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: randomUUID(),
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(await countPublications(pool, withdrawalId)).toBe(0);
  });

  it('3 settled without INTENDED_PAYOUT_PROVEN / without chain: blocked', async () => {
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      withProven: false,
    });

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: attemptId,
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    // Add proven but still no chain tx
    const meta = await pool.query<{
      net_amount_atomic: string;
      raw_address: string;
      query_id: string;
    }>(
      `SELECT w.net_amount_atomic::text AS net_amount_atomic,
              uw.raw_address,
              a.query_id::text AS query_id
       FROM withdrawals w
       JOIN user_wallets uw ON uw.id = w.wallet_id
       JOIN withdrawal_attempts a ON a.id = $2::uuid
       WHERE w.id = $1::uuid`,
      [withdrawalId, attemptId],
    );
    const m = meta.rows[0]!;
    await withWithdrawalTransaction(pool, async (client) => {
      await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId,
        attemptId,
        observedRecipient: m.raw_address,
        observedAmountAtomic: m.net_amount_atomic,
        observedQueryId: m.query_id,
        evidenceSummary: { phase17: 'gate-no-chain' },
      });
    });
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: attemptId,
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      details: expect.objectContaining({ code: 'CHAIN_TX_MISSING' }),
    });
    expect(await countPublications(pool, withdrawalId)).toBe(0);
  });

  it('4 valid proof: publication created', async () => {
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    const created = await withWithdrawalTransaction(pool, async (client) =>
      createConfirmedPayoutPublication(client, {
        withdrawalId,
        confirmedAttemptId: attemptId,
        environment: 'LOCAL',
      }),
    );
    expect(created.outcome).toBe('CREATED');
    expect(created.publicationId).toBeTruthy();
    expect(await countPublications(pool, withdrawalId)).toBe(1);
  });

  it('5 renderPublicPayoutMessage content gates (no UUID / wallet / telegram id / Founder)', () => {
    const withdrawalId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const telegramNumericId = '9123456789';
    const walletAddress = '0:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const publicId = 'WD-000042';
    const amountFormatted = '1.900000';
    const networkLabel = 'TON Testnet';
    const confirmedDateUtc = '2026-09-30';

    const message = renderPublicPayoutMessage({
      identityMode: 'HIDE_IDENTITY',
      usernameSnapshot: null,
      amountFormatted,
      assetSymbol: 'USDT',
      networkLabel,
      publicId,
      confirmedDateUtc,
    });

    expect(message).toContain('Withdrawal Confirmed');
    expect(message).toContain(amountFormatted);
    expect(message).toContain(networkLabel);
    expect(message).toContain(publicId);
    expect(message).toContain(confirmedDateUtc);
    expect(message).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    expect(message).not.toContain(withdrawalId);
    expect(message).not.toContain('0:');
    expect(message).not.toContain(walletAddress);
    expect(message).not.toContain(telegramNumericId);
    expect(message).not.toMatch(/Founder/i);
  });

  it('6 formatAtomicAmount: 0/6/9 decimals + large bigint', () => {
    expect(formatAtomicAmount('1000000', 0)).toBe('1000000');
    expect(formatAtomicAmount('0', 0)).toBe('0');
    expect(formatAtomicAmount('1900000', 6)).toBe('1.900000');
    expect(formatAtomicAmount('1', 6)).toBe('0.000001');
    expect(formatAtomicAmount('123456789', 9)).toBe('0.123456789');
    expect(formatAtomicAmount('1000000000', 9)).toBe('1.000000000');
    expect(formatAtomicAmount('9007199254740993', 0)).toBe('9007199254740993');
    expect(formatAtomicAmount('123456789012345678901234567890', 6)).toBe(
      '123456789012345678901234.567890',
    );
  });

  it('7 historical CONFIRMED without withdrawal.confirmed outbox => 0 publications', async () => {
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    // Remove the settlement-authored outbox so only historical confirmed remains.
    await pool.query(
      `DELETE FROM outbox_events
       WHERE event_type = 'withdrawal.confirmed' AND aggregate_id = $1::uuid`,
      [withdrawalId],
    );
    const remaining = await pool.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM outbox_events
       WHERE event_type = 'withdrawal.confirmed' AND aggregate_id = $1::uuid`,
      [withdrawalId],
    );
    expect(Number(remaining.rows[0]?.c ?? '0')).toBe(0);

    const batch = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(batch.claimed).toBe(0);
    expect(await countPublications(pool, withdrawalId)).toBe(0);
  });

  it('8 AMBIGUOUS: 100 claimAndDeliver cycles => 0 additional sends', async () => {
    const userId = await nextUser();
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const pub = await pool.query<{ id: string }>(
      `INSERT INTO payout_publications (
         withdrawal_id, destination_id, identity_mode, status, username_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, 'HIDE_IDENTITY', 'PENDING', NULL
       ) RETURNING id::text AS id`,
      [withdrawalId, destinationId],
    );
    const publicationId = pub.rows[0]!.id;
    const leaseToken = randomUUID();
    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           lease_owner = 'gate-ambiguous',
           lease_token = $2::uuid,
           lease_expires_at = now() + interval '1 minute',
           message_text_snapshot = 'dummy-message',
           explorer_url_snapshot = 'https://testnet.tonviewer.com/tx/dummy',
           send_request_started_at = now()
       WHERE id = $1::uuid`,
      [publicationId, leaseToken],
    );
    await pool.query(
      `UPDATE payout_publications
       SET status = 'AMBIGUOUS', ambiguous_at = now()
       WHERE id = $1::uuid`,
      [publicationId],
    );
    const status = await pool.query<{ status: string }>(
      `SELECT status::text AS status FROM payout_publications WHERE id = $1::uuid`,
      [publicationId],
    );
    expect(status.rows[0]?.status).toBe('AMBIGUOUS');

    const sender = createFakeSender({ mode: 'success' });
    for (let i = 0; i < 100; i += 1) {
      const batch = await claimAndDeliverPublicPayoutBatch(pool, {
        owner: `gate-ambig-${i}`,
        sender,
        environment: 'LOCAL',
        limit: 10,
        leaseSeconds: 30,
      });
      expect(batch.claimed).toBe(0);
      expect(batch.delivered).toHaveLength(0);
    }
    expect(sender.calls).toHaveLength(0);
  }, 120_000);

  it('9 feature flag reads DB not env', async () => {
    const prev = process.env.PUBLIC_PAYOUT_LOGS_ENABLED;

    try {
      process.env.PUBLIC_PAYOUT_LOGS_ENABLED = 'true';
      await setFeatureFlag(pool, 'LOCAL', false);
      const userA = await nextUser();
      const a = await confirmWithdrawal(pool, {
        userId: userA,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
      });
      await insertConfirmedChainTx(pool, {
        withdrawalId: a.withdrawalId,
        attemptId: a.attemptId,
      });
      const blocked = await withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId: a.withdrawalId,
          confirmedAttemptId: a.attemptId,
          environment: 'LOCAL',
        }),
      );
      expect(blocked.outcome).toBe('FEATURE_DISABLED');
      expect(await countPublications(pool, a.withdrawalId)).toBe(0);

      process.env.PUBLIC_PAYOUT_LOGS_ENABLED = 'false';
      await setFeatureFlag(pool, 'LOCAL', true);
      const userB = await nextUser();
      const b = await confirmWithdrawal(pool, {
        userId: userB,
        networkId,
        assetId,
        adminUserId,
        hotWalletId,
      });
      await insertConfirmedChainTx(pool, {
        withdrawalId: b.withdrawalId,
        attemptId: b.attemptId,
      });
      const created = await withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId: b.withdrawalId,
          confirmedAttemptId: b.attemptId,
          environment: 'LOCAL',
        }),
      );
      expect(created.outcome).toBe('CREATED');
      expect(await countPublications(pool, b.withdrawalId)).toBe(1);
    } finally {
      if (prev === undefined) {
        delete process.env.PUBLIC_PAYOUT_LOGS_ENABLED;
      } else {
        process.env.PUBLIC_PAYOUT_LOGS_ENABLED = prev;
      }
    }
  });

  it('10 financial non-mutation after publication creation', async () => {
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });
    const before = await readWithdrawalFinancials(pool, withdrawalId);

    const created = await withWithdrawalTransaction(pool, async (client) =>
      createConfirmedPayoutPublication(client, {
        withdrawalId,
        confirmedAttemptId: attemptId,
        environment: 'LOCAL',
      }),
    );
    expect(created.outcome).toBe('CREATED');

    const after = await readWithdrawalFinancials(pool, withdrawalId);
    expect(after).toEqual(before);
    expect(after.state).toBe('CONFIRMED');
    expect(after.settlement_ledger_tx_id).not.toBeNull();
  });

  it('11 fake-chain-only confirmation without INTENDED_PAYOUT_PROVEN blocked', async () => {
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      withProven: false,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: attemptId,
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
    expect(await countPublications(pool, withdrawalId)).toBe(0);
  });

  it('12 identity timestamp authority: DB now() on PENDING->SENDING; rewrite after SENDING rejected', async () => {
    const userId = await nextUser();
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });
    const pub = await pool.query<{ id: string }>(
      `INSERT INTO payout_publications (
         withdrawal_id, destination_id, identity_mode, status, username_snapshot
       ) VALUES (
         $1::uuid, $2::uuid, 'SHOW_USERNAME', 'PENDING', 'GateUser'
       ) RETURNING id::text AS id`,
      [withdrawalId, destinationId],
    );
    const publicationId = pub.rows[0]!.id;

    const arbitraryPast = new Date('2020-01-01T00:00:00.000Z');
    const beforeMs = Date.now();
    await pool.query(
      `UPDATE payout_publications
       SET status = 'SENDING',
           sending_started_at = $2::timestamptz,
           identity_frozen_at = $2::timestamptz,
           lease_owner = 'gate-clock',
           lease_token = $3::uuid,
           lease_expires_at = now() + interval '1 minute',
           message_text_snapshot = 'dummy-message',
           explorer_url_snapshot = 'https://testnet.tonviewer.com/tx/dummy',
           send_request_started_at = now()
       WHERE id = $1::uuid`,
      [publicationId, arbitraryPast.toISOString(), randomUUID()],
    );
    const afterMs = Date.now();
    const clocks = await pool.query<{
      sending_started_at: Date;
      identity_frozen_at: Date;
      status: string;
    }>(
      `SELECT sending_started_at, identity_frozen_at, status::text AS status
       FROM payout_publications WHERE id = $1::uuid`,
      [publicationId],
    );
    expect(clocks.rows[0]?.status).toBe('SENDING');
    const startedAt = clocks.rows[0]!.sending_started_at.getTime();
    expect(startedAt).toBeGreaterThanOrEqual(beforeMs - 2_000);
    expect(startedAt).toBeLessThanOrEqual(afterMs + 2_000);
    expect(startedAt).not.toBe(arbitraryPast.getTime());
    expect(clocks.rows[0]!.identity_frozen_at.getTime()).not.toBe(arbitraryPast.getTime());

    await expect(
      pool.query(
        `UPDATE payout_publications
         SET sending_started_at = $2::timestamptz
         WHERE id = $1::uuid`,
        [publicationId, arbitraryPast.toISOString()],
      ),
    ).rejects.toThrow(/frozen|immutable|delivery snapshot/i);
  });
});
