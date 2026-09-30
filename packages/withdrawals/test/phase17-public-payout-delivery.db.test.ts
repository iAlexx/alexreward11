/**
 * Phase 17 Step 3 - ambiguity-safe public payout delivery engine DB tests.
 * Fake sender only (no grammY / Telegram).
 */
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FakePayoutChain,
  PublicPayoutDefiniteFailureError,
  claimAndDeliverPublicPayoutBatch,
  claimPublicPayoutPublications,
  createConfirmedPayoutPublication,
  deliverClaimedPublicPayout,
  markPublicPayoutNetworkAttemptStarted,
  persistIntendedPayoutProvenEvidence,
  recoverStalePublicPayoutSendingBatch,
  runFakePayoutPipeline,
  withWithdrawalTransaction,
  type ClaimedPublicPayoutPublication,
  type PublicPayoutTelegramSender,
  WithdrawalDomainError,
} from '../src/index.js';
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

type SendCall = {
  chatId: string;
  topicThreadId: number | null;
  text: string;
  explorerUrl: string;
};

function createBarrier(n: number): { wait: () => Promise<void>; arrive: () => void } {
  let remaining = n;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return {
    wait: () => gate,
    arrive: () => {
      remaining -= 1;
      if (remaining <= 0) release();
    },
  };
}

