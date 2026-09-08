import type { Pool, PoolClient } from 'pg';

export type LedgerDb = Pool | PoolClient;

export function isPool(db: LedgerDb): db is Pool {
  return typeof (db as Pool).connect === 'function' && !('release' in db);
}

/**
 * Run work inside a PostgreSQL transaction.
 * - When given a Pool, opens BEGIN/COMMIT/ROLLBACK.
 * - When given a PoolClient, assumes the caller already owns the transaction
 *   (domain + ledger + outbox composition).
 */
export async function withLedgerTransaction<T>(
  db: LedgerDb,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!isPool(db)) {
    return fn(db);
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure; original error is authoritative
    }
    throw error;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
