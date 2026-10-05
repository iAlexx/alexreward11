/**
 * Runtime-branded AuthenticatedProductionBootstrapTrust (Phase 21 Step 4A.2).
 * Caller-controlled trustClass strings cannot forge this object.
 * Mint capability is NOT exported from the public package surface.
 */
import { AuthDomainError } from '../errors.js';
import type { BootstrapTrustMaterial } from './redeem.js';
import type { ProductionCeremonyBundleV1 } from './production-ceremony-bundle-v1.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';
import {
  authenticatedProductionTrustBrand,
  productionBoundTrustMaterials,
} from './production-trust-mint-internal.js';

export interface AuthenticatedProductionBootstrapTrust {
  readonly brand: 'AuthenticatedProductionBootstrapTrust';
  readonly trustClass: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
  readonly trust: BootstrapTrustMaterial;
  readonly bundle: ProductionCeremonyBundleV1;
  readonly bundleDigestHex: string;
  readonly intendedAdminUserId: string;
  readonly intendedAdminEmail: string;
  readonly keyId: string;
  readonly endpointProfileId: string;
  readonly publicKeyFingerprintHex: string;
  readonly witnessModel: 'HUMAN_ATTESTED';
  readonly witnessCryptographicIdentityProven: false;
  readonly provenanceAuthenticated: true;
  readonly channelBOperationalSource: 'LIVE_OWNER_TTY_OFFLINE_MEDIA';
}

export function isAuthenticatedProductionBootstrapTrust(
  value: unknown,
): value is AuthenticatedProductionBootstrapTrust {
  return typeof value === 'object' && value !== null && authenticatedProductionTrustBrand.has(value);
}

export function assertAuthenticatedProductionBootstrapTrust(
  value: unknown,
): asserts value is AuthenticatedProductionBootstrapTrust {
  if (!isAuthenticatedProductionBootstrapTrust(value)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'AuthenticatedProductionBootstrapTrust required — caller trustClass string is not authority',
    );
  }
}

export function isProductionBoundBootstrapTrustMaterial(trust: BootstrapTrustMaterial): boolean {
  return productionBoundTrustMaterials.has(trust as object);
}
