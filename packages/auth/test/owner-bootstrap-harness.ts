/**
 * Shared helpers for M1 owner-bootstrap isolated DB suites.
 * Forces numeric loopback in URL (S-03: "localhost" label is not loopback proof).
 */
import { Client, type Pool } from 'pg';

import {
  assertConnectedDestructiveTestDatabase,
  assertSafeDestructiveTestDatabaseUrl,
  migrateDatabase,
} from '@alex-rewards/db';
import {
  buildIsolatedTestEndpointProfile,
  createBootstrapTrustMaterial,
  createOwnerBootstrapPool,
  setIsolatedTestBootstrapClock,
  clearIsolatedTestBootstrapClock,
  type BootstrapTrustMaterial,
  type CeremonyAuthority,
  type OwnerBootstrapPool,
} from '../src/owner-bootstrap/index.js';

export function dbNameFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

/** Rewrite host DNS labels to 127.0.0.1 so isolated_test plaintext pool accepts the URL. */
export function forceNumericLoopbackUrl(url: string): string {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1') {
    u.hostname = '127.0.0.1';
  }
  return u.toString();
}

export function requireSecurityGateDatabaseUrl(url: string, suite: string): void {
  if (process.env.M1_CI_SECURITY_GATE === '1' && url.trim() === '') {
    throw new Error(
      `${suite}: M1_CI_SECURITY_GATE=1 requires OWNER_ADMIN_AUTH_DATABASE_URL / M0_DATABASE_URL / PHASE7_DATABASE_URL`,
    );
  }
}

export async function resetIsolatedBootstrapSchema(url: string): Promise<void> {
  assertSafeDestructiveTestDatabaseUrl(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertConnectedDestructiveTestDatabase(client);
    const live = await client.query<{ current_database: string }>(`SELECT current_database()`);
    const name = live.rows[0]?.current_database ?? '';
    if (name === 'alex_rewards' || name !== dbNameFromUrl(url)) {
      throw new Error(`REFUSE reset: ${name}`);
    }
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

export async function openBootstrapTestPool(input: {
  readonly databaseUrl: string;
  readonly profileId: string;
  readonly authority: CeremonyAuthority;
}): Promise<{
  readonly bootstrap: OwnerBootstrapPool;
  readonly trust: BootstrapTrustMaterial;
  readonly expectedDatabase: string;
}> {
  const loopbackUrl = forceNumericLoopbackUrl(input.databaseUrl);
  const expectedDatabase = dbNameFromUrl(loopbackUrl);
  if (expectedDatabase === 'alex_rewards') {
    throw new Error('REFUSE operational database');
  }
  const profile = buildIsolatedTestEndpointProfile({
    profileId: input.profileId,
    expectedDatabaseName: expectedDatabase,
  });
  const bootstrap = await createOwnerBootstrapPool({
    connectionString: loopbackUrl,
    profile,
  });
  const trust = createBootstrapTrustMaterial(
    bootstrap,
    new Map([[input.authority.keyId, input.authority.publicKey]]),
  );
  return { bootstrap, trust, expectedDatabase };
}

/** Deterministic isolated-test clock (requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1). */
export function setTestClock(pool: Pool, nowSec: number): void {
  setIsolatedTestBootstrapClock(pool, nowSec);
}

export function clearTestClock(pool: Pool): void {
  clearIsolatedTestBootstrapClock(pool);
}
