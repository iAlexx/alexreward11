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
  hexToBytes,
} from './ed25519.js';
import { fingerprintPublicKey } from './grant.js';
import { assertWitnessesAreConcrete } from './isolated-ceremony-gate.js';
import { PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS } from './production-trust-class.js';
import {
  digestProductionCeremonyBundleV1,
  validateProductionCeremonyBundleV1,
  type ProductionCeremonyBundleV1,
  PRODUCTION_CEREMONY_BUNDLE_PURPOSE,
} from './production-ceremony-bundle-v1.js';
import {
  type AuthenticatedProductionBootstrapTrust,
} from './authenticated-production-trust.js';
import { mintAuthenticatedProductionBootstrapTrust } from './production-trust-mint-internal.js';
import {
  createBootstrapTrustMaterial,
  createProductionOwnerBootstrapPool,
} from './pool.js';
import {
  generateEncryptedProductionOwnerBootstrapKey,
  assertNoPlaintextOwnerBootstrapSeedFile,
} from './owner-bootstrap-encrypted-key.js';

export const PRODUCTION_CEREMONY_PROFILE_NAME = 'production-endpoint-profile.json';
export const PRODUCTION_CEREMONY_SEAL_NAME = 'ceremony-seal-public.json';
export const PRODUCTION_CHANNEL_A_NAME = 'channel-a-seal-derivative.json';
export const PRODUCTION_CHANNEL_B_NAME = 'channel-b-owner-digest-record.json';
export const PRODUCTION_PUBLIC_KEY_NAME = 'bootstrap-public.json';
/** @deprecated Plaintext seed files are forbidden (Step 4A.2). */
export const PRODUCTION_PRIVATE_SEED_NAME_FORBIDDEN = 'bootstrap-private-seed.hex';
export const PRODUCTION_MANIFEST_NAME = 'ceremony-public-manifest.json';
export const PRODUCTION_TARGET_ADMIN_NAME = 'intended-existing-admin.json';
export const PRODUCTION_BUNDLE_NAME = 'production-ceremony-bundle-v1.json';
export const WITNESS_MODEL = 'HUMAN_ATTESTED' as const;

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
  /** Documentary only — NOT operational Layer C/D authority. */
  readonly production_bundle_digest_hex: string;
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
  /** Must be true — CLI passes only with --phase21-production-owner-bootstrap. */
  readonly phase21ProductionOwnerBootstrap: boolean;
  /** When true, require interactive TTY (default). Test hooks may disable only under ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1. */
  readonly requireInteractiveTty?: boolean;
  readonly passphrase: string;
  readonly passphraseConfirm: string;
  readonly repoRootHint: string;
  readonly testFastKdf?: boolean;
}): ProductionCeremonyPublicKeyRecord & {
  readonly encrypted_bundle_path_basename: string;
  readonly ciphertext_sha256_hex: string;
} {
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
  const generated = generateEncryptedProductionOwnerBootstrapKey({
    ceremonyDir: input.ceremonyDir,
    keyId: input.keyId,
    passphrase: input.passphrase,
    passphraseConfirm: input.passphraseConfirm,
    phase21ProductionOwnerBootstrap: input.phase21ProductionOwnerBootstrap,
    repoRootHint: input.repoRootHint,
    ...(input.requireInteractiveTty !== undefined
      ? { requireInteractiveTty: input.requireInteractiveTty }
      : {}),
    ...(input.testFastKdf !== undefined ? { testFastKdf: input.testFastKdf } : {}),
  });
  assertNoPlaintextOwnerBootstrapSeedFile(input.ceremonyDir);
  const pub = generated.publicRecord;
  return {
    trust_class: pub.trust_class,
    key_id: pub.key_id,
    alg: 'Ed25519',
    public_key_raw_hex: pub.public_key_raw_hex,
    public_key_sha256_hex: pub.public_key_sha256_hex,
    created_unix: pub.created_unix,
    warning: pub.warning,
    encrypted_bundle_path_basename: pub.encrypted_bundle_path_basename,
    ciphertext_sha256_hex: pub.ciphertext_sha256_hex,
  };
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
  const intended = loadIntendedExistingAdminBinding(input.ceremonyDir);
  const sealDigest = digestCeremonySealV1(validated);
  const bundle = validateProductionCeremonyBundleV1({
    v: 1,
    purpose: PRODUCTION_CEREMONY_BUNDLE_PURPOSE,
    deployment_env: 'production',
    ceremony_id: validated.ceremony_id,
    seal_content_digest_hex: sealDigest,
    endpoint_profile_id: profile.profile_id,
    endpoint_profile_digest_hex: profileDigest,
    bootstrap_key_id: pub.key_id,
    bootstrap_public_key_sha256_hex: pub.public_key_sha256_hex,
    enrollment_mode: 'CLAIM_EXISTING_ADMIN',
    intended_admin_user_id: intended.intended_admin_user_id,
    intended_admin_email: intended.intended_admin_email,
    witness_model: WITNESS_MODEL,
    witness_cryptographic_identity_proven: false,
    witness_count: validated.witnesses.length,
  });
  writeFileSync(
    join(resolveDir(input.ceremonyDir), PRODUCTION_BUNDLE_NAME),
    JSON.stringify(bundle, null, 2) + '\n',
    { encoding: 'utf8' },
  );
  return validated;
}

