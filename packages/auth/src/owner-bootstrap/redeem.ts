/**
 * M1 Stage B — local secure first-Owner bootstrap redeem protocol.
 * Implements accepted Option C + channel binding + FinalCredReq.
 * Does NOT lift FS-01; does NOT establish production trust; ops DB refused.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { AuthDomainError } from '../errors.js';
import {
  assertPasswordPolicy,
  generateTotpSecretBytes,
  hashAdminPassword,
  sealTotpSecret,
} from '../admin-password.js';
import { assertTotpCodeFormat, generateTotpCode, verifyTotpCode } from '../admin-totp.js';
import { requireOwnerAuthPool, withPoolOwnedOwnerAuthTransaction } from '../admin-auth.js';
import {
  base64UrlDecode,
  base64UrlEncode,
  bytesToHex,
  ed25519Sign,
  ed25519Verify,
  generateEd25519KeyPair,
  hexToBytes,
} from './ed25519.js';
import type { BootstrapEndpointProfile } from './endpoint.js';
import {
  assertBootstrapTlsAndEndpoint,
  assertPoolBoundBootstrapTrust,
  peekIsolatedTestBootstrapClock,
  readAuthoritativeBootstrapNowSec,
  type BootstrapConnectionFacts,
} from './pool.js';
import {
  encodeUint64Be,
  intendedSubjectFromPayload,
  parseAndVerifyGrantEnvelope,
  type CeremonyAuthority,
  type OwnerBootstrapGrantEnvelope,
  type OwnerBootstrapGrantPayload,
} from './grant.js';
import { canonicalizeToJcs } from './jcs.js';

const CHALLENGE_TTL_SEC = 300;
const TICKET_TTL_SEC = 900;
const CLIENT_SKEW_SEC = 60;

export interface EnrollmentChannelKeypair {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly fingerprintHex: string;
}

export function createEnrollmentChannelKeypair(): EnrollmentChannelKeypair {
  const pair = generateEd25519KeyPair();
  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    fingerprintHex: createHash('sha256').update(pair.publicKey).digest('hex'),
  };
}

function concatNul(parts: readonly Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    chunks.push(parts[i]!);
    if (i < parts.length - 1) chunks.push(Buffer.from([0]));
  }
  return Buffer.concat(chunks);
}

export function buildOwnerChallengeBytes(input: {
  readonly grantId: string;
  readonly challengeId: string;
  readonly attemptId: string;
  readonly keyId: string;
  readonly endpointProfileId: string;
  readonly channelFpHex: string;
  readonly issuedAt: number;
}): Buffer {
  const preimage = concatNul([
    Buffer.from('ALEx-OwnerBootstrap-Redeem-v1', 'utf8'),
    Buffer.from(input.grantId, 'utf8'),
    Buffer.from(input.challengeId, 'utf8'),
    Buffer.from(input.attemptId, 'utf8'),
    Buffer.from(input.keyId, 'utf8'),
    Buffer.from(input.endpointProfileId, 'utf8'),
    Buffer.from(input.channelFpHex, 'utf8'),
    encodeUint64Be(input.issuedAt),
  ]);
  return createHash('sha256').update(preimage).digest();
}

export function buildChannelPopBytes(input: {
  readonly attemptId: string;
  readonly challengeId: string;
  readonly grantId: string;
  readonly channelFpHex: string;
  readonly clientUnixTime: number;
  readonly nonce32: Uint8Array;
}): Buffer {
  const preimage = concatNul([
    Buffer.from('ALEx-OwnerBootstrap-ChannelPop-v1', 'utf8'),
    Buffer.from(input.attemptId, 'utf8'),
    Buffer.from(input.challengeId, 'utf8'),
    Buffer.from(input.grantId, 'utf8'),
    Buffer.from(input.channelFpHex, 'utf8'),
    encodeUint64Be(input.clientUnixTime),
    Buffer.from(input.nonce32),
  ]);
  return createHash('sha256').update(preimage).digest();
}

export interface FinalCredPublicHeader {
  readonly v: 1;
  readonly purpose: 'FIRST_OWNER_CREDENTIAL_SETUP';
  readonly grant_id: string;
  readonly attempt_id: string;
  readonly challenge_id: string;
  readonly ticket_id: string;
  readonly channel_fp: string;
  readonly intended_subject: string;
  readonly credential_setup: {
    readonly password_encoding: 'utf8';
    readonly totp_secret_encoding: 'base32_nopad_uppercase';
    readonly totp_digits: 6;
    readonly totp_period_seconds: 30;
    readonly totp_algorithm: 'SHA1';
  };
  readonly client_unix_time: number;
  readonly nonce32: string;
}

export function buildFinalCredBytes(input: {
  readonly publicHeader: FinalCredPublicHeader;
  readonly passwordUtf8: Buffer;
  readonly totpSecretBytes: Uint8Array;
}): Buffer {
  const publicJcs = canonicalizeToJcs(input.publicHeader);
  const pwdTail = Buffer.concat([
    Buffer.from('pwd\0', 'utf8'),
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(input.passwordUtf8.byteLength, 0);
      return len;
    })(),
    input.passwordUtf8,
  ]);
  const totpTail = Buffer.concat([
    Buffer.from('totp\0', 'utf8'),
    (() => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(input.totpSecretBytes.byteLength, 0);
      return len;
    })(),
    Buffer.from(input.totpSecretBytes),
  ]);
  const preimage = Buffer.concat([
    Buffer.from('ALEx-OwnerBootstrap-FinalCredReq-v1\0', 'utf8'),
    Buffer.from(publicJcs, 'utf8'),
    Buffer.from([0]),
    pwdTail,
    Buffer.from([0]),
    totpTail,
  ]);
  return createHash('sha256').update(preimage).digest();
}

export interface BootstrapTrustMaterial {
  /** Pinned ceremony public keys by key_id (test-only for Stage B). */
  readonly pinnedPublicKeys: ReadonlyMap<string, Uint8Array>;
  readonly endpointProfile: BootstrapEndpointProfile;
  /**
   * Connection facts from createOwnerBootstrapPool / createBootstrapTrustMaterial.
   * Must be reference-identical to the verified pool binding (see assertPoolBoundBootstrapTrust).
   */
  readonly connectionFacts: BootstrapConnectionFacts;
}

