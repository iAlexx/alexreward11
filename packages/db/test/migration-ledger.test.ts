/**
 * Migration ledger hardening + Phase 13 legacy marker repair.
 *
 * Destructive against an isolated throwaway DB only:
 *   MIGRATE_LEDGER_DATABASE_URL or PHASE2_DATABASE_URL (name ending _test / _phaseN).
 */
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  listMigrationFiles,
  migrateDatabase,
  repairPhase13LegacyMigrationMarkers,
} from '../src/index.js';

const databaseUrl =
  process.env.MIGRATE_LEDGER_DATABASE_URL ??
  process.env.PHASE2_DATABASE_URL ??
  (process.env.MIGRATE_LEDGER_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '');

const V31 = '0031_phase13_admin_webauthn_challenges';
const V32 = '0032_phase13_admin_web_confirmations';
const V33 = '0033_phase13_admin_webauthn_session_bind';

describe.skipIf(databaseUrl === '')('migration ledger repair', () => {
  let client: Client;

  async function resetPublicSchema(): Promise<void> {
    assertSafeDestructiveTestDatabaseUrl(databaseUrl);
    await assertConnectedDestructiveTestDatabase(client);
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  }

  beforeAll(async () => {
    assertSafeDestructiveTestDatabaseUrl(databaseUrl);
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await assertConnectedDestructiveTestDatabase(client);
  }, 60_000);

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await resetPublicSchema();
  }, 60_000);

  it('fresh DB applies all migrations and appliedTotal equals total count', async () => {
    const migrations = await listMigrationFiles();
    const first = await migrateDatabase(databaseUrl);
    expect(first.repairedLegacyMarkers).toEqual([]);
    expect(first.appliedNow.length).toBe(migrations.length);
    expect(first.appliedTotal).toBe(migrations.length);
    expect(first.totalMigrations).toBe(migrations.length);

    const versions = await client.query<{ version: string }>(
      `SELECT version FROM schema_migrations ORDER BY version`,
    );
    expect(versions.rows.map((r) => r.version)).toEqual(
      migrations.map((m) => m.version).sort((a, b) => a.localeCompare(b)),
    );
  }, 120_000);

  it('second migration run is idempotent (no re-execution failure)', async () => {
    const first = await migrateDatabase(databaseUrl);
    const second = await migrateDatabase(databaseUrl);
    expect(second.appliedNow).toEqual([]);
    expect(second.repairedLegacyMarkers).toEqual([]);
    expect(second.appliedTotal).toBe(first.appliedTotal);
    expect(second.previouslyApplied).toBe(first.appliedTotal);
  }, 120_000);

  it('successful migration without self-record still gets ledger marker from runner', async () => {
    // Apply through 0030 via full migrate, then delete 0031–0033 markers and drop
    // those objects to simulate a missing self-record on a later migration path.
    await migrateDatabase(databaseUrl);
    await client.query(`DELETE FROM schema_migrations WHERE version = ANY($1::text[])`, [
      [V31, V32, V33],
    ]);
    await client.query(`DROP TABLE IF EXISTS admin_web_confirmations CASCADE`);
    await client.query(`DROP TABLE IF EXISTS admin_webauthn_challenges CASCADE`);

    const result = await migrateDatabase(databaseUrl);
    expect(result.appliedNow).toEqual(expect.arrayContaining([V31, V32, V33]));
    const markers = await client.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = ANY($1::text[]) ORDER BY version`,
      [[V31, V32, V33]],
    );
    expect(markers.rows.map((r) => r.version)).toEqual([V31, V32, V33]);
  }, 120_000);

  it('existing self-recording migration remains harmless on re-record', async () => {
    await migrateDatabase(databaseUrl);
    // Runner would ON CONFLICT DO NOTHING — simulate explicit second insert.
    await expect(
      client.query(
        `INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
        ['0001_extensions_enums'],
      ),
    ).resolves.toBeDefined();
    const count = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM schema_migrations WHERE version = '0001_extensions_enums'`,
    );
    expect(count.rows[0]?.c).toBe(1);
  }, 120_000);

  it('known 0031/0032/0033 schema present + markers missing => safe backfill', async () => {
    await migrateDatabase(databaseUrl);
    await client.query(`DELETE FROM schema_migrations WHERE version = ANY($1::text[])`, [
      [V31, V32, V33],
    ]);

    const repaired = await repairPhase13LegacyMigrationMarkers(client);
    expect(repaired).toEqual([V31, V32, V33]);

    const second = await migrateDatabase(databaseUrl);
    expect(second.appliedNow).toEqual([]);
    expect(second.repairedLegacyMarkers).toEqual([]);
    expect(second.appliedTotal).toBe(second.totalMigrations);
  }, 120_000);

  it('partial known schema => FAIL CLOSED', async () => {
    await migrateDatabase(databaseUrl);
    await client.query(`DELETE FROM schema_migrations WHERE version = $1`, [V31]);
    // Drop a required index to make 0031 partial while the table remains.
    await client.query(`DROP INDEX IF EXISTS admin_webauthn_challenges_admin_active_idx`);

    await expect(repairPhase13LegacyMigrationMarkers(client)).rejects.toThrow(
      /partial|inconsistent|0031/i,
    );
  }, 120_000);
});
