/**
 * M1 Option C — Channel A deployment trust derivative v1 (local schema + consistency).
 *
 * Wire format (justified by F3 + BD-5/BD-6 + G1 §C):
 *   Channel A bytes = the unsigned CeremonySealV1 public body (same schema as G1).
 *   seal_content_digest = digestCeremonySealV1(derivative)
 *   must later equal Owner Channel B recorded digest (offline paper) — NOT done here.
 *
 * Layer A: schema validation. Layer B: seal↔profile consistency.
 * Layers C (offline provenance) and D (ops install) are NOT implemented.
 * Structural validity NEVER means authenticated Owner provenance.
 * Same-host checksums are NOT Channel B.
 */
import { AuthDomainError } from '../errors.js';
import {
  validateCeremonyEndpointProfileV1,
  type CeremonyEndpointProfileV1,
  type CeremonyDeploymentEnvV1,
} from './ceremony-profile-v1.js';
import {
  assertSealProfileDigestMatchesProfile,
  digestCeremonySealV1,
  validateCeremonySealV1,
  type CeremonySealV1,
} from './ceremony-seal-v1.js';
import { parseStrictJson } from './strict-json.js';

export const DEPLOYMENT_TRUST_DERIVATIVE_KIND_V1 =
  'alex_rewards_owner_ceremony_seal_v1' as const;

export interface DeploymentTrustDerivativeV1 {
  readonly kind: typeof DEPLOYMENT_TRUST_DERIVATIVE_KIND_V1;
  readonly seal: CeremonySealV1;
  readonly seal_content_digest_hex: string;
  /** Always false — G8 never authenticates provenance. */
  readonly provenance_authenticated: false;
}

/**
 * Validate Channel A derivative: must be a CeremonySealV1 object (no wrapper envelope).
 * Returns typed seal + recomputed content digest. provenance_authenticated is always false.
 */
export function validateDeploymentTrustDerivativeV1(
  raw: unknown,
): DeploymentTrustDerivativeV1 {
  const seal = validateCeremonySealV1(raw);
  const sealContentDigestHex = digestCeremonySealV1(seal);
  return {
    kind: DEPLOYMENT_TRUST_DERIVATIVE_KIND_V1,
    seal,
    seal_content_digest_hex: sealContentDigestHex,
    provenance_authenticated: false,
  };
}

export function parseDeploymentTrustDerivativeV1Json(
  text: string,
): DeploymentTrustDerivativeV1 {
  return validateDeploymentTrustDerivativeV1(parseStrictJson(text));
}

/**
 * Layer B: derivative seal must bind to the exact G2 profile (id + JCS_SHA256_V1 digest).
 * Optional expectedDeploymentEnv rejects profile env mismatch.
 */
export function assertDerivativeConsistentWithProfile(
  derivative: DeploymentTrustDerivativeV1 | unknown,
  profile: CeremonyEndpointProfileV1 | unknown,
  options?: { readonly expectedDeploymentEnv?: CeremonyDeploymentEnvV1 },
): void {
  const d =
    typeof derivative === 'object' &&
    derivative !== null &&
    'seal' in derivative &&
    'seal_content_digest_hex' in derivative
      ? (derivative as DeploymentTrustDerivativeV1)
      : validateDeploymentTrustDerivativeV1(derivative);

  const validatedProfile = validateCeremonyEndpointProfileV1(profile);
  assertSealProfileDigestMatchesProfile(d.seal, validatedProfile);

  if (options?.expectedDeploymentEnv !== undefined) {
    if (validatedProfile.deployment_env !== options.expectedDeploymentEnv) {
      throw new AuthDomainError(
        'VALIDATION',
        'ceremony profile deployment_env does not match expectedDeploymentEnv',
      );
    }
  }

  // Recompute digest integrity on the validated seal object
  const recomputed = digestCeremonySealV1(d.seal);
  if (recomputed !== d.seal_content_digest_hex) {
    throw new AuthDomainError(
      'VALIDATION',
      'derivative seal_content_digest_hex does not match recomputed digestCeremonySealV1',
    );
  }
}

/**
 * Compare Channel A digest to a digest string claimed to come from Channel B.
 * This is a hex equality check only — it does NOT prove Channel B independence.
 * Callers must obtain expectedDigestHex from Owner offline media, not from the host.
 */
export function assertDerivativeDigestEqualsRecordedSealDigest(
  derivative: DeploymentTrustDerivativeV1 | unknown,
  recordedSealContentDigestHexFromChannelB: string,
): void {
  if (
    typeof recordedSealContentDigestHexFromChannelB !== 'string' ||
    !/^[0-9a-f]{64}$/.test(recordedSealContentDigestHexFromChannelB)
  ) {
    throw new AuthDomainError(
      'VALIDATION',
      'recorded seal content digest must be 64 lowercase hex chars',
    );
  }
  const d =
    typeof derivative === 'object' &&
    derivative !== null &&
    'seal_content_digest_hex' in derivative
      ? (derivative as DeploymentTrustDerivativeV1)
      : validateDeploymentTrustDerivativeV1(derivative);

  if (d.seal_content_digest_hex !== recordedSealContentDigestHexFromChannelB) {
    throw new AuthDomainError(
      'VALIDATION',
      'Channel A seal content digest does not match recorded Channel B digest',
    );
  }
}

/**
 * Fail closed: a checksum or second file on the same untrusted host is not Channel B.
 */
export function refuseSameHostChecksumAsChannelB(input: {
  readonly channelAPath?: string;
  readonly claimedChannelBPath?: string;
  readonly sameHost?: boolean;
}): never {
  void input.channelAPath;
  void input.claimedChannelBPath;
  throw new AuthDomainError(
    'FORBIDDEN',
    'same-host checksum or second host-local copy is not independent Channel B (offline_paper_seal required); refuse self-attestation',
    {
      details: {
        sameHost: input.sameHost === true,
        provenance_channel_b_required: 'offline_paper_seal',
      },
    },
  );
}

/** Explicit API: G8 never marks provenance complete. */
export function claimDerivativeProvenanceAuthenticated(
  _derivative: DeploymentTrustDerivativeV1,
): never {
  throw new AuthDomainError(
    'FORBIDDEN',
    'deployment trust derivative schema validation is not Owner provenance authentication',
  );
}