async function assertM0SeatVacantForBootstrap(client: PoolClient): Promise<void> {
  const seat = await client.query<{
    holder_admin_user_id: string | null;
  }>(`SELECT holder_admin_user_id::text FROM admin_owner_authority WHERE seat = 1 FOR UPDATE`);
  const holder = seat.rows[0]?.holder_admin_user_id ?? null;
  if (holder !== null) {
    throw new AuthDomainError('FORBIDDEN', 'OWNER seat already held — refuse bootstrap');
  }
  const history = await client.query<{ c: number }>(
    `SELECT count(DISTINCT b.admin_user_id)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE r.code = 'OWNER'`,
  );
  if ((history.rows[0]?.c ?? 0) > 0) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'OWNER binding history exists — refuse silent reclaim/transfer',
    );
  }
  const active = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
  );
  if ((active.rows[0]?.c ?? 0) > 0) {
    throw new AuthDomainError('FORBIDDEN', 'active OWNER binding present');
  }
}

async function assertPersistedGrantNotExpired(
  client: PoolClient,
  grantId: string,
  nowSec: number,
): Promise<{
  readonly status: string;
  readonly exp: number;
  readonly iat: number;
  readonly payload_hash_hex: string;
  readonly intended_subject: string;
  readonly key_id: string;
  readonly endpoint_profile_id: string;
  readonly deployment_env: string;
  readonly nonce_hex: string;
  readonly purpose: string;
}> {
  const grant = await client.query<{
    status: string;
    exp: string;
    iat: string;
    payload_hash_hex: string;
    intended_subject: string;
    key_id: string;
    endpoint_profile_id: string;
    deployment_env: string;
    nonce_hex: string;
    purpose: string;
  }>(
    `SELECT status, exp::text, iat::text, payload_hash_hex, intended_subject, key_id,
            endpoint_profile_id, deployment_env, nonce_hex, purpose
     FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
    [grantId],
  );
  const row = grant.rows[0];
  if (row === undefined) {
    throw new AuthDomainError('FORBIDDEN', 'grant missing');
  }
  if (row.status !== 'ISSUED') {
    throw new AuthDomainError('FORBIDDEN', `grant status ${row.status}`);
  }
  const exp = Number(row.exp);
  // M1-B-01: hard boundary — reject when trusted now >= grant.exp (no TTL extension).
  if (nowSec >= exp) {
    throw new AuthDomainError('FORBIDDEN', 'grant expired');
  }
  return {
    status: row.status,
    exp,
    iat: Number(row.iat),
    payload_hash_hex: row.payload_hash_hex,
    intended_subject: row.intended_subject,
    key_id: row.key_id,
    endpoint_profile_id: row.endpoint_profile_id,
    deployment_env: row.deployment_env,
    nonce_hex: row.nonce_hex,
    purpose: row.purpose,
  };
}

/**
 * Canonical M1 bootstrap lock order (S-02) — all mutating paths MUST follow:
 *   1. owner_bootstrap_grants      (by grant_id)
 *   2. owner_bootstrap_attempts   (by attempt_id) when applicable
 *   3. admin_owner_authority      (seat=1) when seat/OWNER mutation or vacancy check is required
 * Deadlocks are NOT retried for enrollment mutations (fail closed).
 */
export const OWNER_BOOTSTRAP_LOCK_ORDER =
  'grant -> attempt -> owner_seat' as const;

function requireBootstrapTrust(pool: Pool, trust: BootstrapTrustMaterial): void {
  requireOwnerAuthPool(pool);
  assertPoolBoundBootstrapTrust(pool, trust);
}

async function readAuthoritativeNowSec(client: PoolClient, pool: Pool): Promise<number> {
  return readAuthoritativeBootstrapNowSec(client, pool);
}

function compareGrantIdentity(
  row: {
    readonly status: string;
    readonly payload_hash_hex: string;
    readonly intended_subject: string;
    readonly key_id: string;
    readonly endpoint_profile_id: string;
    readonly deployment_env: string;
    readonly purpose: string;
    readonly iat: string | number;
    readonly exp: string | number;
    readonly nonce_hex: string;
  },
  payload: OwnerBootstrapGrantPayload,
  payloadHashHex: string,
  intendedSubject: string,
): void {
  if (row.status !== 'ISSUED') {
    throw new AuthDomainError('FORBIDDEN', `grant status ${row.status}`);
  }
  const mismatches: string[] = [];
  if (row.payload_hash_hex !== payloadHashHex) mismatches.push('payload_hash');
  if (row.intended_subject !== intendedSubject) mismatches.push('intended_subject');
  if (row.key_id !== payload.key_id) mismatches.push('key_id');
  if (row.endpoint_profile_id !== payload.endpoint_profile_id) {
    mismatches.push('endpoint_profile_id');
  }
  if (row.deployment_env !== payload.deployment_env) mismatches.push('deployment_env');
  if (row.purpose !== payload.purpose) mismatches.push('purpose');
  if (Number(row.iat) !== payload.iat) mismatches.push('iat');
  if (Number(row.exp) !== payload.exp) mismatches.push('exp');
  if (row.nonce_hex !== payload.nonce) mismatches.push('nonce');
  if (mismatches.length > 0) {
    throw new AuthDomainError('FORBIDDEN', 'grant identity mismatch', {
      details: { fields: mismatches },
    });
  }
}

async function ensureGrantRow(
  client: PoolClient,
  payload: OwnerBootstrapGrantPayload,
  payloadHashHex: string,
): Promise<void> {
  const intendedSubject = intendedSubjectFromPayload(payload);
  const existing = await client.query<{
    status: string;
    nonce_hex: string;
    key_id: string;
    endpoint_profile_id: string;
    deployment_env: string;
    purpose: string;
    payload_hash_hex: string;
    intended_subject: string;
    iat: string;
    exp: string;
  }>(
    `SELECT status, nonce_hex, key_id, endpoint_profile_id, deployment_env, purpose,
            payload_hash_hex, intended_subject, iat::text, exp::text
     FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
    [payload.grant_id],
  );
  if (existing.rows[0] !== undefined) {
    compareGrantIdentity(existing.rows[0], payload, payloadHashHex, intendedSubject);
    return;
  }

  const nonceClash = await client.query(
    `SELECT 1 FROM owner_bootstrap_grants WHERE nonce_hex = $1 FOR SHARE`,
    [payload.nonce],
  );
  if ((nonceClash.rowCount ?? 0) > 0) {
    throw new AuthDomainError('FORBIDDEN', 'grant nonce already used');
  }

  // M1-B-02: transaction-safe insert — never INSERT-error-then-SELECT without savepoint.
  await client.query('SAVEPOINT owner_bootstrap_grant_insert');
  try {
    const inserted = await client.query<{ grant_id: string }>(
      `INSERT INTO owner_bootstrap_grants (
         grant_id, nonce_hex, key_id, endpoint_profile_id, deployment_env, purpose,
         payload_hash_hex, intended_subject, iat, exp, status
       ) VALUES (
         $1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ISSUED'
       )
       ON CONFLICT (grant_id) DO NOTHING
       RETURNING grant_id::text`,
      [
        payload.grant_id,
        payload.nonce,
        payload.key_id,
        payload.endpoint_profile_id,
        payload.deployment_env,
        payload.purpose,
        payloadHashHex,
        intendedSubject,
        payload.iat,
        payload.exp,
      ],
    );
    await client.query('RELEASE SAVEPOINT owner_bootstrap_grant_insert');
    if (inserted.rows[0] !== undefined) {
      return;
    }
  } catch (error: unknown) {
    await client.query('ROLLBACK TO SAVEPOINT owner_bootstrap_grant_insert');
    let code = '';
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const candidate = Reflect.get(error, 'code');
      if (typeof candidate === 'string') code = candidate;
    }
    if (code === '23505') {
      throw new AuthDomainError('FORBIDDEN', 'grant nonce or identity conflict', {
        cause: error,
      });
    }
    throw new AuthDomainError('INTERNAL', 'grant insert failed', { cause: error });
  }

  const raced = await client.query<{
    status: string;
    payload_hash_hex: string;
    intended_subject: string;
    key_id: string;
    endpoint_profile_id: string;
    deployment_env: string;
    purpose: string;
    iat: string;
    exp: string;
    nonce_hex: string;
  }>(
    `SELECT status, payload_hash_hex, intended_subject, key_id, endpoint_profile_id,
            deployment_env, purpose, iat::text, exp::text, nonce_hex
     FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
    [payload.grant_id],
  );
  if (raced.rows[0] === undefined) {
    throw new AuthDomainError('INTERNAL', 'grant missing after concurrent insert');
  }
  compareGrantIdentity(raced.rows[0], payload, payloadHashHex, intendedSubject);
}

export interface StartAttemptResult {
  readonly attemptId: string;
  readonly challengeId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyId: string;
  readonly endpointProfileId: string;
  readonly channelFp: string;
  readonly challengeBytesHex: string;
  readonly grantId: string;
}

export async function startOwnerBootstrapAttempt(
  pool: Pool,
  input: {
    readonly grantEnvelope: OwnerBootstrapGrantEnvelope | string;
    readonly channelPublicKey: Uint8Array;
    readonly trust: BootstrapTrustMaterial;
  },
): Promise<StartAttemptResult> {
  requireBootstrapTrust(pool, input.trust);
  if (input.channelPublicKey.byteLength !== 32) {
    throw new AuthDomainError('VALIDATION', 'channel_pk must be 32 bytes');
  }
  // Preflight may use isolated-test clock when explicitly armed; otherwise wall clock.
  // Authoritative grant expiry is always re-checked after locks via readAuthoritativeNowSec.
  const preflightNow =
    peekIsolatedTestBootstrapClock(pool) ?? Math.floor(Date.now() / 1000);
  const verified = parseAndVerifyGrantEnvelope(
    input.grantEnvelope,
    input.trust.pinnedPublicKeys,
    preflightNow,
  );
  const payload = verified.envelope.payload;
  assertBootstrapTlsAndEndpoint(
    input.trust.endpointProfile,
    payload.deployment_env,
    payload.endpoint_profile_id,
    input.trust.connectionFacts,
  );

  const channelFp = createHash('sha256').update(input.channelPublicKey).digest('hex');
  const attemptId = randomUUID();
  const challengeId = randomUUID();

  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    // Lock order: grant -> attempt(insert) -> seat
    await ensureGrantRow(client, payload, verified.payloadHashHex);
    const nowSec = await readAuthoritativeNowSec(client, pool);
    await assertPersistedGrantNotExpired(client, payload.grant_id, nowSec);

    await internalSupersedePendingBootstrapAttempt(client, payload.grant_id);
    const blocking = await client.query(
      `SELECT 1 FROM owner_bootstrap_attempts
       WHERE grant_id = $1::uuid AND pop_status = 'VERIFIED'`,
      [payload.grant_id],
    );
    if ((blocking.rowCount ?? 0) > 0) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'grant already has VERIFIED attempt — abort or complete that attempt first',
      );
    }

    // CV-02: fresh authoritative time after locks / supersede, immediately before INSERT.
    const issueNow = await readAuthoritativeNowSec(client, pool);
    await assertPersistedGrantNotExpired(client, payload.grant_id, issueNow);

    const issuedAt = issueNow;
    const expiresAt = issuedAt + CHALLENGE_TTL_SEC;
    const challengeExpiresAt = Math.min(expiresAt, Number(payload.exp));
    if (issueNow >= challengeExpiresAt) {
      throw new AuthDomainError('FORBIDDEN', 'grant expired');
    }

    await client.query(
      `INSERT INTO owner_bootstrap_attempts (
         attempt_id, challenge_id, grant_id, key_id, endpoint_profile_id, deployment_env,
         intended_subject, channel_pk, channel_fp_hex, issued_at, expires_at, pop_status
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING'
       )`,
      [
        attemptId,
        challengeId,
        payload.grant_id,
        payload.key_id,
        payload.endpoint_profile_id,
        payload.deployment_env,
        intendedSubjectFromPayload(payload),
        Buffer.from(input.channelPublicKey),
        channelFp,
        issuedAt,
        challengeExpiresAt,
      ],
    );

    await assertM0SeatVacantForBootstrap(client);

    const challengeBytes = buildOwnerChallengeBytes({
      grantId: payload.grant_id,
      challengeId,
      attemptId,
      keyId: payload.key_id,
      endpointProfileId: payload.endpoint_profile_id,
      channelFpHex: channelFp,
      issuedAt,
    });

    return {
      status: 'ok' as const,
      value: {
        attemptId,
        challengeId,
        issuedAt,
        expiresAt: challengeExpiresAt,
        keyId: payload.key_id,
        endpointProfileId: payload.endpoint_profile_id,
        channelFp,
        challengeBytesHex: challengeBytes.toString('hex'),
        grantId: payload.grant_id,
      },
    };
  });
}

export interface SubmitPopResult {
  readonly ticketId: string;
  /** Returned once — never log. */
  readonly enrollmentTicket: string;
  readonly ticketExpiresAt: number;
}

export async function submitOwnerBootstrapPop(
  pool: Pool,
  input: {
    readonly attemptId: string;
    readonly challengeId: string;
    readonly keyId: string;
    readonly sigRedeemB64: string;
    readonly clientUnixTime: number;
    readonly nonce32Hex: string;
    readonly sigChannelPopB64: string;
    readonly trust: BootstrapTrustMaterial;
  },
): Promise<SubmitPopResult> {
  requireBootstrapTrust(pool, input.trust);
  if (!/^[0-9a-f]{64}$/.test(input.nonce32Hex)) {
    throw new AuthDomainError('VALIDATION', 'nonce32 invalid');
  }
  const nonce32 = hexToBytes(input.nonce32Hex);
  let sigRedeem: Uint8Array;
  let sigChannelPop: Uint8Array;
  try {
    sigRedeem = base64UrlDecode(input.sigRedeemB64);
    sigChannelPop = base64UrlDecode(input.sigChannelPopB64);
  } catch {
    throw new AuthDomainError('VALIDATION', 'signature encoding invalid');
  }

  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    // Peek grant_id without lock, then lock grant -> attempt -> seat
    const peek = await client.query<{ grant_id: string }>(
      `SELECT grant_id::text FROM owner_bootstrap_attempts
       WHERE attempt_id = $1::uuid AND challenge_id = $2::uuid`,
      [input.attemptId, input.challengeId],
    );
    const grantId = peek.rows[0]?.grant_id;
    if (grantId === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'REDEEM_POP_MISSING_OR_INVALID');
    }

    await client.query(
      `SELECT grant_id FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
      [grantId],
    );

    const row = await client.query<{
      grant_id: string;
      key_id: string;
      endpoint_profile_id: string;
      deployment_env: string;
      intended_subject: string;
      channel_pk: Buffer;
      channel_fp_hex: string;
      issued_at: string;
      expires_at: string;
      pop_status: string;
    }>(
      `SELECT grant_id::text, key_id, endpoint_profile_id, deployment_env, intended_subject,
              channel_pk, channel_fp_hex, issued_at::text, expires_at::text, pop_status
       FROM owner_bootstrap_attempts
       WHERE attempt_id = $1::uuid AND challenge_id = $2::uuid
       FOR UPDATE`,
      [input.attemptId, input.challengeId],
    );
    const attempt = row.rows[0];
    if (attempt === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'REDEEM_POP_MISSING_OR_INVALID');
    }
    assertBootstrapTlsAndEndpoint(
      input.trust.endpointProfile,
      attempt.deployment_env as 'isolated_test' | 'staging' | 'production',
      attempt.endpoint_profile_id,
      input.trust.connectionFacts,
    );

    const nowSec = await readAuthoritativeNowSec(client, pool);
    await assertPersistedGrantNotExpired(client, attempt.grant_id, nowSec);
    await assertM0SeatVacantForBootstrap(client);

    if (attempt.pop_status !== 'PENDING') {
      throw new AuthDomainError('FORBIDDEN', 'challenge not PENDING');
    }
    const expiresAt = Number(attempt.expires_at);
    if (nowSec > expiresAt) {
      await client.query(
        `UPDATE owner_bootstrap_attempts SET pop_status = 'EXPIRED' WHERE attempt_id = $1::uuid`,
        [input.attemptId],
      );
      throw new AuthDomainError('FORBIDDEN', 'challenge expired');
    }
    if (attempt.key_id !== input.keyId) {
      throw new AuthDomainError('FORBIDDEN', 'REDEEM_POP_MISSING_OR_INVALID');
    }
    if (Math.abs(nowSec - input.clientUnixTime) > CLIENT_SKEW_SEC) {
      throw new AuthDomainError('FORBIDDEN', 'channel pop freshness failed');
    }

    const challengeBytes = buildOwnerChallengeBytes({
      grantId: attempt.grant_id,
      challengeId: input.challengeId,
      attemptId: input.attemptId,
      keyId: attempt.key_id,
      endpointProfileId: attempt.endpoint_profile_id,
      channelFpHex: attempt.channel_fp_hex,
      issuedAt: Number(attempt.issued_at),
    });
    const ceremonyPub = input.trust.pinnedPublicKeys.get(attempt.key_id);
    if (ceremonyPub === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'untrusted ceremony key');
    }
    if (!ed25519Verify(ceremonyPub, challengeBytes, sigRedeem)) {
      throw new AuthDomainError('FORBIDDEN', 'REDEEM_POP_MISSING_OR_INVALID');
    }

    const channelPopBytes = buildChannelPopBytes({
      attemptId: input.attemptId,
      challengeId: input.challengeId,
      grantId: attempt.grant_id,
      channelFpHex: attempt.channel_fp_hex,
      clientUnixTime: input.clientUnixTime,
      nonce32,
    });
    if (!ed25519Verify(new Uint8Array(attempt.channel_pk), channelPopBytes, sigChannelPop)) {
      throw new AuthDomainError('FORBIDDEN', 'REDEEM_POP_MISSING_OR_INVALID');
    }

    try {
      await client.query(
        `INSERT INTO owner_bootstrap_attempt_nonces (attempt_id, purpose, nonce_hex)
         VALUES ($1::uuid, 'channel_pop', $2)`,
        [input.attemptId, input.nonce32Hex],
      );
    } catch {
      throw new AuthDomainError('FORBIDDEN', 'channel pop nonce replay');
    }

    // Fresh clock again immediately before minting ticket (S-01 / CV-02).
    const decideNow = await readAuthoritativeNowSec(client, pool);
    await assertPersistedGrantNotExpired(client, attempt.grant_id, decideNow);
    if (decideNow > expiresAt) {
      await client.query(
        `UPDATE owner_bootstrap_attempts SET pop_status = 'EXPIRED' WHERE attempt_id = $1::uuid`,
        [input.attemptId],
      );
      throw new AuthDomainError('FORBIDDEN', 'challenge expired');
    }
    if (Math.abs(decideNow - input.clientUnixTime) > CLIENT_SKEW_SEC) {
      throw new AuthDomainError('FORBIDDEN', 'channel pop freshness failed');
    }
    const grantRow = await client.query<{ exp: string }>(
      `SELECT exp::text FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
      [attempt.grant_id],
    );
    const grantExp = Number(grantRow.rows[0]?.exp);
    const ticketId = randomUUID();
    const enrollmentTicket = bytesToHex(randomBytes(32));
    const ticketHash = createHash('sha256').update(enrollmentTicket, 'utf8').digest('hex');
    const ticketExpiresAt = Math.min(decideNow + TICKET_TTL_SEC, grantExp);
    if (decideNow >= ticketExpiresAt) {
      throw new AuthDomainError('FORBIDDEN', 'grant expired');
    }
    await client.query(
      `UPDATE owner_bootstrap_attempts SET
         pop_status = 'VERIFIED',
         ticket_id = $2::uuid,
         enrollment_ticket_hash = $3,
         ticket_expires_at = $4,
         verified_at = $5
       WHERE attempt_id = $1::uuid`,
      [input.attemptId, ticketId, ticketHash, ticketExpiresAt, decideNow],
    );

    return {
      status: 'ok' as const,
      value: { ticketId, enrollmentTicket, ticketExpiresAt },
    };
  });
}

export function buildChannelAbortBytes(input: {
  readonly attemptId: string;
  readonly challengeId: string;
  readonly grantId: string;
  readonly channelFpHex: string;
  readonly clientUnixTime: number;
  readonly nonce32: Uint8Array;
}): Buffer {
  const preimage = concatNul([
    Buffer.from('ALEx-OwnerBootstrap-ChannelAbort-v1', 'utf8'),
    Buffer.from(input.attemptId, 'utf8'),
    Buffer.from(input.challengeId, 'utf8'),
    Buffer.from(input.grantId, 'utf8'),
    Buffer.from(input.channelFpHex, 'utf8'),
    encodeUint64Be(input.clientUnixTime),
    Buffer.from(input.nonce32),
  ]);
  return createHash('sha256').update(preimage).digest();
}

/**
 * User-requested abort — requires enrollment-channel PoP (M1-B-03).
 * Does not silently reassign channel; next redeem needs a new attempt.
 */
export async function abortOwnerBootstrapAttempt(
  pool: Pool,
  input: {
    readonly attemptId: string;
    readonly challengeId: string;
    readonly clientUnixTime: number;
    readonly nonce32Hex: string;
    readonly sigChannelAbortB64: string;
    readonly trust: BootstrapTrustMaterial;
  },
): Promise<void> {
  requireBootstrapTrust(pool, input.trust);
  if (!/^[0-9a-f]{64}$/.test(input.nonce32Hex)) {
    throw new AuthDomainError('VALIDATION', 'nonce32 invalid');
  }
  let sigAbort: Uint8Array;
  try {
    sigAbort = base64UrlDecode(input.sigChannelAbortB64);
  } catch {
    throw new AuthDomainError('VALIDATION', 'sig_channel_abort encoding invalid');
  }

  await withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    const peek = await client.query<{ grant_id: string }>(
      `SELECT grant_id::text FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
      [input.attemptId],
    );
    const grantId = peek.rows[0]?.grant_id;
    if (grantId === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'attempt not found');
    }
    await client.query(
      `SELECT grant_id FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
      [grantId],
    );
    const row = await client.query<{
      grant_id: string;
      challenge_id: string;
      endpoint_profile_id: string;
      deployment_env: string;
      channel_pk: Buffer;
      channel_fp_hex: string;
      pop_status: string;
    }>(
      `SELECT grant_id::text, challenge_id::text, endpoint_profile_id, deployment_env,
              channel_pk, channel_fp_hex, pop_status
       FROM owner_bootstrap_attempts
       WHERE attempt_id = $1::uuid
       FOR UPDATE`,
      [input.attemptId],
    );
    const attempt = row.rows[0];
    if (attempt === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'attempt not found');
    }
    if (attempt.challenge_id !== input.challengeId) {
      throw new AuthDomainError('FORBIDDEN', 'challenge_id mismatch');
    }
    assertBootstrapTlsAndEndpoint(
      input.trust.endpointProfile,
      attempt.deployment_env as 'isolated_test' | 'staging' | 'production',
      attempt.endpoint_profile_id,
      input.trust.connectionFacts,
    );
    const nowSec = await readAuthoritativeNowSec(client, pool);
    if (attempt.pop_status !== 'PENDING' && attempt.pop_status !== 'VERIFIED') {
      throw new AuthDomainError('FORBIDDEN', `attempt not abortable (${attempt.pop_status})`);
    }
    if (Math.abs(nowSec - input.clientUnixTime) > CLIENT_SKEW_SEC) {
      throw new AuthDomainError('FORBIDDEN', 'abort freshness failed');
    }

    const abortBytes = buildChannelAbortBytes({
      attemptId: input.attemptId,
      challengeId: input.challengeId,
      grantId: attempt.grant_id,
      channelFpHex: attempt.channel_fp_hex,
      clientUnixTime: input.clientUnixTime,
      nonce32: hexToBytes(input.nonce32Hex),
    });
    if (!ed25519Verify(new Uint8Array(attempt.channel_pk), abortBytes, sigAbort)) {
      throw new AuthDomainError('FORBIDDEN', 'abort channel proof invalid');
    }

    try {
      await client.query(
        `INSERT INTO owner_bootstrap_attempt_nonces (attempt_id, purpose, nonce_hex)
         VALUES ($1::uuid, 'channel_abort', $2)`,
        [input.attemptId, input.nonce32Hex],
      );
    } catch {
      throw new AuthDomainError('FORBIDDEN', 'abort nonce replay');
    }

    // CV-02: fresh freshness check immediately before abort state transition.
    const decideNow = await readAuthoritativeNowSec(client, pool);
    if (Math.abs(decideNow - input.clientUnixTime) > CLIENT_SKEW_SEC) {
      throw new AuthDomainError('FORBIDDEN', 'abort freshness failed');
    }

    await client.query(
      `UPDATE owner_bootstrap_attempts
       SET pop_status = 'ABORTED',
           enrollment_ticket_hash = NULL,
           ticket_id = NULL,
           ticket_expires_at = NULL
       WHERE attempt_id = $1::uuid AND pop_status IN ('PENDING', 'VERIFIED')`,
      [input.attemptId],
    );

    await client.query(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source
       ) VALUES (
         NULL, 'SYSTEM', 'OWNER_BOOTSTRAP_ABORT', 'owner_bootstrap_attempts', $1::uuid,
         $2::jsonb, 'channel-authenticated enrollment abort', 'API'
       )`,
      [
        input.attemptId,
        JSON.stringify({
          attempt_id: input.attemptId,
          challenge_id: input.challengeId,
          grant_id: attempt.grant_id,
          channel_fp: attempt.channel_fp_hex,
          prior_status: attempt.pop_status,
        }),
      ],
    );

    return { status: 'ok' as const, value: undefined };
  });
}

