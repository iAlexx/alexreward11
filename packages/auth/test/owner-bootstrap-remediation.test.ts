/**
 * M1 Stage B narrow remediation — M1-B-01 / M1-B-02 / M1-B-03.
 * Isolated alex_rewards_test only. Ephemeral test keys only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  abortOwnerBootstrapAttempt,
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
import { parseAndVerifyGrantEnvelope } from '../src/owner-bootstrap/grant.js';
import {
  forceNumericLoopbackUrl,
  openBootstrapTestPool,
  requireSecurityGateDatabaseUrl,
  resetIsolatedBootstrapSchema,
  setTestClock,
} from './owner-bootstrap-harness.js';

const rawDatabaseUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.M0_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  '';
const databaseUrl =
  rawDatabaseUrl !== '' ? forceNumericLoopbackUrl(rawDatabaseUrl) : '';
requireSecurityGateDatabaseUrl(databaseUrl, 'M1-B remediation');

const PASSWORD = 'Owner-Bootstrap-Test-Password-12';
const PROFILE_ID = 'm1-stageb-remediation-profile';

process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';

async function assertNoOwnerResidue(pool: Pool): Promise<void> {
  const owners = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id WHERE r.code = 'OWNER'`,
  );
  expect(owners.rows[0]?.c ?? -1).toBe(0);
  const creds = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM admin_credentials`,
  );
  expect(creds.rows[0]?.c ?? -1).toBe(0);
  const consumed = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM owner_bootstrap_grants WHERE status = 'CONSUMED'`,
  );
  expect(consumed.rows[0]?.c ?? -1).toBe(0);
}

describe.skipIf(databaseUrl === '')(
  'M1-B remediation (isolated DB)',
  { timeout: 120_000 },
  () => {
  let pool: Pool;
  let authority: CeremonyAuthority;
  let trust: BootstrapTrustMaterial;

  beforeAll(async () => {
    await resetIsolatedBootstrapSchema(databaseUrl);
    authority = createEphemeralCeremonyAuthority('stageb-remediation-key');
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

  async function startFresh(email: string, nowSec: number, lifetimeSec = 900) {
    setTestClock(pool, nowSec);
    const channel = createEnrollmentChannelKeypair();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: PROFILE_ID,
      intendedAdminEmail: email,
      nowSec,
      lifetimeSec,
    });
    const envelope = signGrantEnvelope(payload, authority);
    const started = await startOwnerBootstrapAttempt(pool, {
      grantEnvelope: envelope,
      channelPublicKey: channel.publicKey,
      trust,
    });
    return { channel, payload, envelope, started };
  }

  // ---------- M1-B-01 ----------
  describe('M1-B-01 grant expiration', () => {
    it('rejects when grant expires before PoP; no OWNER residue', async () => {
      const now = 1_700_000_000;
      const { channel, started } = await startFresh('exp-pop@local.test', now, 120);
      const later = now + 121; // >= exp
      setTestClock(pool, later);
      const sigRedeem = signOwnerRedeemChallenge(
        authority,
        hexToBytes(started.challengeBytesHex),
      );
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
      ).rejects.toThrow(/grant expired/i);
      await assertNoOwnerResidue(pool);
    });

    it('rejects exact expiry boundary (now === exp)', async () => {
      const authorityLocal = authority;
      const payload = buildTestGrantPayload({
        authority: authorityLocal,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: 'boundary@local.test',
        nowSec: 1_700_000_000,
        lifetimeSec: 100,
      });
      const envelope = signGrantEnvelope(payload, authorityLocal);
      const pins = new Map([[authorityLocal.keyId, authorityLocal.publicKey]]);
      expect(() =>
        parseAndVerifyGrantEnvelope(envelope, pins, payload.exp),
      ).toThrow(/grant expired/i);
      // now === exp - 1 still ok at parse
      expect(() =>
        parseAndVerifyGrantEnvelope(envelope, pins, payload.exp - 1),
      ).not.toThrow();
    });

    it('rejects when grant expires between PoP and final enrollment (valid ticket)', async () => {
      const now = 1_700_000_000;
      const { channel, started } = await startFresh('exp-final@local.test', now, 300);
      const sigRedeem = signOwnerRedeemChallenge(
        authority,
        hexToBytes(started.challengeBytesHex),
      );
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
      const later = now + 301;
      setTestClock(pool, later);
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
        intended_subject: 'exp-final@local.test',
        credential_setup: {
          password_encoding: 'utf8' as const,
          totp_secret_encoding: 'base32_nopad_uppercase' as const,
          totp_digits: 6 as const,
          totp_period_seconds: 30 as const,
          totp_algorithm: 'SHA1' as const,
        },
        client_unix_time: later,
        nonce32: nonceCred,
      };
      await expect(
        completeOwnerBootstrapEnrollment(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          ticketId: pop.ticketId,
          enrollmentTicket: pop.enrollmentTicket,
          intendedSubject: 'exp-final@local.test',
          password: PASSWORD,
          totpSecretBytes: totpSecret,
          totpConfirmCode: generateTotpCode(totpSecret),
          clientUnixTime: later,
          nonce32Hex: nonceCred,
          sigChannelCredB64: signFinalCredReq(channel.privateKey, {
            publicHeader,
            passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
            totpSecretBytes: totpSecret,
          }),
          trust,
        }),
      ).rejects.toThrow(/grant expired/i);
      await assertNoOwnerResidue(pool);
      const attempt = await pool.query<{ pop_status: string }>(
        `SELECT pop_status FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
        [started.attemptId],
      );
      expect(attempt.rows[0]?.pop_status).toBe('VERIFIED'); // rolled back; still VERIFIED, not CONSUMED
    });
  });

  // ---------- M1-B-02 ----------
  describe('M1-B-02 immutable grant identity', () => {
    it('identical grant re-present is idempotent (second attempt ok)', async () => {
      const now = Math.floor(Date.now() / 1000);
      const channel1 = createEnrollmentChannelKeypair();
      const payload = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: 'idem@local.test',
        nowSec: now,
        grantId: randomUUID(),
      });
      const envelope = signGrantEnvelope(payload, authority);
      await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel1.publicKey,
        trust,
      });
      const channel2 = createEnrollmentChannelKeypair();
      const again = await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel2.publicKey,
        trust,
      });
      expect(again.grantId).toBe(payload.grant_id);
      const rows = await pool.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
        [payload.grant_id],
      );
      expect(rows.rows[0]?.c).toBe(1);
    });

    it('same grant_id different signed payload rejects', async () => {
      const now = Math.floor(Date.now() / 1000);
      const grantId = randomUUID();
      const channel = createEnrollmentChannelKeypair();
      const payloadA = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: 'a@local.test',
        nowSec: now,
        grantId,
      });
      await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: signGrantEnvelope(payloadA, authority),
        channelPublicKey: channel.publicKey,
        trust,
      });
      const payloadB = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: 'b@local.test',
        nowSec: now,
        grantId,
      });
      await expect(
        startOwnerBootstrapAttempt(pool, {
          grantEnvelope: signGrantEnvelope(payloadB, authority),
          channelPublicKey: createEnrollmentChannelKeypair().publicKey,
          trust,
        }),
      ).rejects.toThrow(/grant identity mismatch/i);
      await assertNoOwnerResidue(pool);
    });

    it('same grant_id different exp rejects', async () => {
      const now = Math.floor(Date.now() / 1000);
      const grantId = randomUUID();
      const channel = createEnrollmentChannelKeypair();
      const payloadA = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: 'exp@local.test',
        nowSec: now,
        lifetimeSec: 600,
        grantId,
      });
      await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: signGrantEnvelope(payloadA, authority),
        channelPublicKey: channel.publicKey,
        trust,
      });
      const payloadB = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: 'exp@local.test',
        nowSec: now,
        lifetimeSec: 700,
        grantId,
      });
      // Force same nonce would fail schema uniqueness on nonce — use different nonce via builder
      await expect(
        startOwnerBootstrapAttempt(pool, {
          grantEnvelope: signGrantEnvelope(payloadB, authority),
          channelPublicKey: createEnrollmentChannelKeypair().publicKey,
          trust,
        }),
      ).rejects.toThrow(/grant identity mismatch/i);
    });

    it('same grant_id different endpoint rejects', async () => {
      const now = Math.floor(Date.now() / 1000);
      const grantId = randomUUID();
      const channel = createEnrollmentChannelKeypair();
      const payloadA = buildTestGrantPayload({
        authority,
        endpointProfileId: PROFILE_ID,
        intendedAdminEmail: 'ep@local.test',
        nowSec: now,
        grantId,
      });
      await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: signGrantEnvelope(payloadA, authority),
        channelPublicKey: channel.publicKey,
        trust,
      });
      const payloadB = buildTestGrantPayload({
        authority,
        endpointProfileId: 'other-profile-id',
        intendedAdminEmail: 'ep@local.test',
        nowSec: now,
        grantId,
      });
      // Will fail endpoint mismatch on profile assert OR identity — either is refuse
      await expect(
        startOwnerBootstrapAttempt(pool, {
          grantEnvelope: signGrantEnvelope(payloadB, authority),
          channelPublicKey: createEnrollmentChannelKeypair().publicKey,
          trust,
        }),
      ).rejects.toThrow(AuthDomainError);
      await assertNoOwnerResidue(pool);
    });
  });

  // ---------- M1-B-03 ----------
  describe('M1-B-03 authorized abort', () => {
    it('unauthorized abort of PENDING refuses', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { started } = await startFresh('abort-unauth@local.test', now);
      await expect(
        abortOwnerBootstrapAttempt(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          clientUnixTime: now,
          nonce32Hex: bytesToHex(randomBytes(32)),
          sigChannelAbortB64: bytesToHex(randomBytes(48)),
          trust,
        }),
      ).rejects.toThrow(AuthDomainError);
      const st = await pool.query<{ pop_status: string }>(
        `SELECT pop_status FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
        [started.attemptId],
      );
      expect(st.rows[0]?.pop_status).toBe('PENDING');
    });

    it('wrong channel key refuses abort', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { channel, started } = await startFresh('abort-wrong@local.test', now);
      void channel;
      const attacker = createEnrollmentChannelKeypair();
      const nonce = bytesToHex(randomBytes(32));
      await expect(
        abortOwnerBootstrapAttempt(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          clientUnixTime: now,
          nonce32Hex: nonce,
          sigChannelAbortB64: signChannelAbort(attacker.privateKey, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            grantId: started.grantId,
            channelFpHex: started.channelFp,
            clientUnixTime: now,
            nonce32: hexToBytes(nonce),
          }),
          trust,
        }),
      ).rejects.toThrow(/abort channel proof/i);
    });

    it('correct key wrong attempt refuses', async () => {
      const now = Math.floor(Date.now() / 1000);
      const a = await startFresh('abort-a@local.test', now);
      const b = await startFresh('abort-b@local.test', now);
      const nonce = bytesToHex(randomBytes(32));
      await expect(
        abortOwnerBootstrapAttempt(pool, {
          attemptId: b.started.attemptId,
          challengeId: b.started.challengeId,
          clientUnixTime: now,
          nonce32Hex: nonce,
          sigChannelAbortB64: signChannelAbort(a.channel.privateKey, {
            attemptId: b.started.attemptId,
            challengeId: b.started.challengeId,
            grantId: b.started.grantId,
            channelFpHex: b.started.channelFp,
            clientUnixTime: now,
            nonce32: hexToBytes(nonce),
          }),
          trust,
        }),
      ).rejects.toThrow(/abort channel proof/i);
    });

    it('legitimate authenticated abort then restart with new attempt', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { channel, started, envelope } = await startFresh('abort-ok@local.test', now);
      const nonce = bytesToHex(randomBytes(32));
      await abortOwnerBootstrapAttempt(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        clientUnixTime: now,
        nonce32Hex: nonce,
        sigChannelAbortB64: signChannelAbort(channel.privateKey, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          grantId: started.grantId,
          channelFpHex: started.channelFp,
          clientUnixTime: now,
          nonce32: hexToBytes(nonce),
        }),
        trust,
      });
      const st = await pool.query<{ pop_status: string }>(
        `SELECT pop_status FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
        [started.attemptId],
      );
      expect(st.rows[0]?.pop_status).toBe('ABORTED');

      // Replay abort nonce
      await expect(
        abortOwnerBootstrapAttempt(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          clientUnixTime: now,
          nonce32Hex: nonce,
          sigChannelAbortB64: signChannelAbort(channel.privateKey, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            grantId: started.grantId,
            channelFpHex: started.channelFp,
            clientUnixTime: now,
            nonce32: hexToBytes(nonce),
          }),
          trust,
        }),
      ).rejects.toThrow(AuthDomainError);

      // New attempt with new channel
      const channel2 = createEnrollmentChannelKeypair();
      const restarted = await startOwnerBootstrapAttempt(pool, {
        grantEnvelope: envelope,
        channelPublicKey: channel2.publicKey,
        trust,
      });
      expect(restarted.attemptId).not.toBe(started.attemptId);
      expect(restarted.channelFp).not.toBe(started.channelFp);
    });

    it('unauthorized abort of VERIFIED refuses', async () => {
      const now = Math.floor(Date.now() / 1000);
      const { channel, started } = await startFresh('abort-ver@local.test', now);
      const noncePop = bytesToHex(randomBytes(32));
      await submitOwnerBootstrapPop(pool, {
        attemptId: started.attemptId,
        challengeId: started.challengeId,
        keyId: started.keyId,
        sigRedeemB64: signOwnerRedeemChallenge(
          authority,
          hexToBytes(started.challengeBytesHex),
        ),
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
      const attacker = createEnrollmentChannelKeypair();
      const nonce = bytesToHex(randomBytes(32));
      await expect(
        abortOwnerBootstrapAttempt(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          clientUnixTime: now,
          nonce32Hex: nonce,
          sigChannelAbortB64: signChannelAbort(attacker.privateKey, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            grantId: started.grantId,
            channelFpHex: started.channelFp,
            clientUnixTime: now,
            nonce32: hexToBytes(nonce),
          }),
          trust,
        }),
      ).rejects.toThrow(/abort channel proof/i);
      const st = await pool.query<{ pop_status: string }>(
        `SELECT pop_status FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
        [started.attemptId],
      );
      expect(st.rows[0]?.pop_status).toBe('VERIFIED');
    });
  });
});
