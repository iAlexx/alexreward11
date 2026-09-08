/**
 * Shared Phase 4 ledger test helpers.
 * Destructive against PHASE4_DATABASE_URL (or PHASE4_LEDGER_TESTS=1 + DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';

import { Client } from 'pg';
import type { Pool } from 'pg';

import { migrateDatabase } from '@alex-rewards/db';

import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
  type PostedLedgerTransaction,
} from '../src/index.js';

const explicitUrl = process.env.PHASE4_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE4_LEDGER_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase4DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export async function resetAndMigrate(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

export async function createTestUser(pool: Pool, telegramUserId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, preferred_locale)
     VALUES ($1::bigint, 'en')
     RETURNING id`,
    [telegramUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return id;
}

export async function usdtAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('USDT asset missing');
  return id;
}

export async function tonAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'TON'`);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('TON asset missing');
  return id;
}

export async function balanceOf(pool: Pool, accountId: string): Promise<bigint> {
  const result = await pool.query<{ balance_atomic: string; version: string }>(
    `SELECT balance_atomic::text AS balance_atomic, version::text AS version
     FROM ledger_account_balances WHERE ledger_account_id = $1`,
    [accountId],
  );
  return BigInt(result.rows[0]?.balance_atomic ?? '0');
}

export async function versionOf(pool: Pool, accountId: string): Promise<bigint> {
  const result = await pool.query<{ version: string }>(
    `SELECT version::text AS version FROM ledger_account_balances WHERE ledger_account_id = $1`,
    [accountId],
  );
  return BigInt(result.rows[0]?.version ?? '0');
}

export async function issuePendingReward(input: {
  pool: Pool;
  userId: string;
  assetId: string;
  amount: string;
  key: string;
  scope?: string;
}): Promise<{
  tx: PostedLedgerTransaction;
  pendingId: string;
  expenseId: string;
}> {
  return withLedgerTransaction(input.pool, async (client) => {
    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'PLATFORM_REWARD_EXPENSE',
      assetId: input.assetId,
    });
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId: input.assetId,
      ownerId: input.userId,
    });
    const tx = await postLedgerTransaction(client, {
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'phase4-test-reward',
      businessReferenceId: randomUUID(),
      idempotencyScope: input.scope ?? 'phase4-test',
      idempotencyKey: input.key,
      assetId: input.assetId,
      entries: [
        {
          ledgerAccountId: expense.id,
          direction: 'DEBIT',
          amountAtomic: input.amount,
        },
        {
          ledgerAccountId: pending.id,
          direction: 'CREDIT',
          amountAtomic: input.amount,
        },
      ],
    });
    return { tx, pendingId: pending.id, expenseId: expense.id };
  });
}

export async function maturePending(input: {
  pool: Pool;
  userId: string;
  assetId: string;
  amount: string;
  key: string;
}): Promise<{ availableId: string; pendingId: string; tx: PostedLedgerTransaction }> {
  return withLedgerTransaction(input.pool, async (client) => {
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId: input.assetId,
      ownerId: input.userId,
    });
    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId: input.assetId,
      ownerId: input.userId,
    });
    const tx = await postLedgerTransaction(client, {
      transactionType: 'REWARD_MATURITY',
      businessReferenceType: 'phase4-test-maturity',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase4-test',
      idempotencyKey: input.key,
      assetId: input.assetId,
      entries: [
        { ledgerAccountId: pending.id, direction: 'DEBIT', amountAtomic: input.amount },
        { ledgerAccountId: available.id, direction: 'CREDIT', amountAtomic: input.amount },
      ],
    });
    return { tx, availableId: available.id, pendingId: pending.id };
  });
}
