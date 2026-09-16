/**
 * Phase 10 Testnet Available provision — throwaway DB only (PHASE4_DATABASE_URL / opted-in).
 *
 * Behavior → test mapping (21 required behaviors; 19 cases; 17–19 combined):
 *  1 gate disabled                         → '1 gate disabled'
 *  2 wrong environment                     → '2 wrong environment'
 *  3 Mainnet/network mismatch              → '3 Mainnet/network mismatch'
 *  4 inactive network                      → '4 inactive network'
 *  5 wrong/inactive asset                  → '5 wrong/inactive asset'
 *  6 non-allowlisted user                  → '6 non-allowlisted user'
 *  7 inactive user                         → '7 inactive user'
 *  8 withdrawal-blocked user               → '8 withdrawal-blocked user'
 *  9 zero amount                           → '9 zero amount'
 * 10 over-cap amount                       → '10 amount over cap'
 * 11 valid exact posting                   → '11 valid provision…'
 * 12 exact retry                           → '12 exact retry…'
 * 13 same operation + changed amount       → '13 …changed amount'
 * 14 same operation + changed user         → '14 …changed user'
 * 15 same operation + changed reason       → '15 …changed reason'
 * 16 concurrent duplicate                  → '16 concurrent…'
 * 17 valid linked reversal                 → '17–19 linked reversal…' (first assert)
 * 18 duplicate reversal retry              → '17–19…' (again.created === false)
 * 19 second independent reversal conflict  → '17–19…' (REVERSAL_CONFLICT)
 * 20 reversal when Available insufficient  → '20 reversal after Available…'
 * 21 zero withdrawal/outbox/attempt touch  → '21 provision/reverse do not touch…'
 * 22 reverse after later BLOCKED/INACTIVE → '22 reverse still works…'
 * 23 reverse reason mismatch on retry     → '23 reverse reason mismatch…'
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertConnectedDestructiveTestDatabase } from '@alex-rewards/db';

import {
  LedgerDomainError,
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  provisionPhase10TestnetAvailable,
  reversePhase10TestnetAvailableProvision,
  withLedgerTransaction,
  type Phase10TestnetProvisionRuntimeConfig,
} from '../src/index.js';
import {
  balanceOf,
  createTestUser,
  phase4DatabaseUrl,
  resetAndMigrate,
  usdtAssetId,
} from './harness.js';

const describePhase10 = phase4DatabaseUrl === '' ? describe.skip : describe;

async function seedOwnerAdmin(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status, telegram_user_id)
     VALUES ($1, 'Phase10 Owner', 'ACTIVE', $2::bigint)
     RETURNING id`,
    [
      `phase10-owner-${randomUUID()}@example.local`,
      String(910000 + Math.floor(Math.random() * 10000)),
    ],
  );
  const adminUserId = result.rows[0]?.id;
  if (adminUserId === undefined) throw new Error('admin insert failed');
  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error('OWNER role missing');
  await pool.query(
    `INSERT INTO admin_role_bindings (admin_user_id, role_id)
     VALUES ($1::uuid, $2::uuid)
     ON CONFLICT DO NOTHING`,
    [adminUserId, roleId],
  );
  return adminUserId;
}

async function networkId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM networks WHERE code = 'TON_TESTNET'`,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('TON_TESTNET missing');
  return id;
}

function baseConfig(input: {
  adminUserId: string;
  userId: string;
  enabled?: boolean;
  deploymentEnv?: Phase10TestnetProvisionRuntimeConfig['deploymentEnv'];
  networkCode?: string;
  assetSymbol?: string;
  maxAmountAtomic?: string;
}): Phase10TestnetProvisionRuntimeConfig {
  return {
    enabled: input.enabled ?? true,
    deploymentEnv: input.deploymentEnv ?? 'test',
    withdrawalNetworkCode: input.networkCode ?? 'TON_TESTNET',
    withdrawalAssetSymbol: input.assetSymbol ?? 'USDT',
    allowedUserId: input.userId,
    maxAmountAtomic: input.maxAmountAtomic ?? '1000000',
    ownerAdminUserId: input.adminUserId,
  };
}

describePhase10('phase10 testnet available provision', () => {
  let pool: Pool;
  let adminUserId: string;
  let userId: string;
  let assetId: string;
  let netId: string;
  let seq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase4DatabaseUrl);
    pool = new Pool({ connectionString: phase4DatabaseUrl });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await assertConnectedDestructiveTestDatabase(pool);
    await pool.query(`
      TRUNCATE TABLE
        audit_logs,
        ledger_entries,
        ledger_transactions,
        ledger_account_balances,
        ledger_accounts,
        outbox_events,
        withdrawal_attempts,
        withdrawals,
        admin_role_bindings,
        admin_users,
        users
      RESTART IDENTITY CASCADE
    `);
    await pool.query(`UPDATE networks SET status = 'ACTIVE' WHERE code = 'TON_TESTNET'`);
    await pool.query(
      `UPDATE assets SET status = 'ACTIVE' WHERE symbol = 'USDT' AND network_id = (
         SELECT id FROM networks WHERE code = 'TON_TESTNET'
       )`,
    );
    // Keep networks/assets/roles from fixtures.
    adminUserId = await seedOwnerAdmin(pool);
    userId = await createTestUser(pool, String(920000 + ++seq));
    assetId = await usdtAssetId(pool);
    netId = await networkId(pool);
  });

  it('1 gate disabled → reject', async () => {
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId, enabled: false }), {
        operationId: randomUUID(),
        userId,
        amountAtomic: '1000',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'PROVISION_DISABLED' } });
  });

  it('2 wrong environment → reject', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        baseConfig({ adminUserId, userId, deploymentEnv: 'production' }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'INVALID_DEPLOYMENT_ENV' } });
  });

  it('3 Mainnet/network mismatch → reject', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        baseConfig({ adminUserId, userId, networkCode: 'TON_MAINNET' }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('4 inactive network → reject', async () => {
    await pool.query(`UPDATE networks SET status = 'DISABLED' WHERE id = $1::uuid`, [netId]);
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId,
        amountAtomic: '1000',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'NETWORK_INACTIVE' } });
  });

  it('5 wrong/inactive asset → reject', async () => {
    await pool.query(`UPDATE assets SET status = 'DISABLED' WHERE id = $1::uuid`, [assetId]);
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId,
        amountAtomic: '1000',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'ASSET_INACTIVE' } });
  });

  it('6 non-allowlisted user → reject', async () => {
    const other = await createTestUser(pool, String(930000 + ++seq));
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId: other,
        amountAtomic: '1000',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'USER_NOT_ALLOWLISTED' } });
  });

  it('7 inactive user → reject', async () => {
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1::uuid`, [userId]);
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId,
        amountAtomic: '1000',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'USER_INACTIVE' } });
  });

  it('8 withdrawal-blocked user → reject', async () => {
    await pool.query(`UPDATE users SET withdrawal_status = 'BLOCKED' WHERE id = $1::uuid`, [
      userId,
    ]);
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId,
        amountAtomic: '1000',
        reason: 'test',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'USER_WITHDRAWAL_BLOCKED' },
    });
  });

  it('9 zero amount → reject', async () => {
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId,
        amountAtomic: '0',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(LedgerDomainError);
  });

  it('10 amount over cap → reject', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        baseConfig({ adminUserId, userId, maxAmountAtomic: '1000' }),
        { operationId: randomUUID(), userId, amountAtomic: '1001', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'AMOUNT_OVER_CAP' } });
  });

  it('11 valid provision posts SUPPORT_ADJUSTMENT and audit', async () => {
    const operationId = randomUUID();
    const result = await provisionPhase10TestnetAvailable(
      pool,
      baseConfig({ adminUserId, userId }),
      { operationId, userId, amountAtomic: '250000', reason: 'phase10 controlled test' },
    );
    expect(result.created).toBe(true);
    expect(result.operationId).toBe(operationId);

    const tx = await pool.query<{
      transaction_type: string;
      business_reference_type: string;
      c: number;
    }>(
      `SELECT transaction_type::text AS transaction_type, business_reference_type,
              (SELECT count(*)::int FROM ledger_transactions WHERE transaction_type = 'SUPPORT_ADJUSTMENT') AS c
       FROM ledger_transactions WHERE id = $1::uuid`,
      [result.ledgerTransactionId],
    );
    expect(tx.rows[0]?.transaction_type).toBe('SUPPORT_ADJUSTMENT');
    expect(tx.rows[0]?.business_reference_type).toBe('phase10-testnet-available-provision');
    expect(tx.rows[0]?.c).toBe(1);

    const entries = await pool.query<{
      account_type: string;
      direction: string;
      amount_atomic: string;
    }>(
      `SELECT a.account_type::text AS account_type, e.direction::text AS direction,
              e.amount_atomic::text AS amount_atomic
       FROM ledger_entries e
       INNER JOIN ledger_accounts a ON a.id = e.ledger_account_id
       WHERE e.ledger_transaction_id = $1::uuid
       ORDER BY e.entry_index`,
      [result.ledgerTransactionId],
    );
    expect(entries.rows).toEqual([
      {
        account_type: 'SUPPORT_COMPENSATION_EXPENSE',
        direction: 'DEBIT',
        amount_atomic: '250000',
      },
      {
        account_type: 'USER_AVAILABLE_LIABILITY',
        direction: 'CREDIT',
        amount_atomic: '250000',
      },
    ]);

    const available = await withLedgerTransaction(pool, async (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    expect(await balanceOf(pool, available.id)).toBe(250000n);

    const audit = await pool.query<{ action_type: string; admin_user_id: string }>(
      `SELECT action_type, admin_user_id::text AS admin_user_id
       FROM audit_logs WHERE action_type = 'OWNER_TESTNET_AVAILABLE_PROVISION'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.admin_user_id).toBe(adminUserId);
  });

  it('12 exact retry → no duplicate credit', async () => {
    const operationId = randomUUID();
    const cfg = baseConfig({ adminUserId, userId });
    const first = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'retry-same',
    });
    const second = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'retry-same',
    });
    expect(second.created).toBe(false);
    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE transaction_type = 'SUPPORT_ADJUSTMENT'`,
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('13 same operationId + changed amount → reject', async () => {
    const operationId = randomUUID();
    const cfg = baseConfig({ adminUserId, userId });
    await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'amt',
    });
    await expect(
      provisionPhase10TestnetAvailable(pool, cfg, {
        operationId,
        userId,
        amountAtomic: '200000',
        reason: 'amt',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('14 same operationId + changed user → reject', async () => {
    const operationId = randomUUID();
    const other = await createTestUser(pool, String(940000 + ++seq));
    const cfg = baseConfig({ adminUserId, userId });
    await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'user',
    });
    await expect(
      provisionPhase10TestnetAvailable(pool, baseConfig({ adminUserId, userId: other }), {
        operationId,
        userId: other,
        amountAtomic: '100000',
        reason: 'user',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('15 same operationId + changed reason → reject', async () => {
    const operationId = randomUUID();
    const cfg = baseConfig({ adminUserId, userId });
    await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'reason-a',
    });
    await expect(
      provisionPhase10TestnetAvailable(pool, cfg, {
        operationId,
        userId,
        amountAtomic: '100000',
        reason: 'reason-b',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { reason: 'INTENT_MISMATCH' },
    });
  });

  it('16 concurrent duplicate invocation → exactly one economic provision', async () => {
    const operationId = randomUUID();
    const cfg = baseConfig({ adminUserId, userId });
    const input = {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'concurrent',
    };
    const results = await Promise.all([
      provisionPhase10TestnetAvailable(pool, cfg, input),
      provisionPhase10TestnetAvailable(pool, cfg, input),
      provisionPhase10TestnetAvailable(pool, cfg, input),
    ]);
    const ids = new Set(results.map((r) => r.ledgerTransactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE transaction_type = 'SUPPORT_ADJUSTMENT'`,
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('17–19 linked reversal, duplicate reverse, second reverse fail-closed', async () => {
    const cfg = baseConfig({ adminUserId, userId });
    const provision = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId: randomUUID(),
      userId,
      amountAtomic: '100000',
      reason: 'to-reverse',
    });
    const reverseOp = randomUUID();
    const first = await reversePhase10TestnetAvailableProvision(pool, cfg, {
      operationId: reverseOp,
      originalLedgerTransactionId: provision.ledgerTransactionId,
      reason: 'undo',
    });
    expect(first.created).toBe(true);

    const again = await reversePhase10TestnetAvailableProvision(pool, cfg, {
      operationId: reverseOp,
      originalLedgerTransactionId: provision.ledgerTransactionId,
      reason: 'undo',
    });
    expect(again.created).toBe(false);
    expect(again.reversalLedgerTransactionId).toBe(first.reversalLedgerTransactionId);

    await expect(
      reversePhase10TestnetAvailableProvision(pool, cfg, {
        operationId: randomUUID(),
        originalLedgerTransactionId: provision.ledgerTransactionId,
        reason: 'second-undo',
      }),
    ).rejects.toMatchObject({ code: 'REVERSAL_CONFLICT' });

    const available = await withLedgerTransaction(pool, async (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    expect(await balanceOf(pool, available.id)).toBe(0n);
  });

  it('20 reversal after Available insufficient → fail closed', async () => {
    const cfg = baseConfig({ adminUserId, userId });
    const provision = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId: randomUUID(),
      userId,
      amountAtomic: '100000',
      reason: 'spend-then-reverse',
    });

    // Move Available elsewhere so reverse would go negative.
    await withLedgerTransaction(pool, async (client) => {
      const available = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      });
      const reserved = await getOrCreateLedgerAccount(client, {
        accountType: 'USER_RESERVED_LIABILITY',
        assetId,
        ownerId: userId,
      });
      await postLedgerTransaction(client, {
        transactionType: 'WITHDRAWAL_RESERVATION',
        businessReferenceType: 'phase10-test-reserve',
        businessReferenceId: randomUUID(),
        idempotencyScope: 'phase10.test.reserve',
        idempotencyKey: randomUUID(),
        assetId,
        entries: [
          { ledgerAccountId: available.id, direction: 'DEBIT', amountAtomic: '100000' },
          { ledgerAccountId: reserved.id, direction: 'CREDIT', amountAtomic: '100000' },
        ],
      });
    });

    await expect(
      reversePhase10TestnetAvailableProvision(pool, cfg, {
        operationId: randomUUID(),
        originalLedgerTransactionId: provision.ledgerTransactionId,
        reason: 'too-late',
      }),
    ).rejects.toMatchObject({ code: 'NEGATIVE_PROTECTED_BALANCE' });

    const reverseCount = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions WHERE reverses_transaction_id = $1::uuid`,
      [provision.ledgerTransactionId],
    );
    expect(reverseCount.rows[0]?.c).toBe(0);
  });

  it('21 provision/reverse do not touch withdrawal/outbox/attempt rows', async () => {
    const before = await pool.query<{
      w: number;
      a: number;
      o: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM withdrawals) AS w,
         (SELECT count(*)::int FROM withdrawal_attempts) AS a,
         (SELECT count(*)::int FROM outbox_events) AS o`,
    );
    const cfg = baseConfig({ adminUserId, userId });
    const provision = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId: randomUUID(),
      userId,
      amountAtomic: '50000',
      reason: 'no-wd-touch',
    });
    await reversePhase10TestnetAvailableProvision(pool, cfg, {
      operationId: randomUUID(),
      originalLedgerTransactionId: provision.ledgerTransactionId,
      reason: 'no-wd-touch-rev',
    });
    const after = await pool.query<{
      w: number;
      a: number;
      o: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM withdrawals) AS w,
         (SELECT count(*)::int FROM withdrawal_attempts) AS a,
         (SELECT count(*)::int FROM outbox_events) AS o`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('22 reverse still works if user later BLOCKED or INACTIVE', async () => {
    await pool.query(
      `UPDATE users SET status = 'ACTIVE', withdrawal_status = 'ALLOWED' WHERE id = $1::uuid`,
      [userId],
    );
    const cfg = baseConfig({ adminUserId, userId });
    const provision = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId: randomUUID(),
      userId,
      amountAtomic: '75000',
      reason: 'later-block-reverse',
    });

    await pool.query(
      `UPDATE users SET status = 'SUSPENDED', withdrawal_status = 'BLOCKED' WHERE id = $1::uuid`,
      [userId],
    );

    const reversed = await reversePhase10TestnetAvailableProvision(pool, cfg, {
      operationId: randomUUID(),
      originalLedgerTransactionId: provision.ledgerTransactionId,
      reason: 'undo-after-block',
    });
    expect(reversed.created).toBe(true);
    expect(reversed.targetUserId).toBe(userId);

    const available = await withLedgerTransaction(pool, async (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    expect(await balanceOf(pool, available.id)).toBe(0n);
  });

  it('23 reverse reason mismatch on idempotent retry → reject', async () => {
    const cfg = baseConfig({ adminUserId, userId });
    const provision = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId: randomUUID(),
      userId,
      amountAtomic: '40000',
      reason: 'rev-reason-base',
    });
    const reverseOp = randomUUID();
    const first = await reversePhase10TestnetAvailableProvision(pool, cfg, {
      operationId: reverseOp,
      originalLedgerTransactionId: provision.ledgerTransactionId,
      reason: 'undo-a',
    });
    expect(first.created).toBe(true);

    await expect(
      reversePhase10TestnetAvailableProvision(pool, cfg, {
        operationId: reverseOp,
        originalLedgerTransactionId: provision.ledgerTransactionId,
        reason: 'undo-b-different',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { reason: 'REVERSE_INTENT_MISMATCH' },
    });
  });
});
