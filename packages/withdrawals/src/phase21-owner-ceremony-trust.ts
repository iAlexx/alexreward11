/**
 * Runtime-branded Phase 21 Owner ceremony trust.
 * Caller-constructed { adminUserId, trustClass, authenticated: true } objects CANNOT authorize.
 * Mint only via authenticatePhase21OwnerCeremonyFromOwnerTty (or explicit test hooks).
 */
import { authenticatedPhase21OwnerCeremonyTrustBrand } from './phase21-owner-ceremony-trust-mint-internal.js';

export const PHASE21_OWNER_CEREMONY_TRUST_CLASS =
  'AuthenticatedPhase21OwnerCeremonyTrust' as const;

export type Phase21OwnerCeremonyTrustClass = typeof PHASE21_OWNER_CEREMONY_TRUST_CLASS;

export interface AuthenticatedPhase21OwnerCeremonyTrust {
  readonly brand: Phase21OwnerCeremonyTrustClass;
  readonly trustClass: Phase21OwnerCeremonyTrustClass;
  readonly adminUserId: string;
  readonly authenticatedAt: string;
  readonly currentDatabase: string;
  readonly systemIdentifier: string;
  readonly authMethod: 'PASSWORD_TOTP';
  /** Auth anti-replay / throttle may mutate auth tables; not a Phase21 business mutation. */
  readonly authStateMutationOccurred: true;
  readonly witnessModel: 'LIVE_OWNER_TTY';
}

export class Phase21OwnerCeremonyTrustError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'Phase21OwnerCeremonyTrustError';
    this.code = code;
    this.details = details;
  }
}

export function isAuthenticatedPhase21OwnerCeremonyTrust(
  value: unknown,
): value is AuthenticatedPhase21OwnerCeremonyTrust {
  return (
    typeof value === 'object' &&
    value !== null &&
    authenticatedPhase21OwnerCeremonyTrustBrand.has(value)
  );
}

export function assertAuthenticatedPhase21OwnerCeremonyTrust(
  value: unknown,
): asserts value is AuthenticatedPhase21OwnerCeremonyTrust {
  if (!isAuthenticatedPhase21OwnerCeremonyTrust(value)) {
    throw new Phase21OwnerCeremonyTrustError(
      'OWNER_CEREMONY_TRUST_REQUIRED',
      'AuthenticatedPhase21OwnerCeremonyTrust required — env UUID / forged object / SYSTEM cannot authorize',
      {},
    );
  }
}