/**
 * Internal-only cleanup when a newer attempt supersedes a PENDING sibling.
 * Not a user API — callers must be in-process bootstrap code paths only.
 */
export async function internalSupersedePendingBootstrapAttempt(
  client: PoolClient,
  grantId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE owner_bootstrap_attempts
     SET pop_status = 'SUPERSEDED', updated_at = now()
     WHERE grant_id = $1::uuid AND pop_status = 'PENDING'`,
    [grantId],
  );
  return result.rowCount ?? 0;
}

export interface CompleteEnrollmentInput {
  readonly attemptId: string;
  readonly challengeId: string;
  readonly ticketId: string;
  readonly enrollmentTicket: string;
  readonly intendedSubject: string;
  readonly password: string;
  readonly totpSecretBytes: Uint8Array;
  readonly totpConfirmCode: string;
  readonly clientUnixTime: number;
  readonly nonce32Hex: string;
  readonly sigChannelCredB64: string;
  readonly displayName?: string;
  readonly trust: BootstrapTrustMaterial;
  /**
   * Test-only deliberate delay after credential hashing and before the final TX.
   * Enabled only when ALEX_OWNER_BOOTSTRAP_TEST_HOOKS=1 (S-01 delayed prep).
   */
  readonly testCredentialPrepDelayMs?: number;
}

export interface CompleteEnrollmentResult {
  readonly adminUserId: string;
  readonly email: string;
}

export async function completeOwnerBootstrapEnrollment(
  pool: Pool,
  input: CompleteEnrollmentInput,
): Promise<CompleteEnrollmentResult> {
  requireBootstrapTrust(pool, input.trust);
  assertPasswordPolicy(input.password);
  assertTotpCodeFormat(input.totpConfirmCode);
  if (!verifyTotpCode(input.totpSecretBytes, input.totpConfirmCode)) {
    throw new AuthDomainError('VALIDATION', 'TOTP confirm code invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(input.nonce32Hex)) {
    throw new AuthDomainError('VALIDATION', 'nonce32 invalid');
  }
  const passwordUtf8 = Buffer.from(input.password, 'utf8');
  let sigChannelCred: Uint8Array;
  try {
    sigChannelCred = base64UrlDecode(input.sigChannelCredB64);
  } catch {
    throw new AuthDomainError('VALIDATION', 'sig_channel_cred encoding invalid');
  }

  // Hash/seal outside the short final TX (may be slow — S-01 requires fresh clock after locks).
  const passwordVerifier = await hashAdminPassword(input.password);
  const totpSeal = sealTotpSecret(input.password, input.totpSecretBytes);

  if (
    input.testCredentialPrepDelayMs !== undefined &&
    input.testCredentialPrepDelayMs > 0 &&
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS === '1'
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, input.testCredentialPrepDelayMs);
    });
  }

  return withPoolOwnedOwnerAuthTransaction(pool, async (client) => {
    const peek = await client.query<{ grant_id: string }>(
      `SELECT grant_id::text FROM owner_bootstrap_attempts
       WHERE attempt_id = $1::uuid AND challenge_id = $2::uuid`,
      [input.attemptId, input.challengeId],
    );
    const grantId = peek.rows[0]?.grant_id;
    if (grantId === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'attempt not VERIFIED');
    }
    // Lock order: grant -> attempt -> seat
    await client.query(
      `SELECT grant_id FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
      [grantId],
    );
    const attemptRes = await client.query<{
      grant_id: string;
      key_id: string;
      endpoint_profile_id: string;
      deployment_env: string;
      intended_subject: string;
      channel_pk: Buffer;
      channel_fp_hex: string;
      pop_status: string;
      ticket_id: string | null;
      enrollment_ticket_hash: string | null;
      ticket_expires_at: string | null;
    }>(
      `SELECT grant_id::text, key_id, endpoint_profile_id, deployment_env, intended_subject,
              channel_pk, channel_fp_hex, pop_status, ticket_id::text,
              enrollment_ticket_hash, ticket_expires_at::text
       FROM owner_bootstrap_attempts
       WHERE attempt_id = $1::uuid AND challenge_id = $2::uuid
       FOR UPDATE`,
      [input.attemptId, input.challengeId],
    );
    const attempt = attemptRes.rows[0];
    if (attempt === undefined || attempt.pop_status !== 'VERIFIED') {
      throw new AuthDomainError('FORBIDDEN', 'attempt not VERIFIED');
    }
    assertBootstrapTlsAndEndpoint(
      input.trust.endpointProfile,
      attempt.deployment_env as 'isolated_test' | 'staging' | 'production',
      attempt.endpoint_profile_id,
      input.trust.connectionFacts,
    );

    // Fresh authoritative time AFTER locks and AFTER slow password hashing (S-01).
    const nowSec = await readAuthoritativeNowSec(client, pool);
    await assertPersistedGrantNotExpired(client, attempt.grant_id, nowSec);
    await assertM0SeatVacantForBootstrap(client);

    if (attempt.ticket_id !== input.ticketId) {
      throw new AuthDomainError('FORBIDDEN', 'ticket_id mismatch');
    }
    const ticketHash = createHash('sha256')
      .update(input.enrollmentTicket, 'utf8')
      .digest('hex');
    if (ticketHash !== attempt.enrollment_ticket_hash) {
      throw new AuthDomainError('FORBIDDEN', 'enrollment ticket invalid');
    }
    const ticketExp = Number(attempt.ticket_expires_at);
    if (nowSec > ticketExp) {
      throw new AuthDomainError('FORBIDDEN', 'enrollment ticket expired');
    }
    if (attempt.intended_subject !== input.intendedSubject) {
      throw new AuthDomainError('FORBIDDEN', 'intended_subject mismatch');
    }
    if (Math.abs(nowSec - input.clientUnixTime) > CLIENT_SKEW_SEC) {
      throw new AuthDomainError('FORBIDDEN', 'credential freshness failed');
    }

    const publicHeader: FinalCredPublicHeader = {
      v: 1,
      purpose: 'FIRST_OWNER_CREDENTIAL_SETUP',
      grant_id: attempt.grant_id,
      attempt_id: input.attemptId,
      challenge_id: input.challengeId,
      ticket_id: input.ticketId,
      channel_fp: attempt.channel_fp_hex,
      intended_subject: input.intendedSubject,
      credential_setup: {
        password_encoding: 'utf8',
        totp_secret_encoding: 'base32_nopad_uppercase',
        totp_digits: 6,
        totp_period_seconds: 30,
        totp_algorithm: 'SHA1',
      },
      client_unix_time: input.clientUnixTime,
      nonce32: input.nonce32Hex,
    };
    const finalBytes = buildFinalCredBytes({
      publicHeader,
      passwordUtf8,
      totpSecretBytes: input.totpSecretBytes,
    });
    if (!ed25519Verify(new Uint8Array(attempt.channel_pk), finalBytes, sigChannelCred)) {
      throw new AuthDomainError('FORBIDDEN', 'FinalCredReq signature invalid');
    }

    try {
      await client.query(
        `INSERT INTO owner_bootstrap_attempt_nonces (attempt_id, purpose, nonce_hex)
         VALUES ($1::uuid, 'channel_cred', $2)`,
        [input.attemptId, input.nonce32Hex],
      );
    } catch {
      throw new AuthDomainError('FORBIDDEN', 'channel cred nonce replay');
    }

    // S-01 / CV-02: re-read wall clock + all deadlines immediately before credential/seat mutation.
    const enrollNow = await readAuthoritativeNowSec(client, pool);
    await assertPersistedGrantNotExpired(client, attempt.grant_id, enrollNow);
    if (enrollNow > ticketExp) {
      throw new AuthDomainError('FORBIDDEN', 'enrollment ticket expired');
    }
    if (Math.abs(enrollNow - input.clientUnixTime) > CLIENT_SKEW_SEC) {
      throw new AuthDomainError('FORBIDDEN', 'credential freshness failed');
    }
    await assertM0SeatVacantForBootstrap(client);

    const email = input.intendedSubject;
    const displayName = input.displayName ?? 'Owner';
    const adminIns = await client.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status)
       VALUES ($1, $2, 'ACTIVE')
       RETURNING id::text`,
      [email, displayName],
    );
    const adminUserId = adminIns.rows[0]?.id;
    if (adminUserId === undefined) {
      throw new AuthDomainError('INTERNAL', 'admin_users insert failed');
    }

    const role = await client.query<{ id: string }>(
      `SELECT id::text FROM admin_roles WHERE code = 'OWNER' FOR UPDATE`,
    );
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) {
      throw new AuthDomainError('INTERNAL', 'OWNER role missing');
    }
    await client.query(`UPDATE admin_roles SET status = 'ACTIVE' WHERE id = $1::uuid`, [roleId]);
    const binding = await client.query<{ id: string }>(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid)
       RETURNING id::text`,
      [adminUserId, roleId],
    );
    const bindingId = binding.rows[0]?.id;
    if (bindingId === undefined) {
      throw new AuthDomainError('INTERNAL', 'OWNER binding insert failed');
    }

    await client.query(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, password_verifier, status
       ) VALUES ($1::uuid, 'PASSWORD', $2, 'ACTIVE')`,
      [adminUserId, passwordVerifier],
    );
    await client.query(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, totp_secret_reference, status, totp_last_accepted_step
       ) VALUES ($1::uuid, 'TOTP', $2, 'ACTIVE', NULL)`,
      [adminUserId, totpSeal],
    );

    await client.query(
      `UPDATE owner_bootstrap_grants
       SET status = 'CONSUMED', consumed_at = now()
       WHERE grant_id = $1::uuid AND status = 'ISSUED'`,
      [attempt.grant_id],
    );
    await client.query(
      `UPDATE owner_bootstrap_attempts
       SET pop_status = 'CONSUMED',
           consumed_at = now(),
           enrollment_ticket_hash = NULL
       WHERE attempt_id = $1::uuid`,
      [input.attemptId],
    );

    await client.query(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source
       ) VALUES (
         $1::uuid, 'ADMIN', 'OWNER_BOOTSTRAP_ENROLL', 'admin_users', $1::uuid,
         $2::jsonb, 'first Owner bootstrap consumed grant', 'API'
       )`,
      [
        adminUserId,
        JSON.stringify({
          grant_id: attempt.grant_id,
          attempt_id: input.attemptId,
          challenge_id: input.challengeId,
          endpoint_profile_id: attempt.endpoint_profile_id,
          channel_fp: attempt.channel_fp_hex,
          // Explicitly no secrets
        }),
      ],
    );

    return {
      status: 'ok' as const,
      value: { adminUserId, email },
    };
  });
}

/** Helper for tests: sign Owner redeem challenge with ceremony private key. */
export function signOwnerRedeemChallenge(
  authority: CeremonyAuthority,
  challengeBytes: Uint8Array,
): string {
  return base64UrlEncode(ed25519Sign(authority.privateKey, challengeBytes));
}

export function signChannelPop(
  channelSk: Uint8Array,
  input: Parameters<typeof buildChannelPopBytes>[0],
): string {
  return base64UrlEncode(ed25519Sign(channelSk, buildChannelPopBytes(input)));
}

export function signChannelAbort(
  channelSk: Uint8Array,
  input: Parameters<typeof buildChannelAbortBytes>[0],
): string {
  return base64UrlEncode(ed25519Sign(channelSk, buildChannelAbortBytes(input)));
}

export function signFinalCredReq(
  channelSk: Uint8Array,
  input: Parameters<typeof buildFinalCredBytes>[0],
): string {
  return base64UrlEncode(ed25519Sign(channelSk, buildFinalCredBytes(input)));
}

export { generateTotpSecretBytes, generateTotpCode };
