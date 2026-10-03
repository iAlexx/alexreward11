import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  AuthDomainError,
  assertOwnerAdminAuthDatabaseWritable,
  assertOwnerAdminAuthDatabaseWritableForProductionCeremony,
  requireVerifiedProductionOwnerBootstrapPool,
  verifyOwnerAdminPasswordAndTotp,
  verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool,
} from '../src/index.js';
import { registerVerifiedProductionOwnerBootstrapPoolForTests } from '../src/owner-bootstrap/test-only/verified-production-pool-test-hooks.js';

function mockPool(currentDatabase: string, systemIdentifier: string): Pool {
  const pool = {
    connect: async () => ({
      query: async (text: string) => {
        if (text.includes('current_database')) {
          return { rows: [{ current_database: currentDatabase }] };
        }
        if (text.includes('pg_control_system') || text.includes('system_identifier')) {
          return { rows: [{ system_identifier: systemIdentifier }] };
        }
        return { rows: [] };
      },
      release() {},
    }),
    query: async (text: string) => {
      if (text.includes('current_database')) {
        return { rows: [{ current_database: currentDatabase }] };
      }
      if (text.includes('pg_control_system') || text.includes('system_identifier')) {
        return { rows: [{ system_identifier: systemIdentifier }] };
      }
      return { rows: [] };
    },
    end: async () => undefined,
  };
  return pool as unknown as Pool;
}

describe('production ceremony owner auth gate (Step 4C.1 / 4C.2)', () => {
  const prev: Record<string, string | undefined> = {};
  const keys = [
    'ALEX_OWNER_BOOTSTRAP_TEST_HOOKS',
    'ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM',
    'DEPLOYMENT_ENV',
    'NODE_ENV',
  ] as const;

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function snap(): void {
    for (const k of keys) prev[k] = process.env[k];
  }

  function enableDualGates(): void {
    process.env.NODE_ENV = 'test';
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
    process.env.DEPLOYMENT_ENV = 'production';
  }

  it('1. generic Owner auth still refuses operational-like DB names', async () => {
    const pool = mockPool('railway', '999');
    await expect(
      assertOwnerAdminAuthDatabaseWritable(pool, {
        expectedDatabase: 'railway',
        expectedClusterSystemIdentifier: '999',
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  });

  it('package root does not export test verified-pool registration helper', async () => {
    const root = await import('../src/index.js');
    expect(
      Object.prototype.hasOwnProperty.call(root, 'registerVerifiedProductionOwnerBootstrapPoolForTests'),
    ).toBe(false);
    expect(
      (root as Record<string, unknown>).registerVerifiedProductionOwnerBootstrapPoolForTests,
    ).toBeUndefined();
  });

  it('test helper refuses railway / operational-like DB names', () => {
    snap();
    enableDualGates();
    const pool = mockPool('railway', '12345');
    expect(() =>
      registerVerifiedProductionOwnerBootstrapPoolForTests({
        pool,
        databaseName: 'railway',
        systemIdentifier: '12345',
      }),
    ).toThrow(/FORBIDDEN|operational|production-like|approved/);
  });

  it('test helper refuses without NODE_ENV=test', () => {
    snap();
    process.env.NODE_ENV = 'production';
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
    const pool = mockPool('alex_rewards_phase21_test', '1');
    expect(() =>
      registerVerifiedProductionOwnerBootstrapPoolForTests({
        pool,
        databaseName: 'alex_rewards_phase21_test',
        systemIdentifier: '1',
      }),
    ).toThrow(/NODE_ENV=test/);
  });

  it('test helper refuses without both explicit test gates', () => {
    snap();
    process.env.NODE_ENV = 'test';
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    delete process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM;
    const pool = mockPool('alex_rewards_phase21_test', '1');
    expect(() =>
      registerVerifiedProductionOwnerBootstrapPoolForTests({
        pool,
        databaseName: 'alex_rewards_phase21_test',
        systemIdentifier: '1',
      }),
    ).toThrow(/DISPOSABLE_PRODUCTION_SIM/);

    process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
    delete process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS;
    expect(() =>
      registerVerifiedProductionOwnerBootstrapPoolForTests({
        pool,
        databaseName: 'alex_rewards_phase21_test',
        systemIdentifier: '1',
      }),
    ).toThrow(/TEST_HOOKS/);
  });

  it('2-4. production ceremony gate requires WeakMap verified production verify_full pool', async () => {
    snap();
    enableDualGates();
    const db = 'alex_rewards_phase21_test';
    const pool = mockPool(db, '12345');

    expect(() => requireVerifiedProductionOwnerBootstrapPool(pool)).toThrow(/FORBIDDEN|verified/);

    const verified = registerVerifiedProductionOwnerBootstrapPoolForTests({
      pool,
      databaseName: db,
      systemIdentifier: '12345',
    });
    const bound = requireVerifiedProductionOwnerBootstrapPool(pool);
    expect(bound).toBe(verified);

    const gate = await assertOwnerAdminAuthDatabaseWritableForProductionCeremony(
      pool,
      { expectedDatabase: db, expectedClusterSystemIdentifier: '12345' },
      verified,
    );
    expect(gate.currentDatabase).toBe(db);

    const forged = { ...verified, database: 'forged' };
    await expect(
      assertOwnerAdminAuthDatabaseWritableForProductionCeremony(
        pool,
        { expectedDatabase: db, expectedClusterSystemIdentifier: '12345' },
        forged as never,
      ),
    ).rejects.toBeInstanceOf(AuthDomainError);
  });

  it('arbitrary Pool refused by production verifier entry', async () => {
    snap();
    enableDualGates();
    const pool = mockPool('alex_rewards_phase21_test', '1');
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: '11111111-1111-4111-8111-111111111111',
        password: 'x',
        totpCode: '123456',
        expectedDatabase: 'alex_rewards_phase21_test',
        expectedClusterSystemIdentifier: '1',
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  });

  it('generic verifyOwnerAdminPasswordAndTotp remains blocked on operational name', async () => {
    const pool = mockPool('railway', '1');
    await expect(
      verifyOwnerAdminPasswordAndTotp(pool, {
        adminUserId: '11111111-1111-4111-8111-111111111111',
        password: 'x',
        totpCode: '123456',
        expectedDatabase: 'railway',
        expectedClusterSystemIdentifier: '1',
      }),
    ).rejects.toBeInstanceOf(AuthDomainError);
  });
});
