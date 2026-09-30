/**
 * Phase 17 Step 2 — confirmed publication builder + withdrawal.confirmed outbox consumer.
 * No Telegram send.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  FakePayoutChain,
  createConfirmedPayoutPublication,
  persistIntendedPayoutProvenEvidence,
  processWithdrawalConfirmedPublicPayoutOutboxBatch,
  runFakePayoutPipeline,
  withWithdrawalTransaction,
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
     VALUES ('PUBLIC_PAYOUT_LOGS_ENABLED', $1::environment_name, $2, 'phase17 builder test')
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
     VALUES ($1::environment_name, 'PUBLIC_PAYOUT_LOGS', $2::bigint, 'phase17-builder', $3)
     RETURNING id::text AS id`,
    [environment, String(9_300_000_000 + Math.floor(Math.random() * 1_000_000)), enabled],
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
  // Fake CONFIRMED_SUCCESS settles without durable proven rows; builder requires them.
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
      evidenceSummary: { phase17: 'builder-test-proven' },
    });
  });
  return { withdrawalId, attemptId };
}

async function insertConfirmedChainTx(
  pool: Pool,
  input: {
    withdrawalId: string;
    attemptId: string;
    amountAtomic?: string;
    assetId?: string;
    networkId?: string;
    chainTxReference?: string;
    explorerOverride?: string | null;
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
  if (input.explorerOverride !== undefined) {
    await pool.query(
      `UPDATE networks SET public_explorer_base_url = $2 WHERE id = $1::uuid`,
      [input.networkId ?? row.network_id, input.explorerOverride],
    );
  }
  await pool.query(
    `INSERT INTO blockchain_transactions (
       network_id, hot_wallet_id, withdrawal_attempt_id, recipient_wallet_id,
       asset_id, chain_tx_reference, recipient_address, amount_atomic, state, confirmed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::uuid, $6, $7, $8::bigint, 'CONFIRMED', now()
     )`,
    [
      input.networkId ?? row.network_id,
      row.hot_wallet_id,
      input.attemptId,
      row.wallet_id,
      input.assetId ?? row.asset_id,
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

async function outboxStatus(pool: Pool, withdrawalId: string): Promise<string | null> {
  const r = await pool.query<{ status: string }>(
    `SELECT status::text AS status FROM outbox_events
     WHERE event_type = 'withdrawal.confirmed' AND aggregate_id = $1::uuid
     ORDER BY created_at DESC LIMIT 1`,
    [withdrawalId],
  );
  return r.rows[0]?.status ?? null;
}

describe.skipIf(phase7DatabaseUrl === '')('Phase17 publication builder', () => {
  let pool: Pool;
  let assetId: string;
  let networkId: string;
  let adminUserId: string;
  let hotWalletId: string;
  let seq = 17_700;

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
    await setFeatureFlag(pool, 'LOCAL', false);
    await setFeatureFlag(pool, 'PRODUCTION', false);
    await setFeatureFlag(pool, 'STAGING', false);
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

  it('feature disabled => no publication, outbox dispatched, audit reason FEATURE_DISABLED', async () => {
    await setFeatureFlag(pool, 'LOCAL', false);
    await seedDestination(pool, 'LOCAL', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    const batch = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
      limit: 10,
    });
    expect(batch.claimed).toBe(1);
    expect(batch.dispatched).toBe(1);
    expect(batch.retried).toBe(0);
    expect(await countPublications(pool, withdrawalId)).toBe(0);
    expect(await outboxStatus(pool, withdrawalId)).toBe('DISPATCHED');

    const audit = await pool.query<{ reason: string | null }>(
      `SELECT reason FROM audit_logs
       WHERE action_type = 'PUBLIC_PAYOUT_NOT_CREATED'
         AND resource_id = $1::uuid
       ORDER BY created_at DESC LIMIT 1`,
      [withdrawalId],
    );
    expect(audit.rows[0]?.reason).toBe('FEATURE_DISABLED');
  });

  it('feature missing => no publication, outbox dispatched, audit FEATURE_FLAG_MISSING', async () => {
    await setFeatureFlag(pool, 'LOCAL', null);
    await seedDestination(pool, 'LOCAL', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    const batch = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
    });
    expect(batch.dispatched).toBe(1);
    expect(await countPublications(pool, withdrawalId)).toBe(0);
    const audit = await pool.query<{ reason: string | null }>(
      `SELECT reason FROM audit_logs
       WHERE action_type = 'PUBLIC_PAYOUT_NOT_CREATED' AND resource_id = $1::uuid`,
      [withdrawalId],
    );
    expect(audit.rows[0]?.reason).toBe('FEATURE_FLAG_MISSING');
  });

  it('feature enabled + one destination => creates PENDING publication', async () => {
    await setFeatureFlag(pool, 'LOCAL', true);
    const destId = await seedDestination(pool, 'LOCAL', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    const batch = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
    });
    expect(batch.dispatched).toBe(1);
    expect(await countPublications(pool, withdrawalId)).toBe(1);
    const pub = await pool.query<{
      status: string;
      destination_id: string;
      identity_mode: string;
      username_snapshot: string | null;
      message_text_snapshot: string | null;
      explorer_url_snapshot: string | null;
    }>(
      `SELECT status::text, destination_id::text, identity_mode::text,
              username_snapshot, message_text_snapshot, explorer_url_snapshot
       FROM payout_publications WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    expect(pub.rows[0]?.status).toBe('PENDING');
    expect(pub.rows[0]?.destination_id).toBe(destId);
    expect(pub.rows[0]?.identity_mode).toBe('HIDE_IDENTITY');
    expect(pub.rows[0]?.username_snapshot).toBeNull();
    expect(pub.rows[0]?.message_text_snapshot).toBeNull();
    expect(pub.rows[0]?.explorer_url_snapshot).toBeNull();
    expect(await outboxStatus(pool, withdrawalId)).toBe('DISPATCHED');
  });

  it('zero destinations => outbox retried with DESTINATION_MISSING', async () => {
    await setFeatureFlag(pool, 'LOCAL', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    const batch = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
    });
    expect(batch.retried).toBe(1);
    expect(batch.dispatched).toBe(0);
    expect(await countPublications(pool, withdrawalId)).toBe(0);
    expect(await outboxStatus(pool, withdrawalId)).toBe('PENDING');
  });

  it('multiple enabled destinations => outbox retried with DESTINATION_AMBIGUOUS', async () => {
    await setFeatureFlag(pool, 'LOCAL', true);
    await seedDestination(pool, 'LOCAL', true);
    await seedDestination(pool, 'LOCAL', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    const batch = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
    });
    expect(batch.retried).toBe(1);
    expect(await countPublications(pool, withdrawalId)).toBe(0);
  });

  it('SHOW_USERNAME snapshots sanitized username; HIDE stays anonymous', async () => {
    await setFeatureFlag(pool, 'LOCAL', true);
    await seedDestination(pool, 'LOCAL', true);

    const showUser = await nextUser('Valid_User1');
    await pool.query(
      `INSERT INTO user_settings (user_id, locale, public_payout_identity_mode)
       VALUES ($1::uuid, 'en', 'SHOW_USERNAME')
       ON CONFLICT (user_id) DO UPDATE
       SET public_payout_identity_mode = 'SHOW_USERNAME'`,
      [showUser],
    );
    const show = await confirmWithdrawal(pool, {
      userId: showUser,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, {
      withdrawalId: show.withdrawalId,
      attemptId: show.attemptId,
    });
    await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, { environment: 'LOCAL' });
    const showPub = await pool.query<{ identity_mode: string; username_snapshot: string | null }>(
      `SELECT identity_mode::text, username_snapshot
       FROM payout_publications WHERE withdrawal_id = $1::uuid`,
      [show.withdrawalId],
    );
    expect(showPub.rows[0]?.identity_mode).toBe('SHOW_USERNAME');
    expect(showPub.rows[0]?.username_snapshot).toBe('Valid_User1');

    const hideUser = await nextUser('HiddenName');
    await pool.query(
      `INSERT INTO user_settings (user_id, locale, public_payout_identity_mode)
       VALUES ($1::uuid, 'en', 'HIDE_IDENTITY')
       ON CONFLICT (user_id) DO UPDATE
       SET public_payout_identity_mode = 'HIDE_IDENTITY'`,
      [hideUser],
    );
    const hide = await confirmWithdrawal(pool, {
      userId: hideUser,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, {
      withdrawalId: hide.withdrawalId,
      attemptId: hide.attemptId,
    });
    await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, { environment: 'LOCAL' });
    const hidePub = await pool.query<{ identity_mode: string; username_snapshot: string | null }>(
      `SELECT identity_mode::text, username_snapshot
       FROM payout_publications WHERE withdrawal_id = $1::uuid`,
      [hide.withdrawalId],
    );
    expect(hidePub.rows[0]?.identity_mode).toBe('HIDE_IDENTITY');
    expect(hidePub.rows[0]?.username_snapshot).toBeNull();
  });

  it('repeat outbox processing remains one publication row (EXISTING)', async () => {
    await setFeatureFlag(pool, 'LOCAL', true);
    await seedDestination(pool, 'LOCAL', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    const first = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
    });
    expect(first.dispatched).toBe(1);
    expect(await countPublications(pool, withdrawalId)).toBe(1);

    // Re-open outbox as PENDING to simulate redelivery.
    await pool.query(
      `UPDATE outbox_events
       SET status = 'PENDING', dispatched_at = NULL, available_at = now()
       WHERE event_type = 'withdrawal.confirmed' AND aggregate_id = $1::uuid`,
      [withdrawalId],
    );
    const second = await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
      environment: 'LOCAL',
    });
    expect(second.dispatched).toBe(1);
    expect(await countPublications(pool, withdrawalId)).toBe(1);
  });

  it('rejects non-CONFIRMED / missing settlement / missing proven / chain mismatch', async () => {
    await setFeatureFlag(pool, 'LOCAL', true);
    await seedDestination(pool, 'LOCAL', true);
    const userId = await nextUser();
    const withdrawalId = await createApprovedWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
      amountAtomic: '200000',
    });

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: randomUUID(),
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toThrow(/CONFIRMED|confirmedAttemptId|STATE_CONFLICT/i);

    const { withdrawalId: okId, attemptId } = await confirmWithdrawal(pool, {
      userId: await nextUser(),
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });

    // Missing chain tx
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId: okId,
          confirmedAttemptId: attemptId,
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    // Wrong amount
    await insertConfirmedChainTx(pool, {
      withdrawalId: okId,
      attemptId,
      amountAtomic: '1',
    });
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId: okId,
          confirmedAttemptId: attemptId,
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  });

  it('rejects missing or http explorer base URL', async () => {
    await setFeatureFlag(pool, 'LOCAL', true);
    await seedDestination(pool, 'LOCAL', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, {
      withdrawalId,
      attemptId,
      explorerOverride: 'http://insecure.example/',
    });
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: attemptId,
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toThrow(/https/i);

    await pool.query(
      `UPDATE networks SET public_explorer_base_url = NULL WHERE id = $1::uuid`,
      [networkId],
    );
    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: attemptId,
          environment: 'LOCAL',
        }),
      ),
    ).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('PRODUCTION environment blocks TON_TESTNET publication', async () => {
    await setFeatureFlag(pool, 'PRODUCTION', true);
    await seedDestination(pool, 'PRODUCTION', true);
    const userId = await nextUser();
    const { withdrawalId, attemptId } = await confirmWithdrawal(pool, {
      userId,
      networkId,
      assetId,
      adminUserId,
      hotWalletId,
    });
    await insertConfirmedChainTx(pool, { withdrawalId, attemptId });

    await expect(
      withWithdrawalTransaction(pool, async (client) =>
        createConfirmedPayoutPublication(client, {
          withdrawalId,
          confirmedAttemptId: attemptId,
          environment: 'PRODUCTION',
        }),
      ),
    ).rejects.toMatchObject({
      code: 'CONFIG',
      details: { code: 'TESTNET_PUBLICATION_BLOCKED' },
    });
  });
});
