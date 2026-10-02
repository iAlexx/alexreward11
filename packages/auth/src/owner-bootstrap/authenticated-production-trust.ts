/**
 * Runtime-branded AuthenticatedProductionBootstrapTrust (Phase 21 Step 4A.1).
 * Caller-controlled trustClass strings cannot forge this object.
 */
import { AuthDomainError } from '../errors.js';
import type { BootstrapTrustMaterial } from './redeem.js';
import type { ProductionCeremonyBundleV1 } from './production-ceremony-bundle-v1.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';

const authenticatedProductionTrustBrand = new WeakSet<object>();
/** BootstrapTrustMaterial objects minted only via authenticated production ceremony. */
const productionBoundTrustMaterials = new WeakSet<object>();

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

/**
 * Mint branded trust. Only callable from production authentication helpers after
 * structural validation + live Owner TTY digest equality + live DB endpoint verification.
 */
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

/** Adversarial helper: prove plain objects / trustClass strings are never branded. */
export function tryForgeProductionTrustFromCallerTrustClass(raw: unknown): boolean {
  if (isAuthenticatedProductionBootstrapTrust(raw)) return true;
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { trustClass?: string }).trustClass === PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS
  ) {
    return false;
  }
  return false;
}


export function isProductionBoundBootstrapTrustMaterial(trust: BootstrapTrustMaterial): boolean {
  return productionBoundTrustMaterials.has(trust as object);
}
