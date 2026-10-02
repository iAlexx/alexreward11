/**
 * Production sealed Owner-bootstrap ceremony gate (Phase 21 Step 4A).
 * Parallel to isolated-ceremony-gate — does not weaken isolated tooling.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { AuthDomainError } from '../errors.js';
import {
  CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD,
  digestCeremonyEndpointProfileV1,
  parseCeremonyEndpointProfileV1Json,
  validateCeremonyEndpointProfileV1,
  type CeremonyEndpointProfileV1,
} from './ceremony-profile-v1.js';
import {
  CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
  assertSealProfileDigestMatchesProfile,
  digestCeremonySealV1,
  parseCeremonySealV1Json,
  validateCeremonySealV1,
  type CeremonySealV1,
  type CeremonySealWitnessV1,
} from './ceremony-seal-v1.js';
import {
  validateDeploymentTrustDerivativeV1,
  claimDerivativeProvenanceAuthenticated,
} from './ceremony-trust-derivative-v1.js';
import {
  generateEd25519KeyPair,
  bytesToHex,
} from './ed25519.js';
import { fingerprintPublicKey } from './grant.js';
import { assertWitnessesAreConcrete } from './isolated-ceremony-gate.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';

export const PRODUCTION_CEREMONY_PROFILE_NAME = 'production-endpoint-profile.json';
export const PRODUCTION_CEREMONY_SEAL_NAME = 'ceremony-seal-public.json';
export const PRODUCTION_CHANNEL_A_NAME = 'channel-a-seal-derivative.json';
export const PRODUCTION_CHANNEL_B_NAME = 'channel-b-owner-digest-record.json';
export const PRODUCTION_PUBLIC_KEY_NAME = 'bootstrap-public.json';
export const PRODUCTION_PRIVATE_SEED_NAME = 'bootstrap-private-seed.hex';
export const PRODUCTION_MANIFEST_NAME = 'ceremony-public-manifest.json';
export const PRODUCTION_TARGET_ADMIN_NAME = 'intended-existing-admin.json';

const FORBIDDEN_WITNESS_LABEL =
  /^(cursor|system|railway|placeholder|todo|tbd|n\/a|test_witness_placeholder)$/i;

export interface ProductionCeremonyPublicKeyRecord {
  readonly trust_class: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
  readonly key_id: string;
  readonly alg: 'Ed25519';
  readonly public_key_raw_hex: string;
  readonly public_key_sha256_hex: string;
  readonly created_unix: number;
  readonly warning: string;
}

export interface ProductionIntendedExistingAdminBinding {
  readonly enrollment_mode: 'CLAIM_EXISTING_ADMIN';
  readonly intended_admin_user_id: string;
  readonly intended_admin_email: string;
  readonly note: string;
}

export interface ProductionChannelBRecord {
  readonly provenance_channel_b: typeof CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1;
  readonly recorded_via: 'owner_interactive_tty';
  readonly seal_content_digest_hex: string;
  readonly recorded_unix: number;
  readonly note: string;
}

function resolveDir(dir: string): string {
  return resolve(dir);
}

function refusePlaceholderWitnesses(witnesses: readonly CeremonySealWitnessV1[]): void {
  assertWitnessesAreConcrete(witnesses);
  for (const [i, w] of witnesses.entries()) {
    if (FORBIDDEN_WITNESS_LABEL.test(w.display_name.trim())) {
      throw new AuthDomainError(
        'FORBIDDEN',
        `production witnesses[${i}].display_name is a forbidden placeholder label`,
      );
    }
    if (FORBIDDEN_WITNESS_LABEL.test(w.attestation_ref.trim())) {
      throw new AuthDomainError(
        'FORBIDDEN',
        `production witnesses[${i}].attestation_ref is a forbidden placeholder label`,
      );
    }
  }
}

export function assertCeremonyDirOutsideRepo(ceremonyDir: string, repoRootHint: string): void {
  const dir = resolveDir(ceremonyDir).toLowerCase();
  const repo = resolve(repoRootHint).toLowerCase();
  if (dir === repo || dir.startsWith(repo + '\\') || dir.startsWith(repo + '/')) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production ceremony directory must be outside the git repository',
    );
  }
}

export function assertProductionProfileRequiresSystemIdentifier(
  profile: CeremonyEndpointProfileV1,
): CeremonyEndpointProfileV1 {
  if (profile.deployment_env !== 'production') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production_sealed_v1 requires deployment_env=production',
    );
  }
  if (
    profile.expected_system_identifier === undefined ||
    profile.expected_system_identifier.trim() === ''
  ) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production_sealed_v1 requires expected_system_identifier (DB name alone is insufficient)',
    );
  }
  if (profile.tls.mode !== 'verify_full') {
    throw new AuthDomainError('FORBIDDEN', 'production_sealed_v1 requires tls.mode=verify_full');
  }
  if (profile.tls.ca_pem.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'production_sealed_v1 requires Owner CA ca_pem');
  }
  if (profile.tls.tls_server_name.trim() === '') {
    throw new AuthDomainError('FORBIDDEN', 'production_sealed_v1 requires tls_server_name');
  }
  return profile;
}

export function generateProductionBootstrapKeypairFiles(input: {
  readonly ceremonyDir: string;
  readonly keyId: string;
}): ProductionCeremonyPublicKeyRecord {
  const dir = resolveDir(input.ceremonyDir);
  mkdirSync(dir, { recursive: true });
  const privPath = join(dir, PRODUCTION_PRIVATE_SEED_NAME);
  const pubPath = join(dir, PRODUCTION_PUBLIC_KEY_NAME);
  if (existsSync(privPath) || existsSync(pubPath)) {
    throw new AuthDomainError('FORBIDDEN', 'refusing to overwrite existing bootstrap key files');
  }
  if (process.env.ALEX_SIGNER_CEREMONY_TEST_HOOK === '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'ALEX_SIGNER_CEREMONY_TEST_HOOK forbidden on production Owner-bootstrap key path',
    );
  }
  if (process.env.PHASE21_CEREMONY_TEST_PASSPHRASE) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'PHASE21_CEREMONY_TEST_PASSPHRASE forbidden on production Owner-bootstrap key path',
    );
  }
  const kp = generateEd25519KeyPair();
  const publicHex = bytesToHex(kp.publicKey);
  const fp = fingerprintPublicKey(kp.publicKey);
  const record: ProductionCeremonyPublicKeyRecord = {
    trust_class: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
    key_id: input.keyId,
    alg: 'Ed25519',
    public_key_raw_hex: publicHex,
    public_key_sha256_hex: fp,
    created_unix: Math.floor(Date.now() / 1000),
    warning:
      'PRIVATE SEED IS OWNER OFFLINE MATERIAL — never commit; never reuse Hot Wallet keys',
  };
  writeFileSync(privPath, bytesToHex(kp.privateKey) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(privPath, 0o600);
  } catch {
    // best-effort on Windows
  }
  writeFileSync(pubPath, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8' });
  return record;
}

export function loadProductionPublicKey(ceremonyDir: string): ProductionCeremonyPublicKeyRecord {
  const text = readFileSync(join(resolveDir(ceremonyDir), PRODUCTION_PUBLIC_KEY_NAME), 'utf8');
  const obj = JSON.parse(text) as ProductionCeremonyPublicKeyRecord;
  if (obj.trust_class !== PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'production public key trust_class must be production_sealed_v1',
    );
  }
  return obj;
}

export function writeProductionEndpointProfile(
  ceremonyDir: string,
  profile: CeremonyEndpointProfileV1,
): CeremonyEndpointProfileV1 {
  const validated = assertProductionProfileRequiresSystemIdentifier(
    validateCeremonyEndpointProfileV1(profile),
  );
  const dir = resolveDir(ceremonyDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, PRODUCTION_CEREMONY_PROFILE_NAME),
    JSON.stringify(validated, null, 2) + '\n',
    { encoding: 'utf8' },
  );
  return validated;
}

export function loadProductionEndpointProfile(ceremonyDir: string): CeremonyEndpointProfileV1 {
  const text = readFileSync(
    join(resolveDir(ceremonyDir), PRODUCTION_CEREMONY_PROFILE_NAME),
    'utf8',
  );
  return assertProductionProfileRequiresSystemIdentifier(parseCeremonyEndpointProfileV1Json(text));
}

export function writeIntendedExistingAdminBinding(
  ceremonyDir: string,
  binding: ProductionIntendedExistingAdminBinding,
): void {
  if (binding.enrollment_mode !== 'CLAIM_EXISTING_ADMIN') {
    throw new AuthDomainError('VALIDATION', 'enrollment_mode must be CLAIM_EXISTING_ADMIN');
  }
  const dir = resolveDir(ceremonyDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, PRODUCTION_TARGET_ADMIN_NAME),
    JSON.stringify(binding, null, 2) + '\n',
    { encoding: 'utf8' },
  );
}

export function loadIntendedExistingAdminBinding(
  ceremonyDir: string,
): ProductionIntendedExistingAdminBinding {
  const text = readFileSync(join(resolveDir(ceremonyDir), PRODUCTION_TARGET_ADMIN_NAME), 'utf8');
  const obj = JSON.parse(text) as ProductionIntendedExistingAdminBinding;
  if (obj.enrollment_mode !== 'CLAIM_EXISTING_ADMIN') {
    throw new AuthDomainError('FORBIDDEN', 'intended admin binding must be CLAIM_EXISTING_ADMIN');
  }
  if (!obj.intended_admin_user_id || !obj.intended_admin_email) {
    throw new AuthDomainError('VALIDATION', 'intended admin id/email required');
  }
  return obj;
}

export function draftProductionCeremonySeal(input: {
  readonly ceremonyDir: string;
  readonly authorizerDisplayName: string;
  readonly witnesses: readonly CeremonySealWitnessV1[];
  readonly ceremonyId?: string;
  readonly ceremonyTimeUnix?: number;
}): CeremonySealV1 {
  refusePlaceholderWitnesses(input.witnesses);
  const pub = loadProductionPublicKey(input.ceremonyDir);
  const profile = loadProductionEndpointProfile(input.ceremonyDir);
  const profileDigest = digestCeremonyEndpointProfileV1(profile);
  const seal: CeremonySealV1 = {
    v: 1,
    ceremony_id: input.ceremonyId ?? randomUUID(),
    ceremony_time_unix: input.ceremonyTimeUnix ?? Math.floor(Date.now() / 1000),
    authorizer_display_name: input.authorizerDisplayName,
    witnesses: input.witnesses.map((w) => ({
      display_name: w.display_name,
      role: 'independent_witness',
      attestation_ref: w.attestation_ref,
    })),
    key_id: pub.key_id,
    alg: 'Ed25519',
    public_key_raw_hex: pub.public_key_raw_hex,
    public_key_sha256_hex: pub.public_key_sha256_hex,
    endpoint_profile_id: profile.profile_id,
    profile_digest_method: CEREMONY_ENDPOINT_PROFILE_DIGEST_METHOD,
    profile_digest_hex: profileDigest,
    key_authorizes_grant_and_redeem_pop: true,
    provenance_channel_b: CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
  };
  const validated = validateCeremonySealV1(seal);
  assertSealProfileDigestMatchesProfile(validated, profile);
  writeFileSync(
    join(resolveDir(input.ceremonyDir), PRODUCTION_CEREMONY_SEAL_NAME),
    JSON.stringify(validated, null, 2) + '\n',
    { encoding: 'utf8' },
  );
  const channelA = validateDeploymentTrustDerivativeV1(validated);
  writeFileSync(
    join(resolveDir(input.ceremonyDir), PRODUCTION_CHANNEL_A_NAME),
    JSON.stringify(channelA, null, 2) + '\n',
    { encoding: 'utf8' },
  );
  return validated;
}

export function recordProductionChannelBDigest(input: {
  readonly ceremonyDir: string;
  readonly ownerTypedDigestHex: string;
}): ProductionChannelBRecord {
  const seal = parseCeremonySealV1Json(
    readFileSync(join(resolveDir(input.ceremonyDir), PRODUCTION_CEREMONY_SEAL_NAME), 'utf8'),
  );
  const expected = digestCeremonySealV1(seal);
  const typed = input.ownerTypedDigestHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(typed)) {
    throw new AuthDomainError('VALIDATION', 'Channel B digest must be 64 lowercase hex chars');
  }
  if (typed !== expected) {
    throw new AuthDomainError('FORBIDDEN', 'Channel B digest does not match seal content digest');
  }
  const record: ProductionChannelBRecord = {
    provenance_channel_b: CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
    recorded_via: 'owner_interactive_tty',
    seal_content_digest_hex: typed,
    recorded_unix: Math.floor(Date.now() / 1000),
    note: 'Owner-typed offline paper digest — not a same-host file checksum',
  };
  writeFileSync(
    join(resolveDir(input.ceremonyDir), PRODUCTION_CHANNEL_B_NAME),
    JSON.stringify(record, null, 2) + '\n',
    { encoding: 'utf8' },
  );
  return record;
}

export function assertProductionCeremonyAllowsEnrollment(ceremonyDir: string): {
  readonly seal: CeremonySealV1;
  readonly profile: CeremonyEndpointProfileV1;
  readonly sealContentDigestHex: string;
  readonly authorityPublic: ProductionCeremonyPublicKeyRecord;
  readonly intendedAdmin: ProductionIntendedExistingAdminBinding;
  readonly provenanceAuthenticated: false;
  readonly trustClass: typeof PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS;
} {
  const profile = loadProductionEndpointProfile(ceremonyDir);
  const seal = parseCeremonySealV1Json(
    readFileSync(join(resolveDir(ceremonyDir), PRODUCTION_CEREMONY_SEAL_NAME), 'utf8'),
  );
  const authorityPublic = loadProductionPublicKey(ceremonyDir);
  const intendedAdmin = loadIntendedExistingAdminBinding(ceremonyDir);
  refusePlaceholderWitnesses(seal.witnesses);
  assertSealProfileDigestMatchesProfile(seal, profile);
  if (seal.key_id !== authorityPublic.key_id) {
    throw new AuthDomainError('FORBIDDEN', 'seal key_id does not match pinned public key');
  }
  if (seal.public_key_sha256_hex !== authorityPublic.public_key_sha256_hex) {
    throw new AuthDomainError('FORBIDDEN', 'seal public key fingerprint mismatch');
  }
  const channelA = validateDeploymentTrustDerivativeV1(seal);
  const channelB = JSON.parse(
    readFileSync(join(resolveDir(ceremonyDir), PRODUCTION_CHANNEL_B_NAME), 'utf8'),
  ) as ProductionChannelBRecord;
  if (channelB.seal_content_digest_hex !== channelA.seal_content_digest_hex) {
    throw new AuthDomainError('FORBIDDEN', 'Channel A/B seal digest mismatch');
  }
  if (channelB.recorded_via !== 'owner_interactive_tty') {
    throw new AuthDomainError('FORBIDDEN', 'Channel B must be owner_interactive_tty');
  }
  // Layer C/D provenance auth remains unimplemented — fail closed.
  try {
    claimDerivativeProvenanceAuthenticated(channelA);
  } catch (err) {
    if (!(err instanceof AuthDomainError) || err.code !== 'FORBIDDEN') throw err;
  }
  return {
    seal,
    profile,
    sealContentDigestHex: channelA.seal_content_digest_hex,
    authorityPublic,
    intendedAdmin,
    provenanceAuthenticated: false,
    trustClass: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
  };
}

export function missingProductionTrustResources(ceremonyDir: string | null): readonly string[] {
  const missing: string[] = [];
  if (ceremonyDir === null || ceremonyDir.trim() === '') {
    return [
      'OWNER_BOOTSTRAP_PUBLIC_KEY',
      'OWNER_APPROVED_CA_PEM',
      'PRODUCTION_ENDPOINT_PROFILE',
      'EXPECTED_SYSTEM_IDENTIFIER',
      'TLS_SERVER_NAME',
      'INDEPENDENT_HUMAN_WITNESS',
      'CHANNEL_B_OWNER_TYPED_DIGEST',
      'CEREMONY_SEAL',
      'INTENDED_EXISTING_ADMIN_BINDING',
    ];
  }
  const dir = resolveDir(ceremonyDir);
  if (!existsSync(join(dir, PRODUCTION_PUBLIC_KEY_NAME))) missing.push('OWNER_BOOTSTRAP_PUBLIC_KEY');
  if (!existsSync(join(dir, PRODUCTION_CEREMONY_PROFILE_NAME))) {
    missing.push('PRODUCTION_ENDPOINT_PROFILE');
    missing.push('OWNER_APPROVED_CA_PEM');
    missing.push('EXPECTED_SYSTEM_IDENTIFIER');
    missing.push('TLS_SERVER_NAME');
  } else {
    try {
      const p = loadProductionEndpointProfile(dir);
      if (!p.expected_system_identifier) missing.push('EXPECTED_SYSTEM_IDENTIFIER');
      if (!p.tls.ca_pem) missing.push('OWNER_APPROVED_CA_PEM');
      if (!p.tls.tls_server_name) missing.push('TLS_SERVER_NAME');
    } catch {
      missing.push('PRODUCTION_ENDPOINT_PROFILE_INVALID');
    }
  }
  if (!existsSync(join(dir, PRODUCTION_CEREMONY_SEAL_NAME))) missing.push('CEREMONY_SEAL');
  else {
    try {
      const seal = parseCeremonySealV1Json(
        readFileSync(join(dir, PRODUCTION_CEREMONY_SEAL_NAME), 'utf8'),
      );
      if (seal.witnesses.length < 1) missing.push('INDEPENDENT_HUMAN_WITNESS');
    } catch {
      missing.push('CEREMONY_SEAL_INVALID');
    }
  }
  if (!existsSync(join(dir, PRODUCTION_CHANNEL_B_NAME))) {
    missing.push('CHANNEL_B_OWNER_TYPED_DIGEST');
  }
  if (!existsSync(join(dir, PRODUCTION_TARGET_ADMIN_NAME))) {
    missing.push('INTENDED_EXISTING_ADMIN_BINDING');
  }
  return missing;
}

export function sha256HexOfUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}