function createFakeSender(options?: {
  mode?: 'success' | 'definite' | 'unknown';
  onSend?: (call: SendCall) => void | Promise<void>;
}): PublicPayoutTelegramSender & { calls: SendCall[] } {
  const calls: SendCall[] = [];
  const mode = options?.mode ?? 'success';
  return {
    calls,
    async sendPublicPayout(input) {
      calls.push(input);
      if (options?.onSend) {
        await options.onSend(input);
      }
      if (mode === 'definite') {
        throw new PublicPayoutDefiniteFailureError('telegram rejected (definite)');
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
  environment: 'LOCAL' | 'STAGING' | 'PRODUCTION',
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
     VALUES ('PUBLIC_PAYOUT_LOGS_ENABLED', $1::environment_name, $2, 'phase17 delivery test')
     ON CONFLICT (flag_key, environment)
     DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [environment, enabled],
  );
}

async function seedDestination(
  pool: Pool,
  environment: 'LOCAL' | 'STAGING' | 'PRODUCTION',
  enabled = true,
): Promise<string> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO telegram_destinations (environment, purpose, chat_id, title, enabled)
     VALUES ($1::environment_name, 'PUBLIC_PAYOUT_LOGS', $2::bigint, 'phase17-delivery', $3)
     RETURNING id::text AS id`,
    [environment, String(9_400_000_000 + Math.floor(Math.random() * 1_000_000)), enabled],
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
      evidenceSummary: { phase17: 'delivery-test-proven' },
    });
  });
  return { withdrawalId, attemptId };
}

async function insertConfirmedChainTx(
  pool: Pool,
  input: {
    withdrawalId: string;
    attemptId: string;
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
      row.net_amount_atomic,
    ],
  );
}

async function seedPendingPublication(
  pool: Pool,
  ctx: {
    userId: string;
    networkId: string;
    assetId: string;
    adminUserId: string;
    hotWalletId: string;
  },
): Promise<{ publicationId: string; withdrawalId: string; attemptId: string }> {
  const { withdrawalId, attemptId } = await confirmWithdrawal(pool, ctx);
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
  return { publicationId: created.publicationId!, withdrawalId, attemptId };
}

async function readPublication(
  pool: Pool,
  publicationId: string,
): Promise<{
  status: string;
  attempts: number;
  send_request_started_at: Date | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  telegram_message_id: string | null;
  message_text_snapshot: string | null;
  explorer_url_snapshot: string | null;
  next_attempt_at: Date;
}> {
  const r = await pool.query<{
    status: string;
    attempts: number;
    send_request_started_at: Date | null;
    lease_token: string | null;
    lease_expires_at: Date | null;
    telegram_message_id: string | null;
    message_text_snapshot: string | null;
    explorer_url_snapshot: string | null;
    next_attempt_at: Date;
  }>(
    `SELECT status::text AS status,
            attempts,
            send_request_started_at,
            lease_token::text AS lease_token,
            lease_expires_at,
            telegram_message_id::text AS telegram_message_id,
            message_text_snapshot,
            explorer_url_snapshot,
            next_attempt_at
     FROM payout_publications
     WHERE id = $1::uuid`,
    [publicationId],
  );
  return r.rows[0]!;
}

describe.skipIf(phase7DatabaseUrl === '')('Phase17 public payout delivery', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let seq = 17_800;

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
    await seedDestination(pool, 'LOCAL', true);
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

  async function userCtx() {
    const userId = await nextUser('delivery_user');
    return { userId, networkId, assetId, adminUserId, hotWalletId };
  }

  it('one claimant: claim keeps attempts 0; marker -> 1; success => PUBLISHED', async () => {
    const seeded = await seedPendingPublication(pool, await userCtx());
    const before = await readPublication(pool, seeded.publicationId);
    expect(before.status).toBe('PENDING');
    expect(before.attempts).toBe(0);

    const sender = createFakeSender({ mode: 'success' });
    const batch = await claimAndDeliverPublicPayoutBatch(pool, {
      owner: 'worker-a',
      sender,
      environment: 'LOCAL',
      limit: 5,
      leaseSeconds: 30,
    });
    expect(batch.claimed).toBe(1);
    expect(batch.delivered).toEqual([
      { publicationId: seeded.publicationId, outcome: 'PUBLISHED' },
    ]);
    expect(sender.calls).toHaveLength(1);
    expect(sender.calls[0]?.text).toContain('Withdrawal Confirmed');
    expect(sender.calls[0]?.explorerUrl).toMatch(/^https:\/\//);

    const after = await readPublication(pool, seeded.publicationId);
    expect(after.status).toBe('PUBLISHED');
    expect(after.attempts).toBe(1);
    expect(after.telegram_message_id).toBeTruthy();
    expect(after.message_text_snapshot).toBeTruthy();
    expect(after.explorer_url_snapshot).toBeTruthy();
    expect(after.lease_token).toBeNull();
  });

  it('claim alone keeps attempts at 0; marker increments; marker replay stays 1; stale lease rejected', async () => {
    const seeded = await seedPendingPublication(pool, await userCtx());
    const claimed = await withWithdrawalTransaction(pool, async (client) =>
      claimPublicPayoutPublications(client, {
        owner: 'worker-a',
        environment: 'LOCAL',
        limit: 1,
        leaseSeconds: 60,
      }),
    );
    expect(claimed).toHaveLength(1);
    const row = claimed[0]!;
    expect(row.publicationId).toBe(seeded.publicationId);
    expect((await readPublication(pool, row.publicationId)).attempts).toBe(0);
    expect((await readPublication(pool, row.publicationId)).status).toBe('SENDING');
    expect((await readPublication(pool, row.publicationId)).message_text_snapshot).toBeTruthy();

    const first = await withWithdrawalTransaction(pool, async (client) =>
      markPublicPayoutNetworkAttemptStarted(client, {
        publicationId: row.publicationId,
        leaseToken: row.leaseToken,
      }),
    );
    expect(first.attempts).toBe(1);

    const replay = await withWithdrawalTransaction(pool, async (client) =>
      markPublicPayoutNetworkAttemptStarted(client, {
        publicationId: row.publicationId,
        leaseToken: row.leaseToken,
      }),
    );
    expect(replay.attempts).toBe(1);
    expect((await readPublication(pool, row.publicationId)).attempts).toBe(1);

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        markPublicPayoutNetworkAttemptStarted(client, {
          publicationId: row.publicationId,
          leaseToken: randomUUID(),
        }),
      ),
    ).rejects.toBeInstanceOf(WithdrawalDomainError);

    await pool.query(
      `UPDATE payout_publications
       SET lease_expires_at = now() - interval '2 seconds'
       WHERE id = $1::uuid`,
      [row.publicationId],
    );
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        markPublicPayoutNetworkAttemptStarted(client, {
          publicationId: row.publicationId,
          leaseToken: row.leaseToken,
        }),
      ),
    ).rejects.toMatchObject({ details: { code: 'LEASE_EXPIRED' } });
  });

  it('two concurrent claimants (two PoolClients) — exactly one send', async () => {
    const seeded = await seedPendingPublication(pool, await userCtx());
    const sender = createFakeSender({ mode: 'success' });
    const barrier = createBarrier(2);

    const runClaimant = async (owner: string) => {
      const client: PoolClient = await pool.connect();
      try {
        barrier.arrive();
        await barrier.wait();
        await client.query('BEGIN');
        const claimed = await claimPublicPayoutPublications(client, {
          owner,
          environment: 'LOCAL',
          limit: 1,
          leaseSeconds: 60,
        });
        await client.query('COMMIT');
        if (claimed.length === 0) {
          return { owner, claimed: [] as ClaimedPublicPayoutPublication[], delivered: null };
        }
        const delivered = await deliverClaimedPublicPayout(pool, sender, claimed[0]!);
        return { owner, claimed, delivered };
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        throw error;
      } finally {
        client.release();
      }
    };

    const [a, b] = await Promise.all([runClaimant('worker-a'), runClaimant('worker-b')]);
    const winners = [a, b].filter((r) => r.claimed.length === 1);
    const losers = [a, b].filter((r) => r.claimed.length === 0);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(sender.calls).toHaveLength(1);
    expect(winners[0]?.delivered?.outcome).toBe('PUBLISHED');
    expect((await readPublication(pool, seeded.publicationId)).status).toBe('PUBLISHED');
  });

  it('definite reject => FAILED; unknown => AMBIGUOUS; terminals never reclaimed', async () => {
    const definiteSeed = await seedPendingPublication(pool, await userCtx());
    const definiteSender = createFakeSender({ mode: 'definite' });
    const definiteBatch = await claimAndDeliverPublicPayoutBatch(pool, {
      owner: 'worker-fail',
      sender: definiteSender,
      environment: 'LOCAL',
      limit: 1,
      leaseSeconds: 30,
    });
    expect(definiteBatch.delivered[0]?.outcome).toBe('FAILED');
    const failedRow = await readPublication(pool, definiteSeed.publicationId);
    expect(failedRow.status).toBe('FAILED');
    expect(failedRow.attempts).toBe(1);
    expect(failedRow.message_text_snapshot).toBeNull();
    expect(failedRow.send_request_started_at).toBeNull();

    const unknownSeed = await seedPendingPublication(pool, await userCtx());
    const unknownSender = createFakeSender({ mode: 'unknown' });
    const unknownBatch = await claimAndDeliverPublicPayoutBatch(pool, {
      owner: 'worker-amb',
      sender: unknownSender,
      environment: 'LOCAL',
      limit: 1,
      leaseSeconds: 30,
    });
    expect(unknownBatch.delivered[0]?.outcome).toBe('AMBIGUOUS');
    expect((await readPublication(pool, unknownSeed.publicationId)).status).toBe('AMBIGUOUS');

    const publishedSeed = await seedPendingPublication(pool, await userCtx());
    await claimAndDeliverPublicPayoutBatch(pool, {
      owner: 'worker-pub',
      sender: createFakeSender({ mode: 'success' }),
      environment: 'LOCAL',
      limit: 1,
      leaseSeconds: 30,
    });
    expect((await readPublication(pool, publishedSeed.publicationId)).status).toBe('PUBLISHED');

    await pool.query(
      `UPDATE payout_publications
       SET next_attempt_at = now() - interval '1 hour'
       WHERE id = ANY($1::uuid[])`,
      [[unknownSeed.publicationId, publishedSeed.publicationId]],
    );

    const reclaim = await withWithdrawalTransaction(pool, async (client) =>
      claimPublicPayoutPublications(client, {
        owner: 'worker-reclaim',
        environment: 'LOCAL',
        limit: 10,
        leaseSeconds: 30,
      }),
    );
    const reclaimedIds = new Set(reclaim.map((r) => r.publicationId));
    expect(reclaimedIds.has(unknownSeed.publicationId)).toBe(false);
    expect(reclaimedIds.has(publishedSeed.publicationId)).toBe(false);
  });

  it('crash before marker: expire lease, recover => FAILED', async () => {
    const seeded = await seedPendingPublication(pool, await userCtx());
    const claimed = await withWithdrawalTransaction(pool, async (client) =>
      claimPublicPayoutPublications(client, {
        owner: 'worker-crash-pre',
        environment: 'LOCAL',
        limit: 1,
        leaseSeconds: 60,
      }),
    );
    expect(claimed).toHaveLength(1);
    expect((await readPublication(pool, seeded.publicationId)).send_request_started_at).toBeNull();

    await pool.query(
      `UPDATE payout_publications
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [seeded.publicationId],
    );

    const recovered = await withWithdrawalTransaction(pool, async (client) =>
      recoverStalePublicPayoutSendingBatch(client, { limit: 10 }),
    );
    expect(recovered.failed).toBe(1);
    expect(recovered.ambiguous).toBe(0);
    const row = await readPublication(pool, seeded.publicationId);
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(0);
    expect(row.send_request_started_at).toBeNull();
  });

  it('crash after marker: expire, recover => AMBIGUOUS; no resend', async () => {
    const seeded = await seedPendingPublication(pool, await userCtx());
    const claimed = await withWithdrawalTransaction(pool, async (client) =>
      claimPublicPayoutPublications(client, {
        owner: 'worker-crash-post',
        environment: 'LOCAL',
        limit: 1,
        leaseSeconds: 60,
      }),
    );
    const row = claimed[0]!;
    await withWithdrawalTransaction(pool, async (client) =>
      markPublicPayoutNetworkAttemptStarted(client, {
        publicationId: row.publicationId,
        leaseToken: row.leaseToken,
      }),
    );
    expect((await readPublication(pool, seeded.publicationId)).attempts).toBe(1);

    await pool.query(
      `UPDATE payout_publications
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [seeded.publicationId],
    );

    const sender = createFakeSender({ mode: 'success' });
    const recovered = await withWithdrawalTransaction(pool, async (client) =>
      recoverStalePublicPayoutSendingBatch(client, { limit: 10 }),
    );
    expect(recovered.ambiguous).toBe(1);
    expect((await readPublication(pool, seeded.publicationId)).status).toBe('AMBIGUOUS');

    await claimAndDeliverPublicPayoutBatch(pool, {
      owner: 'worker-after-amb',
      sender,
      environment: 'LOCAL',
      limit: 10,
      leaseSeconds: 30,
      recoverStaleFirst: true,
    });
    expect(sender.calls).toHaveLength(0);
  });

  it('success-before-finalize crash => AMBIGUOUS / no resend on recover', async () => {
    const seeded = await seedPendingPublication(pool, await userCtx());
    const claimed = await withWithdrawalTransaction(pool, async (client) =>
      claimPublicPayoutPublications(client, {
        owner: 'worker-pre-final',
        environment: 'LOCAL',
        limit: 1,
        leaseSeconds: 60,
      }),
    );
    const row = claimed[0]!;
    await withWithdrawalTransaction(pool, async (client) =>
      markPublicPayoutNetworkAttemptStarted(client, {
        publicationId: row.publicationId,
        leaseToken: row.leaseToken,
      }),
    );
    const ghostSender = createFakeSender({ mode: 'success' });
    await ghostSender.sendPublicPayout({
      chatId: row.chatId,
      topicThreadId: row.topicThreadId,
      text: row.messageTextSnapshot,
      explorerUrl: row.explorerUrlSnapshot,
    });
    expect(ghostSender.calls).toHaveLength(1);

    await pool.query(
      `UPDATE payout_publications
       SET lease_expires_at = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [seeded.publicationId],
    );
    await withWithdrawalTransaction(pool, async (client) =>
      recoverStalePublicPayoutSendingBatch(client, { limit: 5 }),
    );
    expect((await readPublication(pool, seeded.publicationId)).status).toBe('AMBIGUOUS');

    const retrySender = createFakeSender({ mode: 'success' });
    await claimAndDeliverPublicPayoutBatch(pool, {
      owner: 'worker-no-resend',
      sender: retrySender,
      environment: 'LOCAL',
      limit: 5,
      leaseSeconds: 30,
    });
    expect(retrySender.calls).toHaveLength(0);
  });

  it('FAILED retry increments next real attempt only', async () => {
    const seeded = await seedPendingPublication(pool, await userCtx());
    await claimAndDeliverPublicPayoutBatch(pool, {
      owner: 'worker-r1',
      sender: createFakeSender({ mode: 'definite' }),
      environment: 'LOCAL',
      limit: 1,
      leaseSeconds: 30,
    });
    expect((await readPublication(pool, seeded.publicationId)).attempts).toBe(1);
    expect((await readPublication(pool, seeded.publicationId)).status).toBe('FAILED');

    await pool.query(
      `UPDATE payout_publications SET next_attempt_at = now() - interval '1 second'
       WHERE id = $1::uuid`,
      [seeded.publicationId],
    );

    const claimedOnly = await withWithdrawalTransaction(pool, async (client) =>
      claimPublicPayoutPublications(client, {
        owner: 'worker-r2-claim',
        environment: 'LOCAL',
        limit: 1,
        leaseSeconds: 30,
      }),
    );
    expect(claimedOnly).toHaveLength(1);
    expect((await readPublication(pool, seeded.publicationId)).attempts).toBe(1);

    await deliverClaimedPublicPayout(
      pool,
      createFakeSender({ mode: 'definite' }),
      claimedOnly[0]!,
    );
    expect((await readPublication(pool, seeded.publicationId)).attempts).toBe(2);
    expect((await readPublication(pool, seeded.publicationId)).status).toBe('FAILED');
  });

  it('retry fairness: >batch FAILED rows with one later eligible gets reached', async () => {
    const earlyIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const seeded = await seedPendingPublication(pool, await userCtx());
      earlyIds.push(seeded.publicationId);
      await claimAndDeliverPublicPayoutBatch(pool, {
        owner: `worker-early-${i}`,
        sender: createFakeSender({ mode: 'definite' }),
        environment: 'LOCAL',
        limit: 1,
        leaseSeconds: 30,
      });
    }
    const later = await seedPendingPublication(pool, await userCtx());

    await pool.query(
      `UPDATE payout_publications
       SET next_attempt_at = now() - interval '10 minutes'
       WHERE id = ANY($1::uuid[])`,
      [earlyIds],
    );
    await pool.query(
      `UPDATE payout_publications
       SET next_attempt_at = now() - interval '1 minute'
       WHERE id = $1::uuid`,
      [later.publicationId],
    );

    const limit = 3;
    const seen = new Set<string>();
    for (let round = 0; round < 4; round += 1) {
      const claimed = await withWithdrawalTransaction(pool, async (client) =>
        claimPublicPayoutPublications(client, {
          owner: `fair-${round}`,
          environment: 'LOCAL',
          limit,
          leaseSeconds: 30,
        }),
      );
      for (const c of claimed) {
        seen.add(c.publicationId);
        await pool.query(
          `UPDATE payout_publications
           SET status = 'FAILED',
               next_attempt_at = now() + interval '1 hour',
               last_error_redacted = 'fairness-park'
           WHERE id = $1::uuid
             AND status = 'SENDING'`,
          [c.publicationId],
        );
      }
      if (seen.has(later.publicationId)) break;
    }
    expect(seen.has(later.publicationId)).toBe(true);
  });
});
