/**
 * M1 Option C — Owner ceremony seal public body v1 (unsigned).
 *
 * Contract: FINAL_G1_DESIGN_DECISION_RECORD.md §C (Owner ACCEPTed BD-1…BD-6).
 * Schema validation is NEVER authentication of an Owner trust root.
 * Not wired to trust install, redeem, enrollment, or default-deny lift.
 */
import { createHash } from 'node:crypto';

import { AuthDomainError } from '../errors.js';
import {
  CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD,
  digestCeremonyEndpointProfileV1,
  validateCeremonyEndpointProfileV1,
  type CeremonyEndpointProfileV1,
} from './ceremony-profile-v1.js';
import { canonicalizeToJcs } from './jcs.js';
import { parseStrictJson } from './strict-json.js';

export const CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1 = 'offline_paper_seal' as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const SEAL_REQUIRED_KEYS = [
  'v',
  'ceremony_id',
  'ceremony_time_unix',
  'authorizer_display_name',
  'witnesses',
  'key_id',
  'alg',
  'public_key_raw_hex',
  'public_key_sha256_hex',
  'endpoint_profile_id',
  'profile_digest_method',
  'profile_digest_hex',
  'key_authorizes_grant_and_redeem_pop',
  'provenance_channel_b',
] as const;

export interface CeremonySealWitnessV1 {
  readonly display_name: string;
  readonly role: 'independent_witness';
  readonly attestation_ref: string;
}

export interface CeremonySealV1 {
  readonly v: 1;
  readonly ceremony_id: string;
  readonly ceremony_time_unix: number;
  readonly authorizer_display_name: string;
  readonly witnesses: readonly CeremonySealWitnessV1[];
  readonly key_id: string;
  readonly alg: 'Ed25519';
  readonly public_key_raw_hex: string;
  readonly public_key_sha256_hex: string;
  readonly endpoint_profile_id: string;
  readonly profile_digest_method: typeof CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD;
  readonly profile_digest_hex: string;
  readonly key_authorizes_grant_and_redeem_pop: true;
  readonly provenance_channel_b: typeof CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuthDomainError('VALIDATION', `ceremony seal field ${field} invalid`);
  }
  return value;
}

function assertExactKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  label: string,
): void {
  const allowed = new Set(required);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new AuthDomainError('VALIDATION', `unexpected ${label} field: ${key}`);
    }
  }
  for (const need of required) {
    if (!Object.hasOwn(obj, need)) {
      throw new AuthDomainError('VALIDATION', `missing ${label} field: ${need}`);
    }
  }
}

function validateWitness(raw: unknown, index: number): CeremonySealWitnessV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', `ceremony seal witnesses[${index}] must be object`);
  }
  const obj = raw as Record<string, unknown>;
  assertExactKeys(obj, ['display_name', 'role', 'attestation_ref'], `witnesses[${index}]`);
  const displayName = assertString(obj.display_name, `witnesses[${index}].display_name`);
  const role = assertString(obj.role, `witnesses[${index}].role`);
  if (role !== 'independent_witness') {
    throw new AuthDomainError(
      'VALIDATION',
      `ceremony seal witnesses[${index}].role must be independent_witness`,
    );
  }
  const attestationRef = assertString(obj.attestation_ref, `witnesses[${index}].attestation_ref`);
  return {
    display_name: displayName,
    role: 'independent_witness',
    attestation_ref: attestationRef,
  };
}

/**
 * Strict validate an unsigned ceremony seal public body v1.
 * Does not authenticate the seal as an Owner trust root.
 */
