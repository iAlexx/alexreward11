/**
 * Adversarial regression for original review findings PR-02 / PR-03 / PR-04.
 * Synthetic data only. Isolated DB for PR-02; no operational DB mutation.
 */
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  buildFinalCredBytes,
  buildTestGrantPayload,
  completeOwnerBootstrapEnrollment,
  createEnrollmentChannelKeypair,
  createEphemeralCeremonyAuthority,
  digestCeremonyEndpointProfileV1,
  generateTotpCode,
  generateTotpSecretBytes,
  signChannelPop,
  signFinalCredReq,
  signGrantEnvelope,
  signOwnerRedeemChallenge,
  startOwnerBootstrapAttempt,
  submitOwnerBootstrapPop,
  type BootstrapTrustMaterial,
  type CeremonyAuthority,
  type CeremonyEndpointProfileV1,
} from '../src/index.js';
import { bytesToHex, hexToBytes } from '../src/owner-bootstrap/ed25519.js';
import { validateGrantPayload } from '../src/owner-bootstrap/grant.js';
import { canonicalizeToJcs, JcsError } from '../src/owner-bootstrap/jcs.js';
import { parseStrictJson } from '../src/owner-bootstrap/strict-json.js';
import {
  forceNumericLoopbackUrl,
  openBootstrapTestPool,
  requireSecurityGateDatabaseUrl,
  resetIsolatedBootstrapSchema,
} from './owner-bootstrap-harness.js';

const explicitUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.M0_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  '';
const optedInUrl =
  process.env.OWNER_BOOTSTRAP_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const rawDatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;
const databaseUrl =
  rawDatabaseUrl !== '' ? forceNumericLoopbackUrl(rawDatabaseUrl) : '';
requireSecurityGateDatabaseUrl(databaseUrl, 'PR-02/03/04 regression');

const PASSWORD = 'Owner-Bootstrap-Test-Password-12';
const PROFILE_ID = 'm1-pr-nonce-profile';

/** G2 Vector A — must remain valid after JCS surrogate hardening. */
const VECTOR_A: CeremonyEndpointProfileV1 = {
  v: 1,
  profile_id: 'example-profile-v1',
  deployment_env: 'staging',
  expected_database_name: 'alex_rewards',
  tls: {
    mode: 'verify_full',
    ca_pem:
      '-----BEGIN CERTIFICATE-----\nMIIBTESTONLYNOTAREALCERT\n-----END CERTIFICATE-----\n',
    tls_server_name: 'db.example.invalid',
  },
};
const DIGEST_A = 'af8d279c39a2c274c6372f8b52de7fde9d73c686db392c60688b9593203b8035';

describe('PR-03 unpaired UTF-16 surrogates in JCS', () => {
  it('rejects lone high surrogate in values', () => {
    const lone = String.fromCharCode(0xd800);
    expect(() => canonicalizeToJcs({ k: lone })).toThrow(JcsError);
    expect(() => canonicalizeToJcs({ k: lone })).toThrow(/unpaired UTF-16 surrogate/);
  });

  it('rejects lone low surrogate in keys', () => {
    const loneLow = String.fromCharCode(0xdc00);
    const obj: Record<string, unknown> = {};
    obj[loneLow] = 1;
    expect(() => canonicalizeToJcs(obj)).toThrow(/unpaired UTF-16 surrogate/);
  });

  it('rejects unpaired \\u escapes in strict JSON strings', () => {
    expect(() => parseStrictJson('{"a":"\\uD800"}')).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => parseStrictJson('{"a":"\\uDC00"}')).toThrow(/unpaired UTF-16 surrogate/);
  });

  it('accepts a valid surrogate pair and keeps G2 Vector A digest', () => {
    const pair = String.fromCharCode(0xd83d, 0xde00); // U+1F600
    expect(canonicalizeToJcs({ e: pair })).toBe(`{"e":"${pair}"}`);
    expect(digestCeremonyEndpointProfileV1(VECTOR_A)).toBe(DIGEST_A);
  });
});