export function recordProductionChannelBDigest(input: {
  readonly ceremonyDir: string;
  readonly ownerTypedDigestHex: string;
}): ProductionChannelBRecord {
  const bundle = loadProductionCeremonyBundle(input.ceremonyDir);
  const expected = digestProductionCeremonyBundleV1(bundle);
  const typed = input.ownerTypedDigestHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(typed)) {
    throw new AuthDomainError('VALIDATION', 'Channel B digest must be 64 lowercase hex chars');
  }
  if (typed !== expected) {
    throw new AuthDomainError('FORBIDDEN', 'Channel B digest does not match production bundle digest');
  }
  const record: ProductionChannelBRecord = {
    provenance_channel_b: CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
    recorded_via: 'owner_interactive_tty',
    production_bundle_digest_hex: typed,
    recorded_unix: Math.floor(Date.now() / 1000),
    note: 'DOCUMENTARY ONLY — operational Layer C/D requires fresh live Owner TTY entry',
  };
  writeFileSync(
    join(resolveDir(input.ceremonyDir), PRODUCTION_CHANNEL_B_NAME),
    JSON.stringify(record, null, 2) + '\n',
    { encoding: 'utf8' },
  );
  return record;
}


export function loadProductionCeremonyBundle(ceremonyDir: string): ProductionCeremonyBundleV1 {
  const text = readFileSync(join(resolveDir(ceremonyDir), PRODUCTION_BUNDLE_NAME), 'utf8');
  return validateProductionCeremonyBundleV1(JSON.parse(text));
}

/**
 * Structural validation only — provenanceAuthenticated is always false.
 * MUST NOT be used as enrollment authority.
 */
