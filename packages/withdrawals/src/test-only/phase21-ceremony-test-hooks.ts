/**
 * Test-only Phase 21 ceremony trust helpers.
 * NOT part of public package API. Requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1.
 */
import type { Pool } from 'pg';

import { registerVerifiedProductionOwnerBootstrapPoolForTests } from '@alex-rewards/auth';

import {
  __brandPhase21CeremonyVerifiedPoolForTests,
  type Phase21CeremonyVerifiedPool,
} from '../phase21-ceremony-verified-pool.js';
import type { AuthenticatedPhase21OwnerCeremonyTrust } from '../phase21-owner-ceremony-trust.js';
import { Phase21OwnerCeremonyTrustError } from '../phase21-owner-ceremony-trust.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrust } from '../phase21-owner-ceremony-trust-mint-internal.js';

function requireTestHooks(): void {
  if (process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS !== '1') {
    throw new Phase21OwnerCeremonyTrustError(
      'FORBIDDEN',
      'phase21 ceremony trust test hooks require ALEX_PHASE21_CEREMONY_TEST_HOOKS=1',
      {},
    );
  }
}

export function mintAuthenticatedPhase21OwnerCeremonyTrustForTests(input: {
  readonly adminUserId: string;
  readonly currentDatabase: string;
  readonly systemIdentifier: string;
  readonly authenticatedAt?: string;
}): AuthenticatedPhase21OwnerCeremonyTrust {
  requireTestHooks();
  return mintAuthenticatedPhase21OwnerCeremonyTrust(input);
}

/**
 * Test-only branded Phase21CeremonyVerifiedPool + auth WeakMap registration.
 * Requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1 and ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1.
 */
export function mintPhase21CeremonyVerifiedPoolForTests(input: {
  readonly pool: Pool;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly tlsServerName?: string;
}): Phase21CeremonyVerifiedPool {
  requireTestHooks();
  if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new Phase21OwnerCeremonyTrustError(
      'FORBIDDEN',
      'mintPhase21CeremonyVerifiedPoolForTests requires ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
      {},
    );
  }
  registerVerifiedProductionOwnerBootstrapPoolForTests({
    pool: input.pool,
    databaseName: input.databaseName,
    systemIdentifier: input.systemIdentifier,
    ...(input.tlsServerName !== undefined ? { tlsServerName: input.tlsServerName } : {}),
  });
  const obj: Phase21CeremonyVerifiedPool = {
    brand: 'Phase21CeremonyVerifiedPool',
    pool: input.pool,
    databaseName: input.databaseName,
    systemIdentifier: input.systemIdentifier,
    tlsServerName: input.tlsServerName ?? 'test-production.local',
    close: async () => {
      await input.pool.end().catch(() => undefined);
    },
  };
  return __brandPhase21CeremonyVerifiedPoolForTests(obj);
}
