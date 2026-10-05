/**
 * Phase 10 Testnet aalex provision allowlist — throwaway DB only.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assertConnectedDestructiveTestDatabase } from '@alex-rewards/db';

import {
  PHASE10_TESTNET_AALEX_CONTRACT_IDENTITY,
  PHASE10_TESTNET_AALEX_DECIMALS,
  getOrCreateLedgerAccount,
  provisionPhase10TestnetAvailable,
  withLedgerTransaction,
  type Phase10TestnetProvisionRuntimeConfig,
} from '../src/index.js';
import {
  balanceOf,
  createTestUser,
  phase4DatabaseUrl,
  resetAndMigrate,
} from './harness.js';

const describeAalex = phase4DatabaseUrl === '' ? describe.skip : describe;

async function seedOwnerAdmin(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status, telegram_user_id)
     VALUES ($1, 'Phase10 Aalex Owner', 'ACTIVE', $2::bigint)
     RETURNING id`,
    [
      `phase10-aalex-owner-${randomUUID()}@example.local`,
      String(960000 + Math.floor(Math.random() * 10000)),
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

async function currentDatabaseName(pool: Pool): Promise<string> {
  const result = await pool.query<{ name: string }>(`SELECT current_database() AS name`);
  const name = result.rows[0]?.name;
  if (name === undefined) throw new Error('current_database missing');
  return name;
}

async function ensureAalexAsset(
  pool: Pool,
  input: {
    readonly decimals?: number;
    readonly contractIdentity?: string;
    readonly status?: string;
  } = {},
): Promise<{ assetId: string; networkId: string }> {
  const network = await pool.query<{ id: string }>(
    `SELECT id FROM networks WHERE code = 'TON_TESTNET'`,
  );
  const networkId = network.rows[0]?.id;
  if (networkId === undefined) throw new Error('TON_TESTNET missing');

  await pool.query(`DELETE FROM assets WHERE symbol = 'aalex' AND network_id = $1::uuid`, [
    networkId,
  ]);

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO assets (
       network_id, symbol, name, decimals, is_native, contract_identity, status
     ) VALUES (
       $1::uuid, 'aalex', 'Isolated Testnet aalex', $2, false, $3, $4
     )
     RETURNING id`,
    [
      networkId,
      input.decimals ?? PHASE10_TESTNET_AALEX_DECIMALS,
      input.contractIdentity ?? PHASE10_TESTNET_AALEX_CONTRACT_IDENTITY,
      input.status ?? 'ACTIVE',
    ],
  );
  const assetId = inserted.rows[0]?.id;
  if (assetId === undefined) throw new Error('aalex insert failed');
  return { assetId, networkId };
}

function aalexConfig(input: {
  adminUserId: string;
  userId: string;
  requiredDatabaseName: string;
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
    withdrawalAssetSymbol: input.assetSymbol ?? 'aalex',
    allowedUserId: input.userId,
    maxAmountAtomic: input.maxAmountAtomic ?? '1000000000',
    ownerAdminUserId: input.adminUserId,
    requiredDatabaseName: input.requiredDatabaseName,
  };
}

describeAalex('phase10 testnet aalex provision allowlist', () => {
  let pool: Pool;
  let adminUserId: string;
  let userId: string;
  let dbName: string;
  let seq = 0;

  beforeAll(async () => {
    await resetAndMigrate(phase4DatabaseUrl);
    pool = new Pool({ connectionString: phase4DatabaseUrl });
    dbName = await currentDatabaseName(pool);
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
    await pool.query(`UPDATE networks SET status = 'ACTIVE' WHERE code = 'TON_TESTNET'`);
    await pool.query(
      `UPDATE assets SET status = 'ACTIVE' WHERE symbol = 'USDT' AND network_id = (
         SELECT id FROM networks WHERE code = 'TON_TESTNET'
       )`,
    );
    adminUserId = await seedOwnerAdmin(pool);
    userId = await createTestUser(pool, String(970000 + ++seq));
    await ensureAalexAsset(pool);
  });

  it('accepts exact aalex master/decimals and credits AVAILABLE', async () => {
    const { assetId } = await ensureAalexAsset(pool);
    const operationId = randomUUID();
    const result = await provisionPhase10TestnetAvailable(
      pool,
      aalexConfig({ adminUserId, userId, requiredDatabaseName: dbName }),
      {
        operationId,
        userId,
        amountAtomic: '1000000000',
        reason: 'isolated-aalex-provision-test',
      },
    );
    expect(result.created).toBe(true);
    expect(result.assetId).toBe(assetId);
    expect(result.amountAtomic).toBe('1000000000');

    const available = await withLedgerTransaction(pool, async (client) =>
      getOrCreateLedgerAccount(client, {
        accountType: 'USER_AVAILABLE_LIABILITY',
        assetId,
        ownerId: userId,
      }),
    );
    expect(await balanceOf(pool, available.id)).toBe(1_000_000_000n);
  });

  it('rejects wrong aalex Jetton master', async () => {
    await ensureAalexAsset(pool, {
      contractIdentity: '0:0000000000000000000000000000000000000000000000000000000000000000',
    });
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({ adminUserId, userId, requiredDatabaseName: dbName }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'wrong-master',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'ASSET_CONTRACT_MISMATCH' } });
  });

  it('rejects wrong aalex decimals', async () => {
    await ensureAalexAsset(pool, { decimals: 6 });
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({ adminUserId, userId, requiredDatabaseName: dbName }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'wrong-decimals',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'ASSET_DECIMALS_MISMATCH' } });
  });

  it('rejects non-allowlisted asset symbol', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({
          adminUserId,
          userId,
          requiredDatabaseName: dbName,
          assetSymbol: 'TON',
        }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000',
          reason: 'ton-not-allowed',
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'ASSET_SYMBOL_NOT_ALLOWLISTED' },
    });
  });

  it('rejects Mainnet network code', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({
          adminUserId,
          userId,
          requiredDatabaseName: dbName,
          networkCode: 'TON_MAINNET',
        }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'mainnet',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects production deployment env', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({
          adminUserId,
          userId,
          requiredDatabaseName: dbName,
          deploymentEnv: 'production',
        }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'prod',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'INVALID_DEPLOYMENT_ENV' } });
  });

  it('rejects missing/mismatched required database identity', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({ adminUserId, userId, requiredDatabaseName: '' }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'no-db-name',
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'REQUIRED_DATABASE_NAME_MISSING' },
    });

    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({
          adminUserId,
          userId,
          requiredDatabaseName: 'alex_rewards_isolated_payout_testnet',
        }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'wrong-db-name',
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'DATABASE_IDENTITY_MISMATCH' },
    });

    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({
          adminUserId,
          userId,
          requiredDatabaseName: 'alex_rewards',
        }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'ops-db',
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'OPERATIONAL_DATABASE_FORBIDDEN' },
    });
  });

  it('rejects inactive Owner admin', async () => {
    await pool.query(`UPDATE admin_users SET status = 'DISABLED' WHERE id = $1::uuid`, [
      adminUserId,
    ]);
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({ adminUserId, userId, requiredDatabaseName: dbName }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'bad-admin',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'OWNER_ADMIN_NOT_ACTIVE' } });
  });

  it('enforces aalex provisioning cap', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({
          adminUserId,
          userId,
          requiredDatabaseName: dbName,
          maxAmountAtomic: '999999999',
        }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'over-cap',
        },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', details: { reason: 'AMOUNT_OVER_CAP' } });
  });

  it('rejects aalex absolute ceiling on configured max', async () => {
    await expect(
      provisionPhase10TestnetAvailable(
        pool,
        aalexConfig({
          adminUserId,
          userId,
          requiredDatabaseName: dbName,
          maxAmountAtomic: '10000000001',
        }),
        {
          operationId: randomUUID(),
          userId,
          amountAtomic: '1000000000',
          reason: 'ceiling',
        },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION',
      details: { reason: 'AALEX_PROVISION_CEILING_EXCEEDED' },
    });
  });

  it('prevents duplicate aalex provision via same operationId', async () => {
    const cfg = aalexConfig({ adminUserId, userId, requiredDatabaseName: dbName });
    const operationId = randomUUID();
    const first = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '1000000000',
      reason: 'dup',
    });
    const second = await provisionPhase10TestnetAvailable(pool, cfg, {
      operationId,
      userId,
      amountAtomic: '1000000000',
      reason: 'dup',
    });
    expect(second.created).toBe(false);
    expect(second.ledgerTransactionId).toBe(first.ledgerTransactionId);
    const count = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM ledger_transactions
       WHERE business_reference_type = 'phase10-testnet-available-provision'`,
    );
    expect(count.rows[0]?.c).toBe(1);
  });

  it('USDT provision path remains unchanged beside requiredDatabaseName default', async () => {
    const usdt = await pool.query<{ id: string }>(
      `SELECT id FROM assets WHERE symbol = 'USDT'
       AND network_id = (SELECT id FROM networks WHERE code = 'TON_TESTNET')`,
    );
    const assetId = usdt.rows[0]?.id;
    if (assetId === undefined) throw new Error('USDT missing');

    const result = await provisionPhase10TestnetAvailable(
      pool,
      {
        enabled: true,
        deploymentEnv: 'test',
        withdrawalNetworkCode: 'TON_TESTNET',
        withdrawalAssetSymbol: 'USDT',
        allowedUserId: userId,
        maxAmountAtomic: '1000000',
        ownerAdminUserId: adminUserId,
        requiredDatabaseName: '',
      },
      {
        operationId: randomUUID(),
        userId,
        amountAtomic: '250000',
        reason: 'usdt-regression',
      },
    );
    expect(result.created).toBe(true);
    expect(result.assetId).toBe(assetId);
  });
});
