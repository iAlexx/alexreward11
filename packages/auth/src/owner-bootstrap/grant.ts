/**
 * Option C grant envelope: strict schema, RFC 8785 JCS, Ed25519.
 */
import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';

import { AuthDomainError } from '../errors.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  ed25519Sign,
  ed25519Verify,
  generateEd25519KeyPair,
  hexToBytes,
} from './ed25519.js';
import { canonicalizeToJcs } from './jcs.js';
import { DuplicateJsonKeyError, parseStrictJson } from './strict-json.js';

const GRANT_SIG_PREFIX = Buffer.from('ALEx-OwnerBootstrap-v1\0', 'utf8');
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export type DeploymentEnv = 'production' | 'staging' | 'isolated_test';

export interface OwnerIdentityRef {
  readonly kind: 'human_owner_ceremony';
  readonly subject_display: string;
  readonly ceremony_id: string;
  readonly evidence_fingerprint: string;
  readonly intended_admin_email?: string;
}

export interface OwnerBootstrapGrantPayload {
  readonly v: 1;
  readonly purpose: 'FIRST_OWNER_ENROLLMENT';
  readonly grant_id: string;
  readonly deployment_env: DeploymentEnv;
  readonly endpoint_profile_id: string;
  readonly owner_identity_ref: OwnerIdentityRef;
  readonly iat: number;
  readonly exp: number;
  readonly key_id: string;
  readonly nonce: string;
}

export interface OwnerBootstrapGrantEnvelope {
  readonly payload: OwnerBootstrapGrantPayload;
  readonly alg: 'Ed25519';
  readonly key_id: string;
  readonly sig: string;
}

export interface CeremonyAuthority {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly fingerprintHex: string;
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new AuthDomainError('VALIDATION', `grant field ${field} invalid`);
  }
  return value;
}

function assertInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AuthDomainError('VALIDATION', `grant field ${field} must be integer`);
  }
  return value;
}

function assertExactKeys(obj: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = Object.keys(obj);
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new AuthDomainError('VALIDATION', `unexpected grant field: ${key}`);
    }
  }
  for (const need of allowed) {
    if (!(need in obj)) {
      throw new AuthDomainError('VALIDATION', `missing grant field: ${need}`);
    }
  }
}

function assertExactKeysAllowOptional(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new AuthDomainError('VALIDATION', `unexpected grant field: ${key}`);
    }
  }
  for (const need of required) {
    if (!(need in obj)) {
      throw new AuthDomainError('VALIDATION', `missing grant field: ${need}`);
    }
  }
}

