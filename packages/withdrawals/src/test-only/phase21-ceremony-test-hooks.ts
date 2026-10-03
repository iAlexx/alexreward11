/**
 * Test-only Phase 21 ceremony trust helpers.
 * NOT part of public package API. Requires ALEX_PHASE21_CEREMONY_TEST_HOOKS=1.
 */
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
