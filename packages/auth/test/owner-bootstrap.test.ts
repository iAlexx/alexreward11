/**
 * M1 Stage B â€” owner bootstrap adversarial suite (isolated disposable DB only).
 *
 * Requires OWNER_ADMIN_AUTH_DATABASE_URL / M0_DATABASE_URL / PHASE7 pointing at
 * an approved *_test database (never alex_rewards). Uses ephemeral test-only keys.
 */
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  abortOwnerBootstrapAttempt,
  assertOwnerAuthOperationalDefaultDeny,
  buildFinalCredBytes,
  buildTestGrantPayload,
  completeOwnerBootstrapEnrollment,
  createEnrollmentChannelKeypair,
  createEphemeralCeremonyAuthority,
  generateTotpCode,
  generateTotpSecretBytes,
  signChannelAbort,
  signChannelPop,
  signFinalCredReq,
  signGrantEnvelope,
  signOwnerRedeemChallenge,
  startOwnerBootstrapAttempt,
  submitOwnerBootstrapPop,
  type BootstrapTrustMaterial,
  type CeremonyAuthority,
} from '../src/index.js';
import { bytesToHex, hexToBytes } from '../src/owner-bootstrap/ed25519.js';
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
requireSecurityGateDatabaseUrl(databaseUrl, 'owner-bootstrap Stage B');

const PASSWORD = 'Owner-Bootstrap-Test-Password-12';
const PROFILE_ID = 'm1-stageb-local-profile';

process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';