export function validateProductionCeremonyBundleStructurally(ceremonyDir: string): {
  readonly seal: CeremonySealV1;
  readonly profile: CeremonyEndpointProfileV1;
  readonly bundle: ProductionCeremonyBundleV1;
  readonly bundleDigestHex: string;
  readonly authorityPublic: ProductionCeremonyPublicKeyRecord;
  readonly intendedAdmin: ProductionIntendedExistingAdminBinding;
  readonly provenanceAuthenticated: false;
  readonly witnessModel: typeof WITNESS_MODEL;
  readonly witnessCryptographicIdentityProven: false;
} {
  const profile = loadProductionEndpointProfile(ceremonyDir);
  const seal = parseCeremonySealV1Json(
    readFileSync(join(resolveDir(ceremonyDir), PRODUCTION_CEREMONY_SEAL_NAME), 'utf8'),
  );
  const authorityPublic = loadProductionPublicKey(ceremonyDir);
  const intendedAdmin = loadIntendedExistingAdminBinding(ceremonyDir);
  const bundle = loadProductionCeremonyBundle(ceremonyDir);
  refusePlaceholderWitnesses(seal.witnesses);
  assertSealProfileDigestMatchesProfile(seal, profile);
  if (seal.key_id !== authorityPublic.key_id) {
    throw new AuthDomainError('FORBIDDEN', 'seal key_id does not match pinned public key');
  }
  if (seal.public_key_sha256_hex !== authorityPublic.public_key_sha256_hex) {
    throw new AuthDomainError('FORBIDDEN', 'seal public key fingerprint mismatch');
  }
  if (seal.public_key_raw_hex !== authorityPublic.public_key_raw_hex) {
    throw new AuthDomainError('FORBIDDEN', 'seal public key mismatch');
  }
  const sealDigest = digestCeremonySealV1(seal);
  const profileDigest = digestCeremonyEndpointProfileV1(profile);
  if (bundle.seal_content_digest_hex !== sealDigest) {
    throw new AuthDomainError('FORBIDDEN', 'bundle seal digest mismatch');
  }
  if (bundle.endpoint_profile_digest_hex !== profileDigest) {
    throw new AuthDomainError('FORBIDDEN', 'bundle profile digest mismatch');
  }
  if (bundle.bootstrap_key_id !== authorityPublic.key_id) {
    throw new AuthDomainError('FORBIDDEN', 'bundle key_id mismatch');
  }
  if (bundle.bootstrap_public_key_sha256_hex !== authorityPublic.public_key_sha256_hex) {
    throw new AuthDomainError('FORBIDDEN', 'bundle public key fingerprint mismatch');
  }
  if (bundle.intended_admin_user_id !== intendedAdmin.intended_admin_user_id) {
    throw new AuthDomainError('FORBIDDEN', 'bundle intended admin id mismatch vs binding file');
  }
  if (
    bundle.intended_admin_email.trim().toLowerCase() !==
    intendedAdmin.intended_admin_email.trim().toLowerCase()
  ) {
    throw new AuthDomainError('FORBIDDEN', 'bundle intended admin email mismatch vs binding file');
  }
  // Channel B file may exist as documentary evidence but does NOT authenticate.
  return {
    seal,
    profile,
    bundle,
    bundleDigestHex: digestProductionCeremonyBundleV1(bundle),
    authorityPublic,
    intendedAdmin,
    provenanceAuthenticated: false,
    witnessModel: WITNESS_MODEL,
    witnessCryptographicIdentityProven: false,
  };
}

/**
 * MUST throw unless Layer C/D live Owner TTY authentication completed.
 * Same-host Channel B file alone is never sufficient.
 */
export function assertAuthenticatedProductionCeremony(_ceremonyDir: string): never {
  throw new AuthDomainError(
    'FORBIDDEN',
    'assertAuthenticatedProductionCeremony requires live authenticateProductionCeremonyFromOwnerTty result',
  );
}

/**
 * Operational Layer C/D: Owner types production bundle digest from offline/witnessed media
 * into a real interactive TTY. Never accepts env/argv/file/pipe as operational authority.
 */
