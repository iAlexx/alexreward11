/**
 * Test-only verified production bootstrap pool registration.
 * NOT part of the public @alex-rewards/auth package root API.
 *
 * Requires ALL of:
 * - NODE_ENV=test
 * - ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1
 * - ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM=1
 * - approved isolated destructive-test DB name (*_test / *_phaseN)
 *
 * Refuses railway, alex_rewards, and other operational / production-like names.
 * Real production WeakMap registration remains createProductionOwnerBootstrapPool only.
 */
import type { Pool } from 'pg';

import { isApprovedDestructiveTestDatabaseName } from '@alex-rewards/db';

import { AuthDomainError } from '../../errors.js';
import {
  __bindVerifiedProductionOwnerBootstrapPoolForTestHooks,
  type BootstrapConnectionFacts,
  type OwnerBootstrapPool,
} from '../pool.js';
import type { BootstrapEndpointProfile } from '../endpoint.js';

const OPERATIONAL_LIKE = new Set([
  'railway',
  'alex_rewards',
  'postgres',
  'production',
  'prod',
]);

function requireDualTestGates(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'verified production pool test helper requires NODE_ENV=test',
    );
  }
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'verified production pool test helper requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
    );
  }
  if (process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM !== '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'verified production pool test helper requires ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM=1',
    );
  }
}

function assertApprovedIsolatedTestDatabaseName(databaseName: string): string {
  const trimmed = databaseName.trim();
  const normalized = trimmed.toLowerCase();
  if (trimmed === '' || OPERATIONAL_LIKE.has(normalized)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'verified production pool test helper refuses operational / production-like database names',
      { details: { databaseRedacted: normalized === '' ? '(empty)' : normalized } },
    );
  }
  if (!isApprovedDestructiveTestDatabaseName(trimmed)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'verified production pool test helper requires approved isolated *_test / *_phaseN database name',
      { details: { databaseRedacted: normalized } },
    );
  }
  return trimmed;
}

/**
 * Register a synthetic production verify_full OwnerBootstrapPool into the same
 * WeakMap used by createProductionOwnerBootstrapPool — test-only, dual-gated.
 */
export function registerVerifiedProductionOwnerBootstrapPoolForTests(input: {
  readonly pool: Pool;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly tlsServerName?: string;
}): OwnerBootstrapPool {
  requireDualTestGates();
  const databaseName = assertApprovedIsolatedTestDatabaseName(input.databaseName);
  const systemIdentifier = input.systemIdentifier.trim();
  if (systemIdentifier === '') {
    throw new AuthDomainError(
      'VALIDATION',
      'registerVerifiedProductionOwnerBootstrapPoolForTests requires systemIdentifier',
    );
  }
  const tlsServerName = (input.tlsServerName ?? 'test-production.local').trim();
  const profile: BootstrapEndpointProfile = {
    profileId: 'test-production-verify-full-sim',
    deploymentEnv: 'production',
    expectedDatabaseName: databaseName,
    expectedSystemIdentifier: systemIdentifier,
    tls: {
      mode: 'verify_full',
      caPem: '-----BEGIN CERTIFICATE-----\nTEST_ONLY_NOT_A_REAL_CA\n-----END CERTIFICATE-----\n',
      tlsServerName,
    },
  };
  const connectionFacts: BootstrapConnectionFacts = {
    hostname: '127.0.0.1',
    sslEnabled: true,
    currentDatabase: databaseName,
    clusterSystemIdentifier: systemIdentifier,
    serverAddr: '127.0.0.1',
    sslInUse: true,
  };
  const result: OwnerBootstrapPool = {
    pool: input.pool,
    connectionFacts,
    hostname: '127.0.0.1',
    database: databaseName,
    profile,
  };
  __bindVerifiedProductionOwnerBootstrapPoolForTestHooks(result);
  return result;
}
