import { afterEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import {
  AuthDomainError,
  assertOwnerAdminAuthDatabaseWritable,
  assertOwnerAdminAuthDatabaseWritableForProductionCeremony,
  registerVerifiedProductionOwnerBootstrapPoolForTests,
  requireVerifiedProductionOwnerBootstrapPool,
  verifyOwnerAdminPasswordAndTotp,
  verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool,
} from '../src/index.js';

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

describe('production ceremony owner auth gate (Step 4C.1)', () => {
  const prev: Record<string, string | undefined> = {};
  const keys = ['ALEX_OWNER_BOOTSTRAP_TEST_HOOKS', 'DEPLOYMENT_ENV'] as const;

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function snap(): void {
    for (const k of keys) prev[k] = process.env[k];
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

  it('2-4. production ceremony gate requires WeakMap verified production verify_full pool', async () => {
    snap();
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    process.env.DEPLOYMENT_ENV = 'production';
    const pool = mockPool('railway', '12345');

    expect(() => requireVerifiedProductionOwnerBootstrapPool(pool)).toThrow(/FORBIDDEN|verified/);

    const verified = registerVerifiedProductionOwnerBootstrapPoolForTests({
      pool,
      databaseName: 'railway',
      systemIdentifier: '12345',
    });
    const bound = requireVerifiedProductionOwnerBootstrapPool(pool);
    expect(bound).toBe(verified);

    const gate = await assertOwnerAdminAuthDatabaseWritableForProductionCeremony(
      pool,
      { expectedDatabase: 'railway', expectedClusterSystemIdentifier: '12345' },
      verified,
    );
    expect(gate.currentDatabase).toBe('railway');

    const forged = { ...verified, database: 'forged' };
    await expect(
      assertOwnerAdminAuthDatabaseWritableForProductionCeremony(
        pool,
        { expectedDatabase: 'railway', expectedClusterSystemIdentifier: '12345' },
        forged as never,
      ),
    ).rejects.toBeInstanceOf(AuthDomainError);
  });

  it('arbitrary Pool refused by production verifier entry', async () => {
    snap();
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    process.env.DEPLOYMENT_ENV = 'production';
    const pool = mockPool('railway', '1');
    await expect(
      verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool(pool, {
        adminUserId: '11111111-1111-4111-8111-111111111111',
        password: 'x',
        totpCode: '123456',
        expectedDatabase: 'railway',
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
