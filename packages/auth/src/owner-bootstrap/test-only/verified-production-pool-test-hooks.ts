/**
 * Test-only verified production bootstrap pool registration.
 * NOT part of public package API. Requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1.
 */
import type { Pool } from 'pg';

import { AuthDomainError } from '../../errors.js';
import {
  registerVerifiedProductionOwnerBootstrapPoolForTests as registerImpl,
  type OwnerBootstrapPool,
} from '../pool.js';

function requireTestHooks(): void {
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'verified production pool test hooks require ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
    );
  }
}

export function registerVerifiedProductionOwnerBootstrapPoolForTests(input: {
  readonly pool: Pool;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly tlsServerName?: string;
}): OwnerBootstrapPool {
  requireTestHooks();
  return registerImpl(input);
}
