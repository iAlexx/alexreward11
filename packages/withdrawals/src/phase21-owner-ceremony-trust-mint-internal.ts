/**
 * PACKAGE-PRIVATE mint for AuthenticatedPhase21OwnerCeremonyTrust.
 * Do not re-export mint from package root. Test hooks may re-export under
 * ALEX_PHASE21_CEREMONY_TEST_HOOKS=1.
 */
import type { AuthenticatedPhase21OwnerCeremonyTrust } from './phase21-owner-ceremony-trust.js';
import { PHASE21_OWNER_CEREMONY_TRUST_CLASS } from './phase21-owner-ceremony-trust.js';

export const authenticatedPhase21OwnerCeremonyTrustBrand = new WeakSet<object>();

export function mintAuthenticatedPhase21OwnerCeremonyTrust(input: {
  readonly adminUserId: string;
  readonly currentDatabase: string;
  readonly systemIdentifier: string;
  readonly authenticatedAt?: string;
}): AuthenticatedPhase21OwnerCeremonyTrust {
  const obj: AuthenticatedPhase21OwnerCeremonyTrust = {
    brand: PHASE21_OWNER_CEREMONY_TRUST_CLASS,
    trustClass: PHASE21_OWNER_CEREMONY_TRUST_CLASS,
    adminUserId: input.adminUserId,
    authenticatedAt: input.authenticatedAt ?? new Date().toISOString(),
    currentDatabase: input.currentDatabase,
    systemIdentifier: input.systemIdentifier,
    authMethod: 'PASSWORD_TOTP',
    authStateMutationOccurred: true,
    witnessModel: 'LIVE_OWNER_TTY',
  };
  authenticatedPhase21OwnerCeremonyTrustBrand.add(obj);
  return obj;
}