export function fingerprintPublicKey(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

export function createEphemeralCeremonyAuthority(keyId = 'test-ceremony-key-1'): CeremonyAuthority {
  const pair = generateEd25519KeyPair();
  return {
    keyId,
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    fingerprintHex: fingerprintPublicKey(pair.publicKey),
  };
}

export function intendedSubjectFromPayload(payload: OwnerBootstrapGrantPayload): string {
  return payload.owner_identity_ref.intended_admin_email ?? payload.owner_identity_ref.subject_display;
}

export function validateGrantPayload(raw: unknown): OwnerBootstrapGrantPayload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'grant payload must be object');
  }
  const obj = raw as Record<string, unknown>;
  assertExactKeys(obj, [
    'v',
    'purpose',
    'grant_id',
    'deployment_env',
    'endpoint_profile_id',
    'owner_identity_ref',
    'iat',
    'exp',
    'key_id',
    'nonce',
  ]);
  const v = assertInt(obj.v, 'v');
  if (v !== 1) throw new AuthDomainError('VALIDATION', 'unsupported grant version');
  const purpose = assertString(obj.purpose, 'purpose');
  if (purpose !== 'FIRST_OWNER_ENROLLMENT') {
    throw new AuthDomainError('VALIDATION', 'invalid grant purpose');
  }
  const grantId = assertString(obj.grant_id, 'grant_id');
  if (!UUID_RE.test(grantId)) throw new AuthDomainError('VALIDATION', 'grant_id must be UUID');
  const deploymentEnv = assertString(obj.deployment_env, 'deployment_env');
  if (
    deploymentEnv !== 'production' &&
    deploymentEnv !== 'staging' &&
    deploymentEnv !== 'isolated_test'
  ) {
    throw new AuthDomainError('VALIDATION', 'invalid deployment_env');
  }
  const endpointProfileId = assertString(obj.endpoint_profile_id, 'endpoint_profile_id');
  if (!PROFILE_ID_RE.test(endpointProfileId)) {
    throw new AuthDomainError('VALIDATION', 'invalid endpoint_profile_id');
  }
  const keyId = assertString(obj.key_id, 'key_id');
  if (!KEY_ID_RE.test(keyId)) throw new AuthDomainError('VALIDATION', 'invalid key_id');
  const nonce = assertString(obj.nonce, 'nonce');
  if (!HEX64_RE.test(nonce)) throw new AuthDomainError('VALIDATION', 'nonce must be 64 hex');
  const iat = assertInt(obj.iat, 'iat');
  const exp = assertInt(obj.exp, 'exp');
  if (exp <= iat) throw new AuthDomainError('VALIDATION', 'exp must be > iat');
  if (exp - iat > 3600) throw new AuthDomainError('VALIDATION', 'grant lifetime > 3600s');

  if (
    obj.owner_identity_ref === null ||
    typeof obj.owner_identity_ref !== 'object' ||
    Array.isArray(obj.owner_identity_ref)
  ) {
    throw new AuthDomainError('VALIDATION', 'owner_identity_ref invalid');
  }
  const ident = obj.owner_identity_ref as Record<string, unknown>;
  assertExactKeysAllowOptional(
    ident,
    ['kind', 'subject_display', 'ceremony_id', 'evidence_fingerprint'],
    ['intended_admin_email'],
  );
  if (ident.kind !== 'human_owner_ceremony') {
    throw new AuthDomainError('VALIDATION', 'owner_identity_ref.kind invalid');
  }
  const subjectDisplay = assertString(ident.subject_display, 'subject_display');
  const ceremonyId = assertString(ident.ceremony_id, 'ceremony_id');
  if (!UUID_RE.test(ceremonyId)) throw new AuthDomainError('VALIDATION', 'ceremony_id UUID');
  const evidenceFingerprint = assertString(ident.evidence_fingerprint, 'evidence_fingerprint');
  if (!HEX64_RE.test(evidenceFingerprint)) {
    throw new AuthDomainError('VALIDATION', 'evidence_fingerprint must be 64 hex');
  }
  let intendedAdminEmail: string | undefined;
  if ('intended_admin_email' in ident) {
    intendedAdminEmail = assertString(ident.intended_admin_email, 'intended_admin_email');
  }

  return {
    v: 1,
    purpose: 'FIRST_OWNER_ENROLLMENT',
    grant_id: grantId,
    deployment_env: deploymentEnv,
    endpoint_profile_id: endpointProfileId,
    owner_identity_ref: {
      kind: 'human_owner_ceremony',
      subject_display: subjectDisplay,
      ceremony_id: ceremonyId,
      evidence_fingerprint: evidenceFingerprint,
      ...(intendedAdminEmail !== undefined ? { intended_admin_email: intendedAdminEmail } : {}),
    },
    iat,
    exp,
    key_id: keyId,
    nonce,
  };
}

export function grantPayloadHash(payload: OwnerBootstrapGrantPayload): Buffer {
  const jcs = canonicalizeToJcs(payload);
  return createHash('sha256').update(jcs, 'utf8').digest();
}

export function grantSignatureMessage(payloadHash: Buffer): Buffer {
  return Buffer.concat([GRANT_SIG_PREFIX, payloadHash]);
}

export function signGrantEnvelope(
  payload: OwnerBootstrapGrantPayload,
  authority: CeremonyAuthority,
): OwnerBootstrapGrantEnvelope {
  if (payload.key_id !== authority.keyId) {
    throw new AuthDomainError('VALIDATION', 'payload.key_id mismatch authority');
  }
  const hash = grantPayloadHash(payload);
  const sig = ed25519Sign(authority.privateKey, grantSignatureMessage(hash));
  return {
    payload,
    alg: 'Ed25519',
    key_id: authority.keyId,
    sig: base64UrlEncode(sig),
  };
}

