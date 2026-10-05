/**
 * Isolated Option C ceremony package gate.
 *
 * Validates technical seal/profile/dual-channel evidence before enrollment.
 * Does not fabricate witnesses or claim production provenance authentication.
 */
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { AuthDomainError } from '../errors.js';
import {
  CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
  digestCeremonySealV1,
  validateCeremonySealV1,
  type CeremonySealV1,
  type CeremonySealWitnessV1,
} from './ceremony-seal-v1.js';
import {
  claimDerivativeProvenanceAuthenticated,
  refuseSameHostChecksumAsChannelB,
  validateDeploymentTrustDerivativeV1,
} from './ceremony-trust-derivative-v1.js';
import { bytesToHex, generateEd25519KeyPair, hexToBytes } from './ed25519.js';
import { fingerprintPublicKey, type CeremonyAuthority } from './grant.js';
import {
  assertIsolatedSealProfileDigestMatches,
  buildIsolatedCeremonyEndpointProfileV1,
  digestIsolatedCeremonyEndpointProfileV1,
  validateIsolatedCeremonyEndpointProfileV1,
  type IsolatedCeremonyEndpointProfileV1,
} from './isolated-ceremony-profile-v1.js';
import { canonicalizeToJcs } from './jcs.js';
import { parseStrictJson } from './strict-json.js';

const PLACEHOLDER_RE =
  /^(PLACEHOLDER|TODO|TBD|TEST_WITNESS_PLACEHOLDER|TEST_ATTESTATION_REF_PLACEHOLDER|N\/A)$/i;

export const CEREMONY_PUBLIC_MANIFEST_NAME = 'ceremony-public-manifest.json';
export const CEREMONY_PROFILE_NAME = 'isolated-endpoint-profile.json';
export const CEREMONY_SEAL_NAME = 'ceremony-seal-public.json';
export const CEREMONY_CHANNEL_A_NAME = 'channel-a-seal-derivative.json';
export const CEREMONY_CHANNEL_B_RECORD_NAME = 'channel-b-owner-digest-record.json';
export const CEREMONY_PUBLIC_KEY_NAME = 'bootstrap-public.json';
export const CEREMONY_PRIVATE_SEED_NAME = 'bootstrap-private-seed.hex';

export interface CeremonyPublicKeyRecord {
  readonly trust_class: 'ephemeral_isolated_test_only';
  readonly key_id: string;
  readonly alg: 'Ed25519';
  readonly public_key_raw_hex: string;
  readonly public_key_sha256_hex: string;
  readonly created_unix: number;
  readonly warning: string;
}

export interface ChannelBOwnerDigestRecord {
  readonly provenance_channel_b: typeof CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1;
  readonly recorded_via: 'owner_interactive_tty';
  readonly seal_content_digest_hex: string;
  readonly recorded_unix: number;
  readonly note: string;
}

export interface CeremonyPublicManifest {
  readonly v: 1;
  readonly trust_class: 'ephemeral_isolated_test_only';
  readonly expected_database_name: string;
  readonly expected_host: '127.0.0.1';
  readonly expected_port: number;
  readonly key_id: string;
  readonly public_key_sha256_hex: string;
  readonly profile_digest_hex: string | null;
  readonly seal_content_digest_hex: string | null;
  readonly channel_b_recorded: boolean;
  readonly enrollment_allowed: boolean;
}

function refusePlaceholder(value: string, field: string): void {
  if (PLACEHOLDER_RE.test(value.trim()) || value.trim().length < 3) {
    throw new AuthDomainError(
      'FORBIDDEN',
      `ceremony ${field} is missing or placeholder; refuse fabricated evidence`,
    );
  }
}

export function assertWitnessesAreConcrete(
  witnesses: readonly CeremonySealWitnessV1[],
): void {
  if (witnesses.length < 1) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'ceremony seal witnesses must be a non-empty array (missing-witness rejection)',
    );
  }
  for (const [i, w] of witnesses.entries()) {
    refusePlaceholder(w.display_name, `witnesses[${i}].display_name`);
    refusePlaceholder(w.attestation_ref, `witnesses[${i}].attestation_ref`);
    if (w.role !== 'independent_witness') {
      throw new AuthDomainError('VALIDATION', `witnesses[${i}].role invalid`);
    }
  }
}

