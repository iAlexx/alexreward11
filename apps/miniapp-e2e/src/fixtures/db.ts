import { randomUUID } from 'node:crypto';

import { Client, Pool } from 'pg';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '@alex-rewards/ledger';
import { generateClaimCode, hashClaimCode } from '@alex-rewards/auth';
import {
  LOCKED_INITIAL_WITHDRAWAL,
  seedLockedInitialWithdrawalRules,
} from '@alex-rewards/withdrawals';

import {
  FOUNDER_NUMBER,
  PHASE12_E2E_FLAG,
  resolvePhase12DatabaseUrlFromEnv,
  SEED_BALANCES,
  TELEGRAM_IDS,
} from '../env.js';
import { defaultPublicSeed, writePublicSeed, writeSecrets } from './seed-meta.js';

export function requirePhase12E2eEnabled(): void {
  if (process.env[PHASE12_E2E_FLAG] !== '1') {
    throw new Error('REFUSE: Phase 12 browser E2E requires PHASE12_E2E=1');
  }
}

export function resolvePhase12DatabaseUrl(): string {
  return resolvePhase12DatabaseUrlFromEnv();
}

async function ensureDatabaseExists(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const parsed = new URL(url);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, '').split('/')[0] ?? '');
  if (dbName === '') throw new Error('PHASE12_DATABASE_URL missing database name');

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const existing = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists`,
      [dbName],
    );
    if (existing.rows[0]?.exists !== true) {
      await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
    }
  } finally {
    await client.end();
  }
}

function quoteIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(ident)) {
    throw new Error(`REFUSE: unsafe database identifier "${ident}"`);
  }
  return `"${ident.replaceAll('"', '""')}"`;
}

export async function resetAndMigrate(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

async function usdtAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('USDT asset missing after migrate');
  return id;
}

async function tonTestnetNetworkId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM networks WHERE code = 'TON_TESTNET'`,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('TON_TESTNET network missing after migrate');
  return id;
}

async function insertUser(pool: Pool, telegramUserId: string, username: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, username, first_name, preferred_locale, status, withdrawal_status)
     VALUES ($1::bigint, $2, $3, 'en', 'ACTIVE', 'ALLOWED')
     RETURNING id`,
    [telegramUserId, username, 'Phase12'],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  await pool.query(
    `INSERT INTO user_settings (user_id, locale, public_payout_identity_mode)
     VALUES ($1::uuid, 'en', 'SHOW_USERNAME')
     ON CONFLICT (user_id) DO NOTHING`,
    [id],
  );
  return id;
}

async function seedLedgerBuckets(pool: Pool, userId: string, assetId: string): Promise<void> {
  const availableTarget = BigInt(SEED_BALANCES.available);
  const pendingTarget = BigInt(SEED_BALANCES.pending);
  const reservedTarget = BigInt(SEED_BALANCES.reserved);
  const grossAvailable = availableTarget + reservedTarget;

  await withLedgerTransaction(pool, async (client) => {
    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'PLATFORM_REWARD_EXPENSE',
      assetId,
    });
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId,
      ownerId: userId,
    });
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
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'phase12-e2e-pending',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase12-e2e',
      idempotencyKey: 'pending-issue',
      assetId,
      entries: [
        {
          ledgerAccountId: expense.id,
          direction: 'DEBIT',
          amountAtomic: pendingTarget.toString(10),
        },
        {
          ledgerAccountId: pending.id,
          direction: 'CREDIT',
          amountAtomic: pendingTarget.toString(10),
        },
      ],
    });

    await postLedgerTransaction(client, {
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'phase12-e2e-available-issue',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase12-e2e',
      idempotencyKey: 'available-issue',
      assetId,
      entries: [
        {
          ledgerAccountId: expense.id,
          direction: 'DEBIT',
          amountAtomic: grossAvailable.toString(10),
        },
        {
          ledgerAccountId: pending.id,
          direction: 'CREDIT',
          amountAtomic: grossAvailable.toString(10),
        },
      ],
    });
    await postLedgerTransaction(client, {
      transactionType: 'REWARD_MATURITY',
      businessReferenceType: 'phase12-e2e-available-mature',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase12-e2e',
      idempotencyKey: 'available-mature',
      assetId,
      entries: [
        {
          ledgerAccountId: pending.id,
          direction: 'DEBIT',
          amountAtomic: grossAvailable.toString(10),
        },
        {
          ledgerAccountId: available.id,
          direction: 'CREDIT',
          amountAtomic: grossAvailable.toString(10),
        },
      ],
    });

    await postLedgerTransaction(client, {
      transactionType: 'WITHDRAWAL_RESERVATION',
      businessReferenceType: 'phase12-e2e-reserve',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase12-e2e',
      idempotencyKey: 'reserve',
      assetId,
      entries: [
        {
          ledgerAccountId: available.id,
          direction: 'DEBIT',
          amountAtomic: reservedTarget.toString(10),
        },
        {
          ledgerAccountId: reserved.id,
          direction: 'CREDIT',
          amountAtomic: reservedTarget.toString(10),
        },
      ],
    });
  });
}

