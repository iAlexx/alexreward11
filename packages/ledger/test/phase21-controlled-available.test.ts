/**
 * Phase 21 Mainnet controlled Available provision — throwaway DB only (PHASE4_DATABASE_URL).
 * Seeds TON_MAINNET + disposable USDT master (no PLACEHOLDER/LOCAL/TESTNET markers). Never enable gate.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertConnectedDestructiveTestDatabase } from '@alex-rewards/db';

import {
  LedgerDomainError,
  PHASE21_CONTROLLED_AVAILABLE_CAMPAIGN_CEILING_ATOMIC,
  getOrCreateLedgerAccount,
  provisionPhase21ControlledAvailable,
  reversePhase21ControlledAvailableProvision,
  withLedgerTransaction,
  type Phase21ControlledAvailableProvisionRuntimeConfig,
} from '../src/index.js';
import {
  balanceOf,
  createTestUser,
  phase4DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

const describePhase21 = phase4DatabaseUrl === '' ? describe.skip : describe;

const TEST_USDT_MASTER = 'EQ_PHASE21_DISPOSABLE_MAINNET_USDT_MASTER_V1';
const CAMPAIGN_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

async function seedOwnerAdmin(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status, telegram_user_id)
     VALUES ($1, 'Phase21 Owner', 'ACTIVE', $2::bigint)
     RETURNING id`,
    [
      `phase21-owner-${randomUUID()}@example.local`,
      String(810000 + Math.floor(Math.random() * 10000)),
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

async function seedMainnetUsdt(pool: Pool): Promise<{ networkId: string; assetId: string }> {
  const net = await pool.query<{ id: string }>(
    `INSERT INTO networks (
       code, chain, environment, display_name, global_chain_identifier, status
     ) VALUES (
       'TON_MAINNET', 'TON', 'MAINNET', 'TON Mainnet (PHASE21 TEST ONLY)',
       'ton:mainnet', 'ACTIVE'
     )
     ON CONFLICT (code) DO UPDATE
       SET chain = EXCLUDED.chain,
           environment = EXCLUDED.environment,
           global_chain_identifier = EXCLUDED.global_chain_identifier,
           status = 'ACTIVE',
           updated_at = now()
     RETURNING id`,
  );
  let networkId = net.rows[0]?.id;
  if (networkId === undefined) {
    const existing = await pool.query<{ id: string }>(
      `SELECT id FROM networks WHERE code = 'TON_MAINNET'`,
    );
    networkId = existing.rows[0]?.id;
  }
  if (networkId === undefined) throw new Error('TON_MAINNET seed failed');

  await pool.query(
    `DELETE FROM assets WHERE network_id = $1::uuid AND symbol IN ('USDT', 'GRAM', 'TON')`,
    [networkId],
  );

  const asset = await pool.query<{ id: string }>(
    `INSERT INTO assets (
       network_id, symbol, name, decimals, is_native, contract_identity, status
     ) VALUES (
       $1::uuid, 'USDT', 'USDT (PHASE21 TEST ONLY)', 6, false, $2, 'ACTIVE'
     )
     RETURNING id`,
    [networkId, TEST_USDT_MASTER],
  );
  const assetId = asset.rows[0]?.id;
  if (assetId === undefined) throw new Error('USDT seed failed');
  return { networkId, assetId };
}

function baseConfig(input: {
  adminUserId: string;
  userId: string;
  enabled?: boolean;
  deploymentEnv?: Phase21ControlledAvailableProvisionRuntimeConfig['deploymentEnv'];
  operationalCeremonyEnabled?: boolean;
  networkCode?: string;
  assetSymbol?: string;
  maxAmountAtomic?: string;
  campaignId?: string;
  requiredUsdtJettonMaster?: string;
  requiredDatabaseName?: string;
}): Phase21ControlledAvailableProvisionRuntimeConfig {
  return {
    enabled: input.enabled ?? true,
    deploymentEnv: input.deploymentEnv ?? 'test',
    operationalCeremonyEnabled: input.operationalCeremonyEnabled ?? false,
    withdrawalNetworkCode: input.networkCode ?? 'TON_MAINNET',
    withdrawalAssetSymbol: input.assetSymbol ?? 'USDT',
    allowedUserId: input.userId,
    maxAmountAtomic: input.maxAmountAtomic ?? '1000000',
    ownerAdminUserId: input.adminUserId,
    campaignId: input.campaignId ?? CAMPAIGN_ID,
    requiredUsdtJettonMaster: input.requiredUsdtJettonMaster ?? TEST_USDT_MASTER,
    requiredDatabaseName: input.requiredDatabaseName ?? '',
  };
}

describePhase21('phase21 mainnet controlled available provision', () => {
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
    await pool.query(`
      DO $m0_restore_seat$
      BEGIN
        IF to_regclass('public.admin_owner_authority') IS NOT NULL THEN
          INSERT INTO admin_owner_authority (seat) VALUES (1)
          ON CONFLICT (seat) DO UPDATE
            SET holder_admin_user_id = NULL,
                active_binding_id = NULL,
                claimed_at = NULL,
                updated_at = now();
        END IF;
      END
      $m0_restore_seat$
    `);
    const seeded = await seedMainnetUsdt(pool);
    netId = seeded.networkId;
    assetId = seeded.assetId;
    adminUserId = await seedOwnerAdmin(pool);
    userId = await createTestUser(pool, String(820000 + ++seq));
  });

  it('1 gate disabled → reject', async () => {
    await expect(
      provisionPhase21ControlledAvailable(
        pool,
        baseConfig({ adminUserId, userId, enabled: false }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'PROVISION_DISABLED' } });
  });

  it('2 production without ceremony gate → reject', async () => {
    await expect(
      provisionPhase21ControlledAvailable(
        pool,
        baseConfig({ adminUserId, userId, deploymentEnv: 'production' }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'OPERATIONAL_CEREMONY_GATE_REQUIRED' },
    });
  });

  it('2b staging → reject STAGING_PROVISION_FORBIDDEN', async () => {
    await expect(
      provisionPhase21ControlledAvailable(
        pool,
        baseConfig({ adminUserId, userId, deploymentEnv: 'staging' }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'STAGING_PROVISION_FORBIDDEN' },
    });
  });

  it('2c production + ceremony + matching disposable DB identity → accept', async () => {
    const dbName = await pool.query<{ name: string }>(`SELECT current_database() AS name`);
    const currentDb = dbName.rows[0]?.name;
    expect(currentDb).toBeTruthy();
    expect(currentDb).not.toBe('alex_rewards');

    const result = await provisionPhase21ControlledAvailable(
      pool,
      baseConfig({
        adminUserId,
        userId,
        deploymentEnv: 'production',
        operationalCeremonyEnabled: true,
        requiredDatabaseName: currentDb!,
      }),
      { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'operational-mode-sim' },
    );
    expect(result.created).toBe(true);
    expect(result.amountAtomic).toBe('1000');
  });

  it('3 testnet network reject', async () => {
    await expect(
      provisionPhase21ControlledAvailable(
        pool,
        baseConfig({ adminUserId, userId, networkCode: 'TON_TESTNET' }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'NETWORK_CODE_MISMATCH' } });
  });

  it('4 GRAM asset reject', async () => {
    await expect(
      provisionPhase21ControlledAvailable(
        pool,
        baseConfig({ adminUserId, userId, assetSymbol: 'GRAM' }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('5 TON native asset reject', async () => {
    await expect(
      provisionPhase21ControlledAvailable(
        pool,
        baseConfig({ adminUserId, userId, assetSymbol: 'TON' }),
        { operationId: randomUUID(), userId, amountAtomic: '1000', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('6 wrong user → reject', async () => {
    const other = await createTestUser(pool, String(830000 + ++seq));
    await expect(
      provisionPhase21ControlledAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId: other,
        amountAtomic: '1000',
        reason: 'test',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'USER_NOT_ALLOWLISTED' } });
  });

  it('7 amount <= 0 → reject', async () => {
    await expect(
      provisionPhase21ControlledAvailable(pool, baseConfig({ adminUserId, userId }), {
        operationId: randomUUID(),
        userId,
        amountAtomic: '0',
        reason: 'test',
      }),
    ).rejects.toBeInstanceOf(LedgerDomainError);
  });

  it('8 over per-call cap → reject', async () => {
    await expect(
      provisionPhase21ControlledAvailable(
        pool,
        baseConfig({ adminUserId, userId, maxAmountAtomic: '1000' }),
        { operationId: randomUUID(), userId, amountAtomic: '1001', reason: 'test' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'AMOUNT_OVER_CAP' } });
  });

  it('9 over aggregate ceiling 10_000_000 → reject', async () => {
    const cfg = baseConfig({
      adminUserId,
      userId,
      maxAmountAtomic: '10000000',
    });
    await provisionPhase21ControlledAvailable(pool, cfg, {
      operationId: randomUUID(),
      userId,
      amountAtomic: '6000000',
      reason: 'fill-half',
    });
    await expect(
      provisionPhase21ControlledAvailable(pool, cfg, {
        operationId: randomUUID(),
        userId,
        amountAtomic: '4000001',
        reason: 'over-ceiling',
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'CAMPAIGN_CEILING_EXCEEDED' },
    });
    expect(PHASE21_CONTROLLED_AVAILABLE_CAMPAIGN_CEILING_ATOMIC).toBe(10_000_000n);
  });

  it('10 valid provision posts SUPPORT_ADJUSTMENT', async () => {
    const operationId = randomUUID();
    const result = await provisionPhase21ControlledAvailable(
      pool,
      baseConfig({ adminUserId, userId }),
      { operationId, userId, amountAtomic: '250000', reason: 'phase21 controlled test' },
    );
    expect(result.created).toBe(true);
    expect(result.campaignId).toBe(CAMPAIGN_ID);

    const tx = await pool.query<{
      transaction_type: string;
      business_reference_type: string;
    }>(
      `SELECT transaction_type::text AS transaction_type, business_reference_type
       FROM ledger_transactions WHERE id = $1::uuid`,
      [result.ledgerTransactionId],
    );
    expect(tx.rows[0]?.transaction_type).toBe('SUPPORT_ADJUSTMENT');
    expect(tx.rows[0]?.business_reference_type).toBe(
      'phase21-mainnet-controlled-available-provision',
    );

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

    const audit = await pool.query<{ action_type: string }>(
      `SELECT action_type FROM audit_logs
       WHERE action_type = 'OWNER_MAINNET_CONTROLLED_AVAILABLE_PROVISION'`,
    );
    expect(audit.rowCount).toBe(1);
    expect(result.assetId).toBe(assetId);
    expect(result.networkId).toBe(netId);
  });

  it('11 idempotent retry → no duplicate credit', async () => {
    const operationId = randomUUID();
    const cfg = baseConfig({ adminUserId, userId });
    const first = await provisionPhase21ControlledAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'retry-same',
    });
    const second = await provisionPhase21ControlledAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'retry-same',
    });
    expect(second.created).toBe(false);
    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);
  });

  it('12 intent mismatch on retry → reject', async () => {
    const operationId = randomUUID();
    const cfg = baseConfig({ adminUserId, userId });
    await provisionPhase21ControlledAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '100000',
      reason: 'amt',
    });
    await expect(
      provisionPhase21ControlledAvailable(pool, cfg, {
        operationId,
        userId,
        amountAtomic: '200000',
        reason: 'amt',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      details: { reason: 'INTENT_MISMATCH' },
    });
  });

  it('13 concurrent ceiling → aggregate never exceeds', async () => {
    const cfg = baseConfig({
      adminUserId,
      userId,
      maxAmountAtomic: '10000000',
    });
    const results = await Promise.allSettled([
      provisionPhase21ControlledAvailable(pool, cfg, {
        operationId: randomUUID(),
        userId,
        amountAtomic: '6000000',
        reason: 'race-a',
      }),
      provisionPhase21ControlledAvailable(pool, cfg, {
        operationId: randomUUID(),
        userId,
        amountAtomic: '6000000',
        reason: 'race-b',
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    const sum = await pool.query<{ total: string }>(
      `SELECT COALESCE(SUM(e.amount_atomic), 0)::text AS total
       FROM ledger_transactions t
       INNER JOIN ledger_entries e ON e.ledger_transaction_id = t.id
       INNER JOIN ledger_accounts a ON a.id = e.ledger_account_id
       WHERE t.business_reference_type = 'phase21-mainnet-controlled-available-provision'
         AND e.direction = 'CREDIT'
         AND a.account_type = 'USER_AVAILABLE_LIABILITY'`,
    );
    expect(BigInt(sum.rows[0]?.total ?? '0')).toBeLessThanOrEqual(10_000_000n);
  });

  it('14 reverse + reverse retry', async () => {
    const cfg = baseConfig({ adminUserId, userId });
    const provision = await provisionPhase21ControlledAvailable(pool, cfg, {
      operationId: randomUUID(),
      userId,
      amountAtomic: '100000',
      reason: 'to-reverse',
    });
    const reverseOp = randomUUID();
    const first = await reversePhase21ControlledAvailableProvision(pool, cfg, {
      operationId: reverseOp,
      originalLedgerTransactionId: provision.ledgerTransactionId,
      reason: 'undo',
    });
    expect(first.created).toBe(true);

    const again = await reversePhase21ControlledAvailableProvision(pool, cfg, {
      operationId: reverseOp,
      originalLedgerTransactionId: provision.ledgerTransactionId,
      reason: 'undo',
    });
    expect(again.created).toBe(false);
    expect(again.reversalLedgerTransactionId).toBe(first.reversalLedgerTransactionId);

    const available = await withLedgerTransaction(pool, async (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    expect(await balanceOf(pool, available.id)).toBe(0n);
  });
});
