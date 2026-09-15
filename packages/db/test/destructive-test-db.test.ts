import { describe, expect, it } from 'vitest';

import {
  assertSafeDestructiveTestDatabaseUrl,
  databaseNameFromConnectionString,
  isApprovedDestructiveTestDatabaseName,
} from '../src/destructive-test-db.js';

describe('destructive-test-db guard', () => {
  it('parses database name from postgres URLs', () => {
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

  it('refuses operational alex_rewards', () => {
    expect(() =>
      assertSafeDestructiveTestDatabaseUrl(
        'postgresql://alex_rewards:local@127.0.0.1:55432/alex_rewards',
      ),
    ).toThrow(/REFUSE:.*alex_rewards/);
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
});
