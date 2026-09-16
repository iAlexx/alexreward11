import { describe, expect, it } from 'vitest';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  databaseNameFromConnectionString,
  isApprovedDestructiveTestDatabaseName,
} from '../src/destructive-test-db.js';

describe('destructive-test-db guard', () => {
  it('parses database name with installed pg connection-string semantics', () => {
    expect(
      databaseNameFromConnectionString(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards_test',
      ),
    ).toBe('alex_rewards_test');
    expect(
      databaseNameFromConnectionString(
        'postgresql://alex_rewards:local@127.0.0.1:5432/alex_rewards_phase2',
      ),
    ).toBe('alex_rewards_phase2');
  });

  it('approves _test and _phaseN names only', () => {
    expect(isApprovedDestructiveTestDatabaseName('alex_rewards_test')).toBe(true);
    expect(isApprovedDestructiveTestDatabaseName('alex_rewards_phase2')).toBe(true);
    expect(isApprovedDestructiveTestDatabaseName('alex_rewards_phase10_test')).toBe(true);
    expect(isApprovedDestructiveTestDatabaseName('alex_rewards')).toBe(false);
    expect(isApprovedDestructiveTestDatabaseName('postgres')).toBe(false);
  });

  it('refuses operational alex_rewards in URL path', () => {
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards',
      ),
    ).toThrow(/REFUSE:.*alex_rewards/);
  });

  it('refuses safe path with ?database=alex_rewards override', () => {
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards_test?database=alex_rewards',
      ),
    ).toThrow(/conflicts with query override/);
  });

  it('refuses ambiguous db / dbname overrides that disagree with the path', () => {
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards_test?dbname=alex_rewards',
      ),
    ).toThrow(/conflicts with query override/);
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards_test?db=alex_rewards',
      ),
    ).toThrow(/conflicts with query override/);
  });

  it('refuses conflicting or malformed connection strings', () => {
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards_test?database=a_test&dbname=b_test',
      ),
    ).toThrow(/conflicting database query overrides/);
    expect(() =>
      databaseNameFromConnectionString('host=127.0.0.1 dbname=alex_rewards_test user=u'),
    ).toThrow(/malformed|invalid|missing/i);
    expect(() => databaseNameFromConnectionString('')).toThrow(/empty/);
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/postgres',
      ),
    ).toThrow(/not approved/);
  });

  it('refuses missing or unapproved database names', () => {
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl('postgresql://alex_rewards:local@127.0.0.1:55432/'),
    ).toThrow(/missing a database name|not approved|malformed/i);
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/not_allowed_db',
      ),
    ).toThrow(/not approved/);
  });

  it('allows CI phase DB and local _test DB', () => {
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:5432/alex_rewards_phase2',
      ),
    ).not.toThrow();
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards_test',
      ),
    ).not.toThrow();
  });

  it('connected current_database guard refuses operational and unapproved names', async () => {
    await expect(
      assertConnectedDestructiveTestDatabase({
        query: async () => ({ rows: [{ current_database: 'alex_rewards' }] }),
      }),
    ).rejects.toThrow(/REFUSE:.*alex_rewards/);
    await expect(
      assertConnectedDestructiveTestDatabase({
        query: async () => ({ rows: [{ current_database: 'postgres' }] }),
      }),
    ).rejects.toThrow(/not approved/);
    await expect(
      assertConnectedDestructiveTestDatabase({
        query: async () => ({ rows: [{ current_database: '' }] }),
      }),
    ).rejects.toThrow(/missing a database name/);
  });

  it('connected current_database guard accepts approved test names', async () => {
    await expect(
      assertConnectedDestructiveTestDatabase({
        query: async () => ({ rows: [{ current_database: 'alex_rewards_test' }] }),
      }),
    ).resolves.toBe('alex_rewards_test');
    await expect(
      assertConnectedDestructiveTestDatabase({
        query: async () => ({ rows: [{ current_database: 'alex_rewards_phase2' }] }),
      }),
    ).resolves.toBe('alex_rewards_phase2');
  });

  it('refuses when connected database differs from an approved URL expectation', async () => {
    // URL validates as test DB, but the live session is operational — fail closed.
    assertSafeDestructiveTestDatabaseUrl(
      'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards_test',
    );
    await expect(
      assertConnectedDestructiveTestDatabase({
        query: async () => ({ rows: [{ current_database: 'alex_rewards' }] }),
      }),
    ).rejects.toThrow(/REFUSE:.*alex_rewards/);
  });
});
