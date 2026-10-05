/**
 * P19-SEC-015 concurrency proof: feature_flag_versions UNIQUE prevents dual N+1 commits.
 * Destructive against PHASE19 / OWNER_ADMIN / PHASE2 disposable URL.
 */
import { randomUUID } from 'node:crypto';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbUrl =
  process.env.PHASE19_SECURITY_DATABASE_URL ??
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.PHASE2_DATABASE_URL ??
  (process.env.PHASE19_FEATURE_FLAG_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '');

async function resetAndMigrate(url: string): Promise<void> {
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

describe.skipIf(dbUrl === '')('P19-SEC-015 feature flag concurrent version (DB)', () => {
  let pool: Pool;

  beforeAll(async () => {
    await resetAndMigrate(dbUrl);
    pool = new Pool({ connectionString: dbUrl, max: 8 });
  }, 180_000);

  afterAll(async () => {
    await pool.end();
  });

  it('two concurrent writers on same version: at most one commits N+1; loser rolls back UPDATE', async () => {
    const flagKey = `P19_CONCUR_${randomUUID().slice(0, 8)}`;
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO feature_flags (flag_key, environment, enabled, description)
       VALUES ($1, 'LOCAL', false, 'p19 concurrency')
       RETURNING id`,
      [flagKey],
    );
    const flagId = inserted.rows[0]!.id;
    await pool.query(
      `INSERT INTO feature_flag_versions (
         feature_flag_id, flag_version, old_enabled, new_enabled, reason, changed_by_admin_id
       ) VALUES ($1::uuid, 1, NULL, false, 'seed', NULL)`,
      [flagId],
    );

    async function attemptFlip(enabled: boolean): Promise<'ok' | 'fail'> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE feature_flags SET enabled = $2, updated_at = now() WHERE id = $1::uuid`,
          [flagId, enabled],
        );
        await client.query(
          `INSERT INTO feature_flag_versions (
             feature_flag_id, flag_version, old_enabled, new_enabled, reason, changed_by_admin_id
           ) VALUES ($1::uuid, 2, false, $2, 'concurrent', NULL)`,
          [flagId, enabled],
        );
        await client.query('COMMIT');
        return 'ok';
      } catch {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        return 'fail';
      } finally {
        client.release();
      }
    }

    const [a, b] = await Promise.all([attemptFlip(true), attemptFlip(true)]);
    const oks = [a, b].filter((x) => x === 'ok').length;
    expect(oks).toBe(1);

    const versions = await pool.query<{ flag_version: number }>(
      `SELECT flag_version FROM feature_flag_versions WHERE feature_flag_id = $1::uuid ORDER BY flag_version`,
      [flagId],
    );
    expect(versions.rows.map((r) => Number(r.flag_version))).toEqual([1, 2]);

    const flag = await pool.query<{ enabled: boolean }>(
      `SELECT enabled FROM feature_flags WHERE id = $1::uuid`,
      [flagId],
    );
    expect(flag.rows[0]?.enabled).toBe(true);
  });
});