export async function authenticateProductionCeremonyFromOwnerTty(input: {
  readonly ceremonyDir: string;
  readonly connectionString: string;
  readonly pinnedPublicKeyRawHex: string;
  /**
   * Live digest reader. Production CLI supplies interactive TTY prompt.
   * Test hooks may inject only when ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1 and requireInteractiveTty=false.
   */
  readonly readOfflineBundleDigestHex: () => Promise<string>;
  readonly requireInteractiveTty?: boolean;
}): Promise<AuthenticatedProductionBootstrapTrust> {
  const structural = validateProductionCeremonyBundleStructurally(input.ceremonyDir);
  const requireTty = input.requireInteractiveTty !== false;
  if (requireTty) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'INTERACTIVE_TTY_REQUIRED for operational Channel B / Layer C-D authentication',
      );
    }
  } else if (process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS !== '1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'TTY bypass for Channel B only allowed with ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1',
    );
  }
  const typed = (await input.readOfflineBundleDigestHex()).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(typed)) {
    throw new AuthDomainError('VALIDATION', 'Owner-typed digest must be 64 lowercase hex chars');
  }
  if (typed !== structural.bundleDigestHex) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'live Owner TTY digest does not match recomputed ProductionCeremonyBundleV1 digest',
    );
  }
  // Same-host Channel B JSON file must NEVER satisfy operational auth by itself — ignored here.
  const pubBytes = hexToBytes(input.pinnedPublicKeyRawHex);
  if (bytesToHex(pubBytes) !== structural.authorityPublic.public_key_raw_hex) {
    throw new AuthDomainError('FORBIDDEN', 'pinned public key bytes mismatch');
  }
  const bootstrap = await createProductionOwnerBootstrapPool({
    connectionString: input.connectionString,
    profile: {
      profileId: structural.profile.profile_id,
      deploymentEnv: 'production',
      expectedDatabaseName: structural.profile.expected_database_name,
      expectedSystemIdentifier: structural.profile.expected_system_identifier!,
      tls: {
        mode: 'verify_full',
        caPem: structural.profile.tls.ca_pem,
        tlsServerName: structural.profile.tls.tls_server_name!,
      },
    },
  });
  const trust = createBootstrapTrustMaterial(
    bootstrap,
    new Map([[structural.authorityPublic.key_id, pubBytes]]),
  );
  return mintAuthenticatedProductionBootstrapTrust({
    trust,
    bundle: structural.bundle,
    bundleDigestHex: structural.bundleDigestHex,
  });
}

/** @deprecated Use validateProductionCeremonyBundleStructurally — never enrollment authority. */
export function assertProductionCeremonyAllowsEnrollment(ceremonyDir: string): never {
  void validateProductionCeremonyBundleStructurally(ceremonyDir);
  throw new AuthDomainError(
    'FORBIDDEN',
    'UNAUTHENTICATED_PROVENANCE — use authenticateProductionCeremonyFromOwnerTty for enrollment',
  );
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
      'PRODUCTION_CEREMONY_BUNDLE_V1',
      'LIVE_OWNER_TTY_CHANNEL_B_AUTHENTICATION',
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
      const profile = loadProductionEndpointProfile(dir);
      if (!profile.expected_system_identifier) missing.push('EXPECTED_SYSTEM_IDENTIFIER');
      if (!profile.tls.ca_pem) missing.push('OWNER_APPROVED_CA_PEM');
      if (!profile.tls.tls_server_name) missing.push('TLS_SERVER_NAME');
    } catch {
      missing.push('PRODUCTION_ENDPOINT_PROFILE_INVALID');
    }
  }
  if (!existsSync(join(dir, PRODUCTION_CEREMONY_SEAL_NAME))) {
    missing.push('CEREMONY_SEAL');
    missing.push('INDEPENDENT_HUMAN_WITNESS');
  } else {
    try {
      const seal = parseCeremonySealV1Json(
        readFileSync(join(dir, PRODUCTION_CEREMONY_SEAL_NAME), 'utf8'),
      );
      if (seal.witnesses.length < 1) missing.push('INDEPENDENT_HUMAN_WITNESS');
    } catch {
      missing.push('CEREMONY_SEAL_INVALID');
    }
  }
  if (!existsSync(join(dir, PRODUCTION_BUNDLE_NAME))) missing.push('PRODUCTION_CEREMONY_BUNDLE_V1');
  // Operational Channel B is live TTY — always report until ceremony executes.
  missing.push('LIVE_OWNER_TTY_CHANNEL_B_AUTHENTICATION');
  if (!existsSync(join(dir, PRODUCTION_TARGET_ADMIN_NAME))) {
    missing.push('INTENDED_EXISTING_ADMIN_BINDING');
  }
  return missing;
}

export function sha256HexOfUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}