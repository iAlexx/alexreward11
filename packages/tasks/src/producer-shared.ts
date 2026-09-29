import type { Pool, PoolClient } from 'pg';

export async function withMissionProducerTx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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

export interface MissionProducerBatchResult {
  readonly examined: number;
  readonly contributed: number;
  readonly alreadyContributed: number;
  readonly ignored: number;
  readonly errors: number;
}

export function emptyProducerBatchResult(): {
  examined: number;
  contributed: number;
  alreadyContributed: number;
  ignored: number;
  errors: number;
} {
  return {
    examined: 0,
    contributed: 0,
    alreadyContributed: 0,
    ignored: 0,
    errors: 0,
  };
}

export function tallyContributeOutcome(
  result: {
    examined: number;
    contributed: number;
    alreadyContributed: number;
    ignored: number;
    errors: number;
  },
  outcome: string,
): void {
  result.examined += 1;
  if (outcome === 'CONTRIBUTED') result.contributed += 1;
  else if (outcome === 'ALREADY_CONTRIBUTED') result.alreadyContributed += 1;
  else result.ignored += 1;
}
