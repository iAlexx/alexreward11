import { performance } from 'node:perf_hooks';

import { Pool } from 'pg';

export interface DatabaseProbeResult {
  readonly latencyMs: number;
}

export function createDatabasePool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    application_name: 'alex-rewards',
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: false,
  });
}

export async function probeDatabase(pool: Pool): Promise<DatabaseProbeResult> {
  const started = performance.now();
  await pool.query('SELECT 1 AS healthy');
  return { latencyMs: Math.round(performance.now() - started) };
}

export type { Pool } from 'pg';
