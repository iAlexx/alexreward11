/**
 * ProductionCeremonyBundleV1 — root-bound production Owner-bootstrap ceremony digest.
 * Channel B / Layer C–D authenticate this digest (not a same-host Channel B file alone).
 */
import { createHash } from 'node:crypto';

import { AuthDomainError } from '../errors.js';
import { canonicalizeToJcs } from './jcs.js';
import { parseStrictJson } from './strict-json.js';

export const PRODUCTION_CEREMONY_BUNDLE_V = 1 as const;
export const PRODUCTION_CEREMONY_BUNDLE_DIGEST_METHOD = 'JCS_SHA256_V1' as const;
export const PRODUCTION_CEREMONY_BUNDLE_PURPOSE = 'FIRST_OWNER_ENROLLMENT' as const;

export interface ProductionCeremonyBundleV1 {
  readonly v: typeof PRODUCTION_CEREMONY_BUNDLE_V;
  readonly purpose: typeof PRODUCTION_CEREMONY_BUNDLE_PURPOSE;
  readonly deployment_env: 'production';
  readonly ceremony_id: string;
  readonly seal_content_digest_hex: string;
  readonly endpoint_profile_id: string;
  readonly endpoint_profile_digest_hex: string;
  readonly bootstrap_key_id: string;
  readonly bootstrap_public_key_sha256_hex: string;
  readonly enrollment_mode: 'CLAIM_EXISTING_ADMIN';
  readonly intended_admin_user_id: string;
  readonly intended_admin_email: string;
  readonly witness_model: 'HUMAN_ATTESTED';
  readonly witness_cryptographic_identity_proven: false;
  readonly witness_count: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AuthDomainError('VALIDATION', `${label} must be a non-empty string`);
  }
  return value;
}

function assertHex64(value: unknown, label: string): string {
  const s = assertString(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) {
    throw new AuthDomainError('VALIDATION', `${label} must be 64 lowercase hex chars`);
  }
  return s;
}

export function validateProductionCeremonyBundleV1(raw: unknown): ProductionCeremonyBundleV1 {
  if (!isPlainObject(raw)) {
    throw new AuthDomainError('VALIDATION', 'ProductionCeremonyBundleV1 must be an object');
  }
  if (raw.v !== 1) {
    throw new AuthDomainError('VALIDATION', 'ProductionCeremonyBundleV1.v must be 1');
  }
  if (raw.purpose !== PRODUCTION_CEREMONY_BUNDLE_PURPOSE) {
    throw new AuthDomainError('VALIDATION', 'purpose must be FIRST_OWNER_ENROLLMENT');
  }
  if (raw.deployment_env !== 'production') {
    throw new AuthDomainError('FORBIDDEN', 'deployment_env must be production');
  }
  if (raw.enrollment_mode !== 'CLAIM_EXISTING_ADMIN') {
    throw new AuthDomainError('FORBIDDEN', 'enrollment_mode must be CLAIM_EXISTING_ADMIN');
  }
  if (raw.witness_model !== 'HUMAN_ATTESTED') {
    throw new AuthDomainError('VALIDATION', 'witness_model must be HUMAN_ATTESTED');
  }
  if (raw.witness_cryptographic_identity_proven !== false) {
    throw new AuthDomainError(
      'VALIDATION',
      'witness_cryptographic_identity_proven must be false (honest model)',
    );
  }
  if (
    typeof raw.witness_count !== 'number' ||
    !Number.isInteger(raw.witness_count) ||
    raw.witness_count < 1
  ) {
    throw new AuthDomainError('VALIDATION', 'witness_count must be integer >= 1');
  }
  return {
    v: 1,
    purpose: PRODUCTION_CEREMONY_BUNDLE_PURPOSE,
    deployment_env: 'production',
    ceremony_id: assertString(raw.ceremony_id, 'ceremony_id'),
    seal_content_digest_hex: assertHex64(raw.seal_content_digest_hex, 'seal_content_digest_hex'),
    endpoint_profile_id: assertString(raw.endpoint_profile_id, 'endpoint_profile_id'),
    endpoint_profile_digest_hex: assertHex64(
      raw.endpoint_profile_digest_hex,
      'endpoint_profile_digest_hex',
    ),
    bootstrap_key_id: assertString(raw.bootstrap_key_id, 'bootstrap_key_id'),
    bootstrap_public_key_sha256_hex: assertHex64(
      raw.bootstrap_public_key_sha256_hex,
      'bootstrap_public_key_sha256_hex',
    ),
    enrollment_mode: 'CLAIM_EXISTING_ADMIN',
    intended_admin_user_id: assertString(raw.intended_admin_user_id, 'intended_admin_user_id'),
    intended_admin_email: assertString(raw.intended_admin_email, 'intended_admin_email')
      .trim()
      .toLowerCase(),
    witness_model: 'HUMAN_ATTESTED',
    witness_cryptographic_identity_proven: false,
    witness_count: raw.witness_count,
  };
}

export function digestProductionCeremonyBundleV1(bundle: ProductionCeremonyBundleV1): string {
  const validated = validateProductionCeremonyBundleV1(bundle);
  const jcs = canonicalizeToJcs(validated);
  return createHash('sha256').update(jcs, 'utf8').digest('hex');
}

export function parseProductionCeremonyBundleV1Json(text: string): ProductionCeremonyBundleV1 {
  return validateProductionCeremonyBundleV1(parseStrictJson(text));
}