describe.skipIf(databaseUrl === '')(
  'owner-bootstrap Stage B (isolated DB)',
  { timeout: 120_000 },
  () => {
  let pool: Pool;
  let authority: CeremonyAuthority;
  let trust: BootstrapTrustMaterial;

  beforeAll(async () => {
    await resetIsolatedBootstrapSchema(databaseUrl);
    authority = createEphemeralCeremonyAuthority('stageb-test-key');
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

  async function happyPath(email = 'bootstrap-owner@local.test') {
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
    const noncePop = bytesToHex(randomBytes(32));
    const now = Math.floor(Date.now() / 1000);
    const sigChannelPop = signChannelPop(channel.privateKey, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      grantId: started.grantId,
      channelFpHex: started.channelFp,
      clientUnixTime: now,
      nonce32: hexToBytes(noncePop),
    });
    const pop = await submitOwnerBootstrapPop(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      keyId: started.keyId,
      sigRedeemB64: sigRedeem,
      clientUnixTime: now,
      nonce32Hex: noncePop,
      sigChannelPopB64: sigChannelPop,
      trust,
    });
    const totpSecret = generateTotpSecretBytes();
    const code = generateTotpCode(totpSecret);
    const nonceCred = bytesToHex(randomBytes(32));
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
      nonce32: nonceCred,
    };
    const sigCred = signFinalCredReq(channel.privateKey, {
      publicHeader,
      passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
      totpSecretBytes: totpSecret,
    });
    const done = await completeOwnerBootstrapEnrollment(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      ticketId: pop.ticketId,
      enrollmentTicket: pop.enrollmentTicket,
      intendedSubject: email,
      password: PASSWORD,
      totpSecretBytes: totpSecret,
      totpConfirmCode: code,
      clientUnixTime: now,
      nonce32Hex: nonceCred,
      sigChannelCredB64: sigCred,
      trust,
    });
    return { done, started, pop, channel, envelope, payload, totpSecret };
  }

  it('valid first enrollment succeeds atomically', async () => {
    const { done } = await happyPath();
    expect(done.email).toBe('bootstrap-owner@local.test');
    const seat = await pool.query<{ holder: string | null }>(
      `SELECT holder_admin_user_id::text AS holder FROM admin_owner_authority WHERE seat = 1`,
    );
    expect(seat.rows[0]?.holder).toBe(done.adminUserId);
    const grant = await pool.query<{ status: string }>(
      `SELECT status FROM owner_bootstrap_grants`,
    );
    expect(grant.rows.every((r) => r.status === 'CONSUMED')).toBe(true);
    const creds = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_credentials WHERE admin_user_id = $1::uuid AND status = 'ACTIVE'`,
      [done.adminUserId],
    );
    expect(creds.rows[0]?.c).toBe(2);
  });

  it('FS-01 default-deny still refuses alex_rewards', () => {
    expect(() => assertOwnerAuthOperationalDefaultDeny('alex_rewards')).toThrow(/BLOCKED/);
  });

  it('missing ceremony authority refuses', async () => {
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'x@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const badTrust: BootstrapTrustMaterial = {
      ...trust,
      pinnedPublicKeys: new Map(),
    };
    await expect(
      startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel.publicKey,
        trust: badTrust,
      }),
    ).rejects.toThrow(AuthDomainError);
  });

  it('forged grant refuses', async () => {
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'x@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const forged = {
      ...envelope,
      sig: Buffer.from(randomBytes(64)).toString('base64url').replace(/A/g, 'B'),
    };
    await expect(
      startOwnerBootstrapAttempt(pool, {
        grantEnvelope: forged,
        channelPublicKey: channel.publicKey,
        trust,
      }),
    ).rejects.toThrow(AuthDomainError);
  });

  it('wrong endpoint profile refuses', async () => {
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: 'other-profile',
      intendedAdminEmail: 'x@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    await expect(
      startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel.publicKey,
        trust,
      }),
    ).rejects.toThrow(/endpoint_profile_id|mismatch/i);
  });

  it('stolen grant without PoP cannot complete', async () => {
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'x@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    await expect(
      submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: bytesToHex(randomBytes(48)),
        clientUnixTime: Math.floor(Date.now() / 1000),
        nonce32Hex: bytesToHex(randomBytes(32)),
        sigChannelPopB64: bytesToHex(randomBytes(48)),
        trust,
      }),
    ).rejects.toThrow(/REDEEM_POP|FORBIDDEN|VALIDATION/i);
    const grants = await pool.query<{ status: string }>(`SELECT status FROM owner_bootstrap_grants`);
    expect(grants.rows[0]?.status).toBe('ISSUED');
  });

  it('wrong channel key refuses PoP', async () => {
    const channel = createEnrollmentChannelKeypair();
    const other = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'x@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    const challengeBytes = hexToBytes(started.challengeBytesHex);
    const sigRedeem = signOwnerRedeemChallenge(authority, challengeBytes);
    const noncePop = bytesToHex(randomBytes(32));
    const now = Math.floor(Date.now() / 1000);
    const sigChannelPop = signChannelPop(other.privateKey, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      grantId: started.grantId,
      channelFpHex: started.channelFp,
      clientUnixTime: now,
      nonce32: hexToBytes(noncePop),
    });
    await expect(
      submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: sigRedeem,
        clientUnixTime: now,
        nonce32Hex: noncePop,
        sigChannelPopB64: sigChannelPop,
        trust,
      }),
    ).rejects.toThrow(/REDEEM_POP/i);
  });

  it('stolen PoP without channel key refuses; stolen ticket without channel refuses', async () => {
    const channel = createEnrollmentChannelKeypair();
    const attacker = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'x@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    const challengeBytes = hexToBytes(started.challengeBytesHex);
    const sigRedeem = signOwnerRedeemChallenge(authority, challengeBytes);
    // Attacker has sigRedeem but wrong channel proof
    const noncePop = bytesToHex(randomBytes(32));
    const now = Math.floor(Date.now() / 1000);
    const badPop = signChannelPop(attacker.privateKey, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      grantId: started.grantId,
      channelFpHex: started.channelFp,
      clientUnixTime: now,
      nonce32: hexToBytes(noncePop),
    });
    await expect(
      submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: sigRedeem,
        clientUnixTime: now,
        nonce32Hex: noncePop,
        sigChannelPopB64: badPop,
        trust,
      }),
    ).rejects.toThrow(/REDEEM_POP/i);

    // Legitimate PoP then stolen ticket + attacker FinalCredReq
    const noncePop2 = bytesToHex(randomBytes(32));
    const goodPop = signChannelPop(channel.privateKey, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      grantId: started.grantId,
      channelFpHex: started.channelFp,
      clientUnixTime: now,
      nonce32: hexToBytes(noncePop2),
    });
    const pop = await submitOwnerBootstrapPop(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      keyId: started.keyId,
      sigRedeemB64: sigRedeem,
      clientUnixTime: now,
      nonce32Hex: noncePop2,
      sigChannelPopB64: goodPop,
      trust,
    });
    const totpSecret = generateTotpSecretBytes();
    const nonceCred = bytesToHex(randomBytes(32));
    const publicHeader = {
      v: 1 as const,
      purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
      grant_id: started.grantId,
      attempt_id: started.attemptId,
      challenge_id: started.challengeId,
      ticket_id: pop.ticketId,
      channel_fp: started.channelFp,
      intended_subject: 'x@local.test',
      credential_setup: {
        password_encoding: 'utf8' as const,
        totp_secret_encoding: 'base32_nopad_uppercase' as const,
        totp_digits: 6 as const,
        totp_period_seconds: 30 as const,
        totp_algorithm: 'SHA1' as const,
      },
      client_unix_time: now,
      nonce32: nonceCred,
    };
    const attackerSig = signFinalCredReq(attacker.privateKey, {
      publicHeader,
      passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
      totpSecretBytes: totpSecret,
    });
    await expect(
      completeOwnerBootstrapEnrollment(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        ticketId: pop.ticketId,
        enrollmentTicket: pop.enrollmentTicket,
        intendedSubject: 'x@local.test',
        password: PASSWORD,
        totpSecretBytes: totpSecret,
        totpConfirmCode: generateTotpCode(totpSecret),
        clientUnixTime: now,
        nonce32Hex: nonceCred,
        sigChannelCredB64: attackerSig,
        trust,
      }),
    ).rejects.toThrow(/FinalCredReq|FORBIDDEN/i);
  });

  it(
    'credential substitution (password / TOTP / subject) fails closed',
    async () => {
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'sub@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    const now = Math.floor(Date.now() / 1000);
    const sigRedeem = signOwnerRedeemChallenge(authority, hexToBytes(started.challengeBytesHex));
    const noncePop = bytesToHex(randomBytes(32));
    const pop = await submitOwnerBootstrapPop(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      keyId: started.keyId,
      sigRedeemB64: sigRedeem,
      clientUnixTime: now,
      nonce32Hex: noncePop,
      sigChannelPopB64: signChannelPop(channel.privateKey, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        grantId: started.grantId,
        channelFpHex: started.channelFp,
        clientUnixTime: now,
        nonce32: hexToBytes(noncePop),
      }),
      trust,
    });
    const totpSecret = generateTotpSecretBytes();
    const baseHeader = {
      v: 1 as const,
      purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
      grant_id: started.grantId,
      attempt_id: started.attemptId,
      challenge_id: started.challengeId,
      ticket_id: pop.ticketId,
      channel_fp: started.channelFp,
      intended_subject: 'sub@local.test',
      credential_setup: {
        password_encoding: 'utf8' as const,
        totp_secret_encoding: 'base32_nopad_uppercase' as const,
        totp_digits: 6 as const,
        totp_period_seconds: 30 as const,
        totp_algorithm: 'SHA1' as const,
      },
      client_unix_time: now,
      nonce32: bytesToHex(randomBytes(32)),
    };
    const goodSig = signFinalCredReq(channel.privateKey, {
      publicHeader: baseHeader,
      passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
      totpSecretBytes: totpSecret,
    });

    // Replace password under captured signature
    await expect(
      completeOwnerBootstrapEnrollment(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        ticketId: pop.ticketId,
        enrollmentTicket: pop.enrollmentTicket,
        intendedSubject: 'sub@local.test',
        password: 'Owner-Bootstrap-Test-Password-99',
        totpSecretBytes: totpSecret,
        totpConfirmCode: generateTotpCode(totpSecret),
        clientUnixTime: now,
        nonce32Hex: baseHeader.nonce32,
        sigChannelCredB64: goodSig,
        trust,
      }),
    ).rejects.toThrow(/FinalCredReq|FORBIDDEN/i);

    // Replace TOTP
    const otherTotp = generateTotpSecretBytes();
    await expect(
      completeOwnerBootstrapEnrollment(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        ticketId: pop.ticketId,
        enrollmentTicket: pop.enrollmentTicket,
        intendedSubject: 'sub@local.test',
        password: PASSWORD,
        totpSecretBytes: otherTotp,
        totpConfirmCode: generateTotpCode(otherTotp),
        clientUnixTime: now,
        nonce32Hex: baseHeader.nonce32,
        sigChannelCredB64: goodSig,
        trust,
      }),
    ).rejects.toThrow(/FinalCredReq|FORBIDDEN|TOTP|VALIDATION/i);

    // Replace intended subject (signature over wrong subject)
    const evilHeader = { ...baseHeader, intended_subject: 'evil@local.test', nonce32: bytesToHex(randomBytes(32)) };
    const evilSig = signFinalCredReq(channel.privateKey, {
      publicHeader: evilHeader,
      passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
      totpSecretBytes: totpSecret,
    });
    await expect(
      completeOwnerBootstrapEnrollment(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        ticketId: pop.ticketId,
        enrollmentTicket: pop.enrollmentTicket,
        intendedSubject: 'evil@local.test',
        password: PASSWORD,
        totpSecretBytes: totpSecret,
        totpConfirmCode: generateTotpCode(totpSecret),
        clientUnixTime: now,
        nonce32Hex: evilHeader.nonce32,
        sigChannelCredB64: evilSig,
        trust,
      }),
    ).rejects.toThrow(/intended_subject|FORBIDDEN/i);

    const users = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM admin_users`);
    expect(users.rows[0]?.c).toBe(0);
    const grants = await pool.query<{ status: string }>(`SELECT status FROM owner_bootstrap_grants`);
    expect(grants.rows[0]?.status).toBe('ISSUED');
  },
  30_000,
  );

  it('PoP replay after VERIFIED refuses second ticket', async () => {
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'replay@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    const now = Math.floor(Date.now() / 1000);
    const sigRedeem = signOwnerRedeemChallenge(authority, hexToBytes(started.challengeBytesHex));
    const noncePop = bytesToHex(randomBytes(32));
    const sigChannelPop = signChannelPop(channel.privateKey, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      grantId: started.grantId,
      channelFpHex: started.channelFp,
      clientUnixTime: now,
      nonce32: hexToBytes(noncePop),
    });
    await submitOwnerBootstrapPop(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      keyId: started.keyId,
      sigRedeemB64: sigRedeem,
      clientUnixTime: now,
      nonce32Hex: noncePop,
      sigChannelPopB64: sigChannelPop,
      trust,
    });
    await expect(
      submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: sigRedeem,
        clientUnixTime: now,
        nonce32Hex: noncePop,
        sigChannelPopB64: sigChannelPop,
        trust,
      }),
    ).rejects.toThrow(AuthDomainError);
  });

  it('concurrent attempts: at most one CONSUME', async () => {
    const email = 'concurrent@local.test';
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: email,
    });
    const envelope = signGrantEnvelope(payload, authority);
    const ch1 = createEnrollmentChannelKeypair();
    const ch2 = createEnrollmentChannelKeypair();
    const a1 = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: ch1.publicKey,
      trust,
    });
    const a2 = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: ch2.publicKey,
      trust,
    });
    // a1 should be SUPERSEDED
    const st = await pool.query<{ pop_status: string }>(
      `SELECT pop_status FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
      [a1.attemptId],
    );
    expect(st.rows[0]?.pop_status).toBe('SUPERSEDED');
    expect(a2.attemptId).not.toBe(a1.attemptId);

    // Complete a2 only
    const now = Math.floor(Date.now() / 1000);
    const sigRedeem = signOwnerRedeemChallenge(authority, hexToBytes(a2.challengeBytesHex));
    const noncePop = bytesToHex(randomBytes(32));
    const pop = await submitOwnerBootstrapPop(pool, {
      attemptId: a2.attemptId,
      challengeId: a2.challengeId,
      keyId: a2.keyId,
      sigRedeemB64: sigRedeem,
      clientUnixTime: now,
      nonce32Hex: noncePop,
      sigChannelPopB64: signChannelPop(ch2.privateKey, {
        attemptId: a2.attemptId,
        challengeId: a2.challengeId,
        grantId: a2.grantId,
        channelFpHex: a2.channelFp,
        clientUnixTime: now,
        nonce32: hexToBytes(noncePop),
      }),
      trust,
    });
    const totpSecret = generateTotpSecretBytes();
    const nonceCred = bytesToHex(randomBytes(32));
    const publicHeader = {
      v: 1 as const,
      purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
      grant_id: a2.grantId,
      attempt_id: a2.attemptId,
      challenge_id: a2.challengeId,
      ticket_id: pop.ticketId,
      channel_fp: a2.channelFp,
      intended_subject: email,
      credential_setup: {
        password_encoding: 'utf8' as const,
        totp_secret_encoding: 'base32_nopad_uppercase' as const,
        totp_digits: 6 as const,
        totp_period_seconds: 30 as const,
        totp_algorithm: 'SHA1' as const,
      },
      client_unix_time: now,
      nonce32: nonceCred,
    };
    await completeOwnerBootstrapEnrollment(pool, {
      attemptId: a2.attemptId,
      challengeId: a2.challengeId,
      ticketId: pop.ticketId,
      enrollmentTicket: pop.enrollmentTicket,
      intendedSubject: email,
      password: PASSWORD,
      totpSecretBytes: totpSecret,
      totpConfirmCode: generateTotpCode(totpSecret),
      clientUnixTime: now,
      nonce32Hex: nonceCred,
      sigChannelCredB64: signFinalCredReq(ch2.privateKey, {
        publicHeader,
        passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
        totpSecretBytes: totpSecret,
      }),
      trust,
    });
    const owners = await pool.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM admin_role_bindings b
       INNER JOIN admin_roles r ON r.id = b.role_id
       WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
    );
    expect(owners.rows[0]?.c).toBe(1);
  });

  it('existing Owner refuses second bootstrap', async () => {
    await happyPath('first@local.test');
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'second@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    await expect(
      startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel.publicKey,
        trust,
      }),
    ).rejects.toThrow(/seat|history|OWNER/i);
  });

  it('abort/restart requires new authenticated attempt', async () => {
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'abort@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    const now = Math.floor(Date.now() / 1000);
    const nonceAbort = bytesToHex(randomBytes(32));
    await abortOwnerBootstrapAttempt(pool, {
      attemptId: started.attemptId,
      challengeId: started.challengeId,
      clientUnixTime: now,
      nonce32Hex: nonceAbort,
      sigChannelAbortB64: signChannelAbort(channel.privateKey, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        grantId: started.grantId,
        channelFpHex: started.channelFp,
        clientUnixTime: now,
        nonce32: hexToBytes(nonceAbort),
      }),
      trust,
    });
    const sigRedeem = signOwnerRedeemChallenge(authority, hexToBytes(started.challengeBytesHex));
    const noncePop = bytesToHex(randomBytes(32));
    await expect(
      submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: sigRedeem,
        clientUnixTime: now,
        nonce32Hex: noncePop,
        sigChannelPopB64: signChannelPop(channel.privateKey, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          grantId: started.grantId,
          channelFpHex: started.channelFp,
          clientUnixTime: now,
          nonce32: hexToBytes(noncePop),
        }),
        trust,
      }),
    ).rejects.toThrow(AuthDomainError);
  });

  it('expired challenge refuses', async () => {
    const { setIsolatedTestBootstrapClock, clearIsolatedTestBootstrapClock } = await import(
      '../src/owner-bootstrap/pool.js'
    );
    const channel = createEnrollmentChannelKeypair();
    const wall = Math.floor(Date.now() / 1000);
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: 'exp@local.test',
      nowSec: wall,
      lifetimeSec: 900,
    });
    const envelope = signGrantEnvelope(payload, authority);
    setIsolatedTestBootstrapClock(pool, wall);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    // Advance past challenge TTL (300s) while grant remains valid.
    const later = wall + 301;
    setIsolatedTestBootstrapClock(pool, later);
    const sigRedeem = signOwnerRedeemChallenge(authority, hexToBytes(started.challengeBytesHex));
    const noncePop = bytesToHex(randomBytes(32));
    await expect(
      submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: sigRedeem,
        clientUnixTime: later,
        nonce32Hex: noncePop,
        sigChannelPopB64: signChannelPop(channel.privateKey, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          grantId: started.grantId,
          channelFpHex: started.channelFp,
          clientUnixTime: later,
          nonce32: hexToBytes(noncePop),
        }),
        trust,
      }),
    ).rejects.toThrow(/expired/i);
    clearIsolatedTestBootstrapClock(pool);
  });

  it('audit snapshot has no password/ticket/totp material', async () => {
    await happyPath('audit@local.test');
    const audits = await pool.query<{ after_snapshot: Record<string, unknown> }>(
      `SELECT after_snapshot FROM audit_logs WHERE action_type = 'OWNER_BOOTSTRAP_ENROLL'`,
    );
    const snap = JSON.stringify(audits.rows[0]?.after_snapshot ?? {});
    expect(snap.toLowerCase()).not.toContain('password');
    expect(snap.toLowerCase()).not.toContain(PASSWORD.toLowerCase());
    // channel_fp (64 hex) is allowed public material; forbid secret field names
    expect(snap).not.toContain('enrollment_ticket');
    expect(snap).not.toContain('totp');
    expect(snap).not.toContain('password_verifier');
  });

  it('documents residual: FinalCredReq bytes bind full request (buildFinalCredBytes differs on password)', () => {
    const header = {
      v: 1 as const,
      purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
      grant_id: '00000000-0000-4000-8000-000000000001',
      attempt_id: '00000000-0000-4000-8000-000000000002',
      challenge_id: '00000000-0000-4000-8000-000000000003',
      ticket_id: '00000000-0000-4000-8000-000000000004',
      channel_fp: bytesToHex(randomBytes(32)),
      intended_subject: 'a@b.c',
      credential_setup: {
        password_encoding: 'utf8' as const,
        totp_secret_encoding: 'base32_nopad_uppercase' as const,
        totp_digits: 6 as const,
        totp_period_seconds: 30 as const,
        totp_algorithm: 'SHA1' as const,
      },
      client_unix_time: 1,
      nonce32: bytesToHex(randomBytes(32)),
    };
    const totp = generateTotpSecretBytes();
    const a = buildFinalCredBytes({
      publicHeader: header,
      passwordUtf8: Buffer.from('aaa', 'utf8'),
      totpSecretBytes: totp,
    });
    const b = buildFinalCredBytes({
      publicHeader: header,
      passwordUtf8: Buffer.from('bbb', 'utf8'),
      totpSecretBytes: totp,
    });
    expect(Buffer.compare(a, b)).not.toBe(0);
  });
});