export function assertConnectionUrlAllowedForIsolatedCeremony(connectionString: string): {
  readonly host: string;
  readonly port: number;
  readonly database: string;
} {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new AuthDomainError('VALIDATION', 'DATABASE_URL parse failed');
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) {
    throw new AuthDomainError('FORBIDDEN', 'ceremony requires postgresql URL');
  }
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated ceremony requires numeric loopback host 127.0.0.1 (or ::1)',
    );
  }
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port === 55432) {
    throw new AuthDomainError('FORBIDDEN', 'isolated ceremony refuses port 55432 / invalid port');
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] ?? '');
  if (database === '' || database === 'alex_rewards') {
    throw new AuthDomainError('FORBIDDEN', 'isolated ceremony refuses operational alex_rewards');
  }
  if (!database.endsWith('_test') && !/_phase\d+(_|$)/.test(database)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated ceremony requires approved *_test / *_phaseN database name',
    );
  }
  return { host: host === '::1' ? '127.0.0.1' : host, port, database };
}

export function resolveCeremonyDir(ceremonyDir: string): string {
  const resolved = resolve(isAbsolute(ceremonyDir) ? ceremonyDir : resolve(process.cwd(), ceremonyDir));
  return resolved;
}

export function assertCeremonyDirOutsideRepo(ceremonyDir: string, repoRootHint: string): void {
  const dir = resolveCeremonyDir(ceremonyDir);
  const repo = resolve(repoRootHint);
  const rel = dir.toLowerCase().startsWith(repo.toLowerCase() + '\\') ||
    dir.toLowerCase().startsWith(repo.toLowerCase() + '/');
  if (rel) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'ceremony directory must be outside the git repository (private keys must not enter git)',
    );
  }
}

function restrictPrivateFileMode(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows may ignore POSIX mode; best-effort only.
  }
}

