/**
 * PACKAGE-PRIVATE mint + WeakSet brand registration (Phase 21 Step 4A.2).
 * MUST NOT be re-exported from owner-bootstrap/index.ts or package root.
 * Only authenticateProductionCeremonyFromOwnerTty (and test hooks) may mint.
 */
import { AuthDomainError } from '../errors.js';
import type { BootstrapTrustMaterial } from './redeem.js';
import type { ProductionCeremonyBundleV1 } from './production-ceremony-bundle-v1.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';
import type { AuthenticatedProductionBootstrapTrust } from './authenticated-production-trust.js';

export const authenticatedProductionTrustBrand = new WeakSet<object>();
export const productionBoundTrustMaterials = new WeakSet<object>();

export function mintAuthenticatedProductionBootstrapTrust(input: {
  readonly trust: BootstrapTrustMaterial;
  readonly bundle: ProductionCeremonyBundleV1;
  readonly bundleDigestHex: string;
}): AuthenticatedProductionBootstrapTrust {
  if (!/^[0-9a-f]{64}$/.test(input.bundleDigestHex)) {
    throw new AuthDomainError('INTERNAL', 'bundleDigestHex invalid');
  }
  if (input.bundle.deployment_env !== 'production') {
    throw new AuthDomainError('FORBIDDEN', 'bundle must be production');
  }
  const obj: AuthenticatedProductionBootstrapTrust = {
    brand: 'AuthenticatedProductionBootstrapTrust',
    trustClass: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
    trust: input.trust,
    bundle: input.bundle,
    bundleDigestHex: input.bundleDigestHex,
    intendedAdminUserId: input.bundle.intended_admin_user_id,
    intendedAdminEmail: input.bundle.intended_admin_email,
    keyId: input.bundle.bootstrap_key_id,
    endpointProfileId: input.bundle.endpoint_profile_id,
    publicKeyFingerprintHex: input.bundle.bootstrap_public_key_sha256_hex,
    witnessModel: 'HUMAN_ATTESTED',
    witnessCryptographicIdentityProven: false,
    provenanceAuthenticated: true,
    channelBOperationalSource: 'LIVE_OWNER_TTY_OFFLINE_MEDIA',
  };
  authenticatedProductionTrustBrand.add(obj);
  productionBoundTrustMaterials.add(input.trust as object);
  return obj;
}