export function buildTestGrantPayload(input: {
  readonly authority: CeremonyAuthority;
  readonly endpointProfileId: string;
  readonly deploymentEnv?: DeploymentEnv;
  readonly intendedAdminEmail: string;
  readonly nowSec?: number;
  readonly lifetimeSec?: number;
  readonly grantId?: string;
}): OwnerBootstrapGrantPayload {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const lifetime = input.lifetimeSec ?? 900;
  return {
    v: 1,
    purpose: 'FIRST_OWNER_ENROLLMENT',
    grant_id: input.grantId ?? randomUUID(),
    deployment_env: input.deploymentEnv ?? 'isolated_test',
    endpoint_profile_id: input.endpointProfileId,
    owner_identity_ref: {
      kind: 'human_owner_ceremony',
      subject_display: 'Test Owner',
      ceremony_id: randomUUID(),
      evidence_fingerprint: bytesToHex(randomBytes(32)),
      intended_admin_email: input.intendedAdminEmail,
    },
    iat: now,
    exp: now + lifetime,
    key_id: input.authority.keyId,
    nonce: bytesToHex(randomBytes(32)),
  };
}

export function parseAndVerifyGrantEnvelope(
  rawTextOrObject: unknown,
  pinnedPublicKeyByKeyId: ReadonlyMap<string, Uint8Array>,
  nowSec: number = Math.floor(Date.now() / 1000),
): {
  readonly envelope: OwnerBootstrapGrantEnvelope;
  readonly payloadHashHex: string;
} {
  let raw: unknown;
  try {
    raw =
      typeof rawTextOrObject === 'string'
        ? parseStrictJson(rawTextOrObject)
        : rawTextOrObject;
  } catch (error) {
    if (error instanceof DuplicateJsonKeyError) {
      throw new AuthDomainError('VALIDATION', 'duplicate JSON key rejected', {
        details: { key: error.key },
      });
    }
    throw new AuthDomainError('VALIDATION', 'grant JSON parse failed', { cause: error });
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AuthDomainError('VALIDATION', 'grant envelope must be object');
  }
  const envObj = raw as Record<string, unknown>;
  assertExactKeys(envObj, ['payload', 'alg', 'key_id', 'sig']);
  if (envObj.alg !== 'Ed25519') {
    throw new AuthDomainError('VALIDATION', 'alg must be Ed25519');
  }
  const keyId = assertString(envObj.key_id, 'key_id');
  const sigB64 = assertString(envObj.sig, 'sig');
  let sig: Uint8Array;
  try {
    sig = base64UrlDecode(sigB64);
  } catch {
    throw new AuthDomainError('VALIDATION', 'sig base64url invalid');
  }
  if (sig.byteLength !== 64) throw new AuthDomainError('VALIDATION', 'sig length invalid');

  const payload = validateGrantPayload(envObj.payload);
  if (payload.key_id !== keyId) {
    throw new AuthDomainError('VALIDATION', 'envelope key_id != payload.key_id');
  }

  const pub = pinnedPublicKeyByKeyId.get(keyId);
  if (pub === undefined) {
    throw new AuthDomainError('FORBIDDEN', 'unknown or untrusted ceremony key_id');
  }

  const hash = grantPayloadHash(payload);
  const ok = ed25519Verify(pub, grantSignatureMessage(hash), sig);
  if (!ok) {
    throw new AuthDomainError('FORBIDDEN', 'grant signature invalid');
  }

  // Hard exp; iat early skew ≤60s. M1-B-01: now >= exp is expired (no positive skew).
  if (nowSec >= payload.exp) {
    throw new AuthDomainError('FORBIDDEN', 'grant expired');
  }
  if (nowSec < payload.iat - 60) {
    throw new AuthDomainError('FORBIDDEN', 'grant iat too far in future');
  }

  return {
    envelope: {
      payload,
      alg: 'Ed25519',
      key_id: keyId,
      sig: sigB64,
    },
    payloadHashHex: hash.toString('hex'),
  };
}

export function encodeUint64Be(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new AuthDomainError('VALIDATION', 'uint64 out of range');
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value), 0);
  return buf;
}

export { hexToBytes, bytesToHex };