async function bindVerifiedWallet(pool: Pool, userId: string, networkId: string): Promise<string> {
  const suffix = randomUUID().replace(/-/g, '');
  const raw = `0:${suffix}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const friendly = `EQ${raw.slice(2, 50)}`;
  const result = await pool.query<{ id: string; friendly_address: string }>(
    `INSERT INTO user_wallets (
       user_id, network_id, chain, raw_address, friendly_address,
       is_primary, verified, verification_method, verified_at, became_primary_at
     ) VALUES (
       $1::uuid, $2::uuid, 'TON', $3, $4,
       true, true, 'TON_PROOF', now(), now()
     )
     RETURNING id, friendly_address`,
    [userId, networkId, raw, friendly],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('wallet insert failed');
  return row.friendly_address;
}

async function ensureIssuerAdmin(pool: Pool): Promise<string> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM admin_users WHERE email = 'phase12-e2e-issuer@local.test'`,
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status)
     VALUES ('phase12-e2e-issuer@local.test', 'Phase 12 E2E Issuer', 'ACTIVE')
     RETURNING id`,
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error('admin insert failed');
  return id;
}

async function insertOpenClaimCode(
  pool: Pool,
  adminId: string,
  reservedNumber: number,
): Promise<string> {
  const raw = generateClaimCode(24);
  const hash = hashClaimCode(raw);
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  await pool.query(
    `INSERT INTO membership_claim_codes (
       code_hash, membership_plan_id, created_by_admin_id, expires_at, founder_number_reserved
     ) VALUES ($1, $2, $3, NULL, $4)`,
    [hash, planId, adminId, reservedNumber],
  );
  return raw;
}

async function ensureHotWallet(pool: Pool, networkId: string): Promise<void> {
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM hot_wallets
     WHERE network_id = $1::uuid AND status = 'ACTIVE' AND signer_reference LIKE 'TEST_ONLY_FAKE%'`,
    [networkId],
  );
  if (existing.rows[0] !== undefined) return;
  const address = `0:hot${randomUUID().replace(/-/g, '')}`;
  await pool.query(
    `INSERT INTO hot_wallets (
       network_id, address, friendly_address, wallet_version,
       signer_type, signer_reference, status, payout_jetton_wallet_address, label
     ) VALUES (
       $1::uuid, $2, $3, 'v5R1',
       'KMS', 'TEST_ONLY_FAKE_HOT_P12_E2E', 'ACTIVE', $4, 'phase12-e2e-hot'
     )`,
    [networkId, address, `EQ${address.slice(2, 50)}`, `0:jetton${randomUUID().replace(/-/g, '')}`],
  );
}

/**
 * Destructive reset + migrate + fixture seed for Phase 12 browser E2E.
 * Does not log claim codes or session secrets.
 */
export async function preparePhase12E2eDatabase(): Promise<void> {
  requirePhase12E2eEnabled();
  const url = resolvePhase12DatabaseUrl();
  await ensureDatabaseExists(url);
  await resetAndMigrate(url);

  const pool = new Pool({ connectionString: url });
  try {
    await assertConnectedDestructiveTestDatabase(pool);
    const assetId = await usdtAssetId(pool);
    const networkId = await tonTestnetNetworkId(pool);

    await withLedgerTransaction(pool, async (client) => {
      await seedLockedInitialWithdrawalRules(client, { assetId, networkId });
    });
    await ensureHotWallet(pool, networkId);

    const standardUserId = await insertUser(pool, TELEGRAM_IDS.standard, 'phase12_standard');
    await insertUser(pool, TELEGRAM_IDS.founder, 'phase12_founder');
    await insertUser(pool, TELEGRAM_IDS.other, 'phase12_other');

    await seedLedgerBuckets(pool, standardUserId, assetId);
    const friendlyAddress = await bindVerifiedWallet(pool, standardUserId, networkId);

    const adminId = await ensureIssuerAdmin(pool);
    const founderClaimCode = await insertOpenClaimCode(pool, adminId, FOUNDER_NUMBER);

    writePublicSeed(defaultPublicSeed(friendlyAddress));
    writeSecrets({ founderClaimCode });

    // Confirm LOCKED fee matches seed expectations without logging secrets.
    if (LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic !== 10_000n) {
      throw new Error('REFUSE: unexpected LOCKED_INITIAL_WITHDRAWAL.fixedFeeAtomic for e2e');
    }
  } finally {
    await pool.end();
  }
}