describe('PR-04 __proto__ / inherited-field strict JSON', () => {
  it('does not mutate prototype when parsing __proto__ key', () => {
    const parsed = parseStrictJson('{"__proto__":{"polluted":true},"a":1}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.hasOwn(parsed, 'a')).toBe(true);
    expect(parsed.a).toBe(1);
    expect((parsed as { polluted?: unknown }).polluted).toBeUndefined();
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('schema validation requires own properties (rejects inherited required fields)', () => {
    const inherited = Object.create({
      v: 1,
      purpose: 'FIRST_OWNER_ENROLLMENT',
      grant_id: '11111111-1111-4111-8111-111111111111',
      deployment_env: 'isolated_test',
      endpoint_profile_id: 'example-profile-v1',
      owner_identity_ref: {
        kind: 'human_owner_ceremony',
        subject_display: 'x',
        ceremony_id: '22222222-2222-4222-8222-222222222222',
        evidence_fingerprint: 'a'.repeat(64),
      },
      iat: 1,
      exp: 2,
      key_id: 'k1',
      nonce: 'b'.repeat(64),
    }) as Record<string, unknown>;
    // Own props empty → every required field is only inherited.
    expect(() => validateGrantPayload(inherited)).toThrow(AuthDomainError);
    expect(() => validateGrantPayload(inherited)).toThrow(/missing grant field/);
  });
});

describe.skipIf(databaseUrl === '')(
  'PR-02 attempt-wide nonce uniqueness (isolated DB)',
  { timeout: 120_000 },
  () => {
    let pool: Pool;
    let authority: CeremonyAuthority;
    let trust: BootstrapTrustMaterial;

    beforeAll(async () => {
      process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
      await resetIsolatedBootstrapSchema(databaseUrl);
      authority = createEphemeralCeremonyAuthority('pr02-test-key');
      const opened = await openBootstrapTestPool({
        databaseUrl,
        profileId: PROFILE_ID,
        authority,
      });
      pool = opened.bootstrap.pool;
      trust = opened.trust;
    });

    afterAll(async () => {
      await pool?.end();
    });

    beforeEach(async () => {
      await resetIsolatedBootstrapSchema(databaseUrl);
      const opened = await openBootstrapTestPool({
        databaseUrl,
        profileId: PROFILE_ID,
        authority,
      });
      await pool.end();
      pool = opened.bootstrap.pool;
      trust = opened.trust;
    });

    it('rejects channel_cred reuse of the same nonce32 used for channel_pop', async () => {
      const email = 'pr02-cross-purpose@local.test';
      const channel = createEnrollmentChannelKeypair();
      const payload = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: email,
      });
      const envelope = signGrantEnvelope(payload, authority);
      const started = await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel.publicKey,
        trust,
      });
      const challengeBytes = hexToBytes(started.challengeBytesHex);
      const sigRedeem = signOwnerRedeemChallenge(authority, challengeBytes);
      const sharedNonce = bytesToHex(randomBytes(32));
      const now = Math.floor(Date.now() / 1000);
      const sigChannelPop = signChannelPop(channel.privateKey, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        grantId: started.grantId,
        channelFpHex: started.channelFp,
        clientUnixTime: now,
        nonce32: hexToBytes(sharedNonce),
      });
      const pop = await submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: sigRedeem,
        clientUnixTime: now,
        nonce32Hex: sharedNonce,
        sigChannelPopB64: sigChannelPop,
        trust,
      });

      const pk = await pool.query<{ attname: string }>(
        `SELECT a.attname
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
         WHERE i.indrelid = 'owner_bootstrap_attempt_nonces'::regclass AND i.indisprimary`,
      );
      const pkCols = pk.rows.map((r) => r.attname).sort();
      expect(pkCols).toEqual(['attempt_id', 'nonce_hex']);
      expect(pkCols).not.toContain('purpose');

      const totpSecret = generateTotpSecretBytes();
      const code = generateTotpCode(totpSecret);
      const publicHeader = {
        v: 1 as const,
        purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
        grant_id: started.grantId,
        attempt_id: started.attemptId,
        challenge_id: started.challengeId,
        ticket_id: pop.ticketId,
        channel_fp: started.channelFp,
        intended_subject: email,
        credential_setup: {
          password_encoding: 'utf8' as const,
          totp_secret_encoding: 'base32_nopad_uppercase' as const,
          totp_digits: 6 as const,
          totp_period_seconds: 30 as const,
          totp_algorithm: 'SHA1' as const,
        },
        client_unix_time: now,
        nonce32: sharedNonce,
      };
      const sigCred = signFinalCredReq(channel.privateKey, {
        publicHeader,
        passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
        totpSecretBytes: totpSecret,
      });
      // Domain separation still signs distinct layouts; uniqueness is orthogonal.
      expect(
        buildFinalCredBytes({
          publicHeader,
          passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
          totpSecretBytes: totpSecret,
        }).byteLength,
      ).toBeGreaterThan(0);

      await expect(
        completeOwnerBootstrapEnrollment(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          ticketId: pop.ticketId,
          enrollmentTicket: pop.enrollmentTicket,
          intendedSubject: email,
          password: PASSWORD,
          totpSecretBytes: totpSecret,
          totpConfirmCode: code,
          clientUnixTime: now,
          nonce32Hex: sharedNonce,
          sigChannelCredB64: sigCred,
          trust,
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringMatching(/nonce replay/i),
      });
    });

    it('rejects direct cross-purpose INSERT of the same nonce_hex', async () => {
      const email = 'pr02-sql@local.test';
      const channel = createEnrollmentChannelKeypair();
      const payload = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: email,
      });
      const envelope = signGrantEnvelope(payload, authority);
      const started = await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel.publicKey,
        trust,
      });
      const nonce = bytesToHex(randomBytes(32));
      await pool.query(
        `INSERT INTO owner_bootstrap_attempt_nonces (attempt_id, purpose, nonce_hex)
         VALUES ($1::uuid, 'channel_pop', $2)`,
        [started.attemptId, nonce],
      );
      await expect(
        pool.query(
          `INSERT INTO owner_bootstrap_attempt_nonces (attempt_id, purpose, nonce_hex)
           VALUES ($1::uuid, 'channel_cred', $2)`,
          [started.attemptId, nonce],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  },
);
