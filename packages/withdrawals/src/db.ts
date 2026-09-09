import type { Pool, PoolClient } from 'pg';

export type WithdrawalDb = Pool | PoolClient;

export function isPool(db: WithdrawalDb): db is Pool {
  return typeof (db as Pool).connect === 'function' && !('release' in db);
}

export async function withWithdrawalTransaction<T>(
  db: WithdrawalDb,
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
      // ignore
    }
    throw error;
  } finally {
    client.release();
  }
}