export function generateEphemeralCeremonyKeypairFiles(input: {
  readonly ceremonyDir: string;
  readonly keyId: string;
}): CeremonyPublicKeyRecord {
  const dir = resolveCeremonyDir(input.ceremonyDir);
  mkdirSync(dir, { recursive: true });
  const privatePath = join(dir, CEREMONY_PRIVATE_SEED_NAME);
  const publicPath = join(dir, CEREMONY_PUBLIC_KEY_NAME);
  if (existsSync(privatePath) || existsSync(publicPath)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'keypair files already exist; refuse overwrite (Owner must choose a fresh ceremony dir)',
    );
  }
  const pair = generateEd25519KeyPair();
  const record: CeremonyPublicKeyRecord = {
    trust_class: 'ephemeral_isolated_test_only',
    key_id: input.keyId,
    alg: 'Ed25519',
    public_key_raw_hex: bytesToHex(pair.publicKey),
    public_key_sha256_hex: fingerprintPublicKey(pair.publicKey),
    created_unix: Math.floor(Date.now() / 1000),
    warning:
      'TEST-ONLY ephemeral bootstrap key. Never reuse for operational/production Owner enrollment.',
  };
  writeFileSync(privatePath, `${bytesToHex(pair.privateKey)}\n`, { encoding: 'utf8', flag: 'wx' });
  restrictPrivateFileMode(privatePath);
  writeFileSync(publicPath, `${JSON.stringify(record, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
  return record;
}

export function loadCeremonyPublicKey(ceremonyDir: string): CeremonyPublicKeyRecord {
  const text = readFileSync(join(resolveCeremonyDir(ceremonyDir), CEREMONY_PUBLIC_KEY_NAME), 'utf8');
  const raw = parseStrictJson(text);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'bootstrap-public.json invalid');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.trust_class !== 'ephemeral_isolated_test_only') {
    throw new AuthDomainError('FORBIDDEN', 'public key trust_class must be ephemeral_isolated_test_only');
  }
  if (obj.alg !== 'Ed25519') {
    throw new AuthDomainError('VALIDATION', 'public key alg must be Ed25519');
  }
  const keyId = String(obj.key_id ?? '');
  const pubHex = String(obj.public_key_raw_hex ?? '');
  const fp = String(obj.public_key_sha256_hex ?? '');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId)) {
    throw new AuthDomainError('VALIDATION', 'key_id invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(pubHex) || !/^[0-9a-f]{64}$/.test(fp)) {
    throw new AuthDomainError('VALIDATION', 'public key hex invalid');
  }
  const expected = fingerprintPublicKey(hexToBytes(pubHex));
  if (fp !== expected) {
    throw new AuthDomainError('VALIDATION', 'public_key_sha256_hex mismatch');
  }
  return {
    trust_class: 'ephemeral_isolated_test_only',
    key_id: keyId,
    alg: 'Ed25519',
    public_key_raw_hex: pubHex,
    public_key_sha256_hex: fp,
    created_unix: Number(obj.created_unix ?? 0),
    warning: String(obj.warning ?? ''),
  };
}

export function loadCeremonyAuthorityFromDir(ceremonyDir: string): CeremonyAuthority {
  const pub = loadCeremonyPublicKey(ceremonyDir);
  const seedHex = readFileSync(
    join(resolveCeremonyDir(ceremonyDir), CEREMONY_PRIVATE_SEED_NAME),
    'utf8',
  )
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(seedHex)) {
    throw new AuthDomainError('VALIDATION', 'private seed file invalid');
  }
  const privateKey = hexToBytes(seedHex);
  const publicKey = hexToBytes(pub.public_key_raw_hex);
  return {
    keyId: pub.key_id,
    publicKey,
    privateKey,
    fingerprintHex: pub.public_key_sha256_hex,
  };
}

export function writeIsolatedCeremonyProfile(input: {
  readonly ceremonyDir: string;
  readonly expectedDatabaseName: string;
  readonly expectedPort: number;
  readonly profileId: string;
  readonly expectedSystemIdentifier?: string;
}): IsolatedCeremonyEndpointProfileV1 {
  const dir = resolveCeremonyDir(input.ceremonyDir);
  mkdirSync(dir, { recursive: true });
  const profile = buildIsolatedCeremonyEndpointProfileV1({
    profileId: input.profileId,
    expectedDatabaseName: input.expectedDatabaseName,
    expectedPort: input.expectedPort,
    ...(input.expectedSystemIdentifier !== undefined
      ? { expectedSystemIdentifier: input.expectedSystemIdentifier }
      : {}),
  });
  const path = join(dir, CEREMONY_PROFILE_NAME);
  writeFileSync(path, `${canonicalizeToJcs(profile)}\n`, { encoding: 'utf8', flag: 'w' });
  return profile;
}

export function loadIsolatedCeremonyProfile(
  ceremonyDir: string,
): IsolatedCeremonyEndpointProfileV1 {
  const text = readFileSync(join(resolveCeremonyDir(ceremonyDir), CEREMONY_PROFILE_NAME), 'utf8');
  return validateIsolatedCeremonyEndpointProfileV1(parseStrictJson(text));
}

export function draftCeremonySeal(input: {
  readonly ceremonyDir: string;
  readonly authorizerDisplayName: string;
  readonly witnesses: readonly CeremonySealWitnessV1[];
  readonly ceremonyId?: string;
  readonly ceremonyTimeUnix?: number;
}): CeremonySealV1 {
  refusePlaceholder(input.authorizerDisplayName, 'authorizer_display_name');
  assertWitnessesAreConcrete(input.witnesses);
  const pub = loadCeremonyPublicKey(input.ceremonyDir);
  const profile = loadIsolatedCeremonyProfile(input.ceremonyDir);
  const profileDigest = digestIsolatedCeremonyEndpointProfileV1(profile);
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
    profile_digest_method: 'JCS_SHA256_V1',
    profile_digest_hex: profileDigest,
    key_authorizes_grant_and_redeem_pop: true,
    provenance_channel_b: CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
  };
  const validated = validateCeremonySealV1(seal);
  assertIsolatedSealProfileDigestMatches(
    validated.endpoint_profile_id,
    validated.profile_digest_hex,
    profile,
  );
  const dir = resolveCeremonyDir(input.ceremonyDir);
  writeFileSync(join(dir, CEREMONY_SEAL_NAME), `${canonicalizeToJcs(validated)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
  // Channel A derivative = unsigned seal public body (same schema).
  writeFileSync(join(dir, CEREMONY_CHANNEL_A_NAME), `${canonicalizeToJcs(validated)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
  return validated;
}

export function loadCeremonySeal(ceremonyDir: string): CeremonySealV1 {
  const text = readFileSync(join(resolveCeremonyDir(ceremonyDir), CEREMONY_SEAL_NAME), 'utf8');
  return validateCeremonySealV1(parseStrictJson(text));
}

/**
 * Owner records Channel B digest from offline paper via interactive TTY material.
 * Refuses same-host second-file self-attestation as Channel B.
 */
export function recordChannelBDigestFromOwner(input: {
  readonly ceremonyDir: string;
  readonly digestHexFromOwner: string;
  readonly claimedChannelBPath?: string;
}): ChannelBOwnerDigestRecord {
  if (input.claimedChannelBPath !== undefined && input.claimedChannelBPath.trim() !== '') {
    refuseSameHostChecksumAsChannelB({
      channelAPath: join(resolveCeremonyDir(input.ceremonyDir), CEREMONY_CHANNEL_A_NAME),
      claimedChannelBPath: input.claimedChannelBPath,
      sameHost: true,
    });
  }
  const seal = loadCeremonySeal(input.ceremonyDir);
  const channelA = validateDeploymentTrustDerivativeV1(seal);
  const digest = input.digestHexFromOwner.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new AuthDomainError(
      'VALIDATION',
      'Channel B digest must be 64 lowercase hex chars from offline paper',
    );
  }
  if (digest !== channelA.seal_content_digest_hex) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'Channel B digest does not match Channel A seal content digest',
    );
  }
  const record: ChannelBOwnerDigestRecord = {
    provenance_channel_b: CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
    recorded_via: 'owner_interactive_tty',
    seal_content_digest_hex: digest,
    recorded_unix: Math.floor(Date.now() / 1000),
    note: 'Owner typed offline paper digest; same-host file is not Channel B',
  };
  writeFileSync(
    join(resolveCeremonyDir(input.ceremonyDir), CEREMONY_CHANNEL_B_RECORD_NAME),
    `${JSON.stringify(record, null, 2)}\n`,
    { encoding: 'utf8', flag: 'w' },
  );
  return record;
}

export function loadChannelBRecord(ceremonyDir: string): ChannelBOwnerDigestRecord {
  const path = join(resolveCeremonyDir(ceremonyDir), CEREMONY_CHANNEL_B_RECORD_NAME);
  if (!existsSync(path)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'Channel B Owner digest record missing; refuse enrollment',
    );
  }
  const raw = parseStrictJson(readFileSync(path, 'utf8'));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'Channel B record invalid');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.provenance_channel_b !== CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1) {
    throw new AuthDomainError('VALIDATION', 'Channel B provenance must be offline_paper_seal');
  }
  if (obj.recorded_via !== 'owner_interactive_tty') {
    throw new AuthDomainError('FORBIDDEN', 'Channel B must be recorded via Owner interactive TTY');
  }
  const digest = String(obj.seal_content_digest_hex ?? '');
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new AuthDomainError('VALIDATION', 'Channel B digest invalid');
  }
  return {
    provenance_channel_b: CEREMONY_SEAL_PROVENANCE_CHANNEL_B_V1,
    recorded_via: 'owner_interactive_tty',
    seal_content_digest_hex: digest,
    recorded_unix: Number(obj.recorded_unix ?? 0),
    note: String(obj.note ?? ''),
  };
}

/**
 * Fail-closed enrollment gate for isolated Option C.
 * Structural validity is not production provenance authentication.
 */
export function assertIsolatedCeremonyAllowsEnrollment(ceremonyDir: string): {
  readonly seal: CeremonySealV1;
  readonly profile: IsolatedCeremonyEndpointProfileV1;
  readonly sealContentDigestHex: string;
  readonly authorityPublic: CeremonyPublicKeyRecord;
} {
  const profile = loadIsolatedCeremonyProfile(ceremonyDir);
  const seal = loadCeremonySeal(ceremonyDir);
  const authorityPublic = loadCeremonyPublicKey(ceremonyDir);
  assertWitnessesAreConcrete(seal.witnesses);
  assertIsolatedSealProfileDigestMatches(
    seal.endpoint_profile_id,
    seal.profile_digest_hex,
    profile,
  );
  if (seal.key_id !== authorityPublic.key_id) {
    throw new AuthDomainError('FORBIDDEN', 'seal key_id does not match pinned public key');
  }
  if (seal.public_key_sha256_hex !== authorityPublic.public_key_sha256_hex) {
    throw new AuthDomainError('FORBIDDEN', 'seal public key fingerprint mismatch');
  }
  if (seal.public_key_raw_hex !== authorityPublic.public_key_raw_hex) {
    throw new AuthDomainError('FORBIDDEN', 'seal public key mismatch');
  }
  const channelA = validateDeploymentTrustDerivativeV1(seal);
  const channelB = loadChannelBRecord(ceremonyDir);
  if (channelB.seal_content_digest_hex !== channelA.seal_content_digest_hex) {
    throw new AuthDomainError('FORBIDDEN', 'Channel A/B seal digest mismatch');
  }
  // Explicitly refuse claiming Layer C/D provenance authentication.
  try {
    claimDerivativeProvenanceAuthenticated(channelA);
  } catch (err) {
    if (!(err instanceof AuthDomainError) || err.code !== 'FORBIDDEN') {
      throw err;
    }
  }
  const sealContentDigestHex = digestCeremonySealV1(seal);
  if (sealContentDigestHex !== channelA.seal_content_digest_hex) {
    throw new AuthDomainError('FORBIDDEN', 'seal content digest integrity failure');
  }
  return { seal, profile, sealContentDigestHex, authorityPublic };
}

export function writeCeremonyPublicManifest(ceremonyDir: string): CeremonyPublicManifest {
  const dir = resolveCeremonyDir(ceremonyDir);
  let profileDigest: string | null = null;
  let sealDigest: string | null = null;
  let channelB = false;
  let enrollmentAllowed = false;
  let keyId = '';
  let fp = '';
  let db = '';
  let port = 0;
  try {
    const pub = loadCeremonyPublicKey(dir);
    keyId = pub.key_id;
    fp = pub.public_key_sha256_hex;
  } catch {
    // incomplete
  }
  try {
    const profile = loadIsolatedCeremonyProfile(dir);
    profileDigest = digestIsolatedCeremonyEndpointProfileV1(profile);
    db = profile.expected_database_name;
    port = profile.expected_port;
  } catch {
    // incomplete
  }
  try {
    const seal = loadCeremonySeal(dir);
    sealDigest = digestCeremonySealV1(seal);
  } catch {
    // incomplete
  }
  try {
    loadChannelBRecord(dir);
    channelB = true;
  } catch {
    channelB = false;
  }
  try {
    assertIsolatedCeremonyAllowsEnrollment(dir);
    enrollmentAllowed = true;
  } catch {
    enrollmentAllowed = false;
  }
  const manifest: CeremonyPublicManifest = {
    v: 1,
    trust_class: 'ephemeral_isolated_test_only',
    expected_database_name: db,
    expected_host: '127.0.0.1',
    expected_port: port,
    key_id: keyId,
    public_key_sha256_hex: fp,
    profile_digest_hex: profileDigest,
    seal_content_digest_hex: sealDigest,
    channel_b_recorded: channelB,
    enrollment_allowed: enrollmentAllowed,
  };
  writeFileSync(join(dir, CEREMONY_PUBLIC_MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
  return manifest;
}

/** Hash helper for paper transcription — public only. */
export function sha256HexOfUtf8(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

export function ceremonyPrivateSeedPath(ceremonyDir: string): string {
  return join(resolveCeremonyDir(ceremonyDir), CEREMONY_PRIVATE_SEED_NAME);
}

export function ceremonyDirParentHint(ceremonyDir: string): string {
  return dirname(resolveCeremonyDir(ceremonyDir));
}