export function validateCeremonySealV1(raw: unknown): CeremonySealV1 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'ceremony seal must be object');
  }
  const obj = raw as Record<string, unknown>;
  assertExactKeys(obj, SEAL_REQUIRED_KEYS, 'ceremony seal');

  if (typeof obj.v !== 'number' || !Number.isInteger(obj.v) || obj.v !== 1) {
    throw new AuthDomainError('VALIDATION', 'ceremony seal v must be integer 1');
  }

  const ceremonyId = assertString(obj.ceremony_id, 'ceremony_id');
  if (!UUID_RE.test(ceremonyId)) {
    throw new AuthDomainError('VALIDATION', 'ceremony seal ceremony_id UUID invalid');
  }

  if (
    typeof obj.ceremony_time_unix !== 'number' ||
    !Number.isInteger(obj.ceremony_time_unix) ||
    obj.ceremony_time_unix < 0
  ) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal ceremony_time_unix must be nonnegative integer',
    );
  }

  const authorizerDisplayName = assertString(
    obj.authorizer_display_name,
    'authorizer_display_name',
  );

  if (!Array.isArray(obj.witnesses) || obj.witnesses.length < 1) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal witnesses must be a non-empty array',
    );
  }
  const witnesses = obj.witnesses.map((w, i) => validateWitness(w, i));

  const keyId = assertString(obj.key_id, 'key_id');
  if (!KEY_ID_RE.test(keyId)) {
    throw new AuthDomainError('VALIDATION', 'ceremony seal key_id format invalid');
  }

  const alg = assertString(obj.alg, 'alg');
  if (alg !== 'Ed25519') {
    throw new AuthDomainError('VALIDATION', 'ceremony seal alg must be Ed25519');
  }

  const publicKeyRawHex = assertString(obj.public_key_raw_hex, 'public_key_raw_hex');
  if (!HEX64_RE.test(publicKeyRawHex)) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal public_key_raw_hex must be 64 lowercase hex chars',
    );
  }

  const publicKeySha256Hex = assertString(obj.public_key_sha256_hex, 'public_key_sha256_hex');
  if (!HEX64_RE.test(publicKeySha256Hex)) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal public_key_sha256_hex must be 64 lowercase hex chars',
    );
  }
  const expectedFp = createHash('sha256')
    .update(Buffer.from(publicKeyRawHex, 'hex'))
    .digest('hex');
  if (publicKeySha256Hex !== expectedFp) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal public_key_sha256_hex does not match SHA-256(public_key_raw_hex)',
    );
  }

  const endpointProfileId = assertString(obj.endpoint_profile_id, 'endpoint_profile_id');
  if (!PROFILE_ID_RE.test(endpointProfileId)) {
    throw new AuthDomainError('VALIDATION', 'ceremony seal endpoint_profile_id format invalid');
  }

  const profileDigestMethod = assertString(obj.profile_digest_method, 'profile_digest_method');
  if (profileDigestMethod !== CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal profile_digest_method must be JCS_SHA256_V1',
    );
  }

  const profileDigestHex = assertString(obj.profile_digest_hex, 'profile_digest_hex');
  if (!HEX64_RE.test(profileDigestHex)) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal profile_digest_hex must be 64 lowercase hex chars',
    );
  }

  if (obj.key_authorizes_grant_and_redeem_pop !== true) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal key_authorizes_grant_and_redeem_pop must be true',
    );
  }

  const provenanceChannelB = assertString(obj.provenance_channel_b, 'provenance_channel_b');
  if (provenanceChannelB !== CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal provenance_channel_b must be offline_paper_seal',
    );
  }

  return {
    v: 1,
    ceremony_id: ceremonyId,
    ceremony_time_unix: obj.ceremony_time_unix,
    authorizer_display_name: authorizerDisplayName,
    witnesses,
    key_id: keyId,
    alg: 'Ed25519',
    public_key_raw_hex: publicKeyRawHex,
    public_key_sha256_hex: publicKeySha256Hex,
    endpoint_profile_id: endpointProfileId,
    profile_digest_method: CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD,
    profile_digest_hex: profileDigestHex,
    key_authorizes_grant_and_redeem_pop: true,
    provenance_channel_b: CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
  };
}

export function parseCeremonySealV1Json(text: string): CeremonySealV1 {
  return validateCeremonySealV1(parseStrictJson(text));
}

/** Seal content digest for grant evidence_fingerprint (not authentication). */
export function digestCeremonySealV1(raw: CeremonySealV1 | unknown): string {
  const seal = validateCeremonySealV1(raw);
  const jcs = canonicalizeToJcs(seal);
  return createHash('sha256').update(Buffer.from(jcs, 'utf8')).digest('hex');
}

/**
 * Optional binding helper: seal.profile_digest_hex must equal G2 digest(profile).
 * Still not trust-root authentication.
 */
export function assertSealProfileDigestMatchesProfile(
  seal: CeremonySealV1 | unknown,
  profile: CeremonyEndpointProfileV1 | unknown,
): void {
  const validatedSeal = validateCeremonySealV1(seal);
  const validatedProfile = validateCeremonyEndpointProfileV1(profile);
  if (validatedSeal.endpoint_profile_id !== validatedProfile.profile_id) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal endpoint_profile_id does not match profile.profile_id',
    );
  }
  const profileDigest = digestCeremonyEndpointProfileV1(validatedProfile);
  if (validatedSeal.profile_digest_hex !== profileDigest) {
    throw new AuthDomainError(
      'VALIDATION',
      'ceremony seal profile_digest_hex does not match JCS_SHA256_V1(profile)',
    );
  }
}
