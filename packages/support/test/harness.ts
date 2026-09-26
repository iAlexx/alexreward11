/**
 * Shared Phase 12 support test helpers.
 * Destructive against PHASE12_SUPPORT_DATABASE_URL (or PHASE12_SUPPORT_TESTS=1 + DATABASE_URL).
 */
import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, type Pool } from 'pg';

const explicitUrl = process.env.PHASE12_SUPPORT_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE12_SUPPORT_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase12SupportDatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

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
