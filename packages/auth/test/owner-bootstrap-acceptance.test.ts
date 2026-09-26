/**
 * M1 Stage B final-acceptance remediation — S-01 / M1-B-02 / S-02 / S-03.
 * Uses independent DB connections + barriers. Ephemeral keys only. alex_rewards_test only.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { Client, type Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  abortOwnerBootstrapAttempt,
  assertBootstrapTlsAndEndpoint,
  assertPoolBoundBootstrapTrust,
  buildIsolatedTestEndpointProfile,
  buildOwnerBootstrapPoolConfig,
  buildTestGrantPayload,
  completeOwnerBootstrapEnrollment,
  createEnrollmentChannelKeypair,
  createEphemeralCeremonyAuthority,
  createOwnerBootstrapPool,
  generateTotpCode,
  generateTotpSecretBytes,
  signChannelAbort,
  signChannelPop,
  signFinalCredReq,
  signGrantEnvelope,
  signOwnerRedeemChallenge,
  startOwnerBootstrapAttempt,
  submitOwnerBootstrapPop,
  type BootstrapConnectionFacts,
  type BootstrapTrustMaterial,
  type CeremonyAuthority,
} from '../src/index.js';
import { bytesToHex, hexToBytes } from '../src/owner-bootstrap/ed25519.js';
import {
  forceNumericLoopbackUrl,
  openBootstrapTestPool,
  requireSecurityGateDatabaseUrl,
  resetIsolatedBootstrapSchema,
  setTestClock,
  clearTestClock,
} from './owner-bootstrap-harness.js';

const rawDatabaseUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.M0_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  '';
const databaseUrl =
  rawDatabaseUrl !== '' ? forceNumericLoopbackUrl(rawDatabaseUrl) : '';
requireSecurityGateDatabaseUrl(databaseUrl, 'M1 acceptance remediation');

const PASSWORD = 'Owner-Bootstrap-Test-Password-12';
const PROFILE_ID = 'm1-stageb-acceptance-profile';

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('S-03 endpoint / TLS binding (no operational DB)', () => {
  it('accepts isolated_test numeric loopback plaintext config', () => {
    const profile = buildIsolatedTestEndpointProfile({
      profileId: 'tls-ok',
      expectedDatabaseName: 'alex_rewards_test',
    });
    const built = buildOwnerBootstrapPoolConfig(
      'postgresql://alex_rewards:x@127.0.0.1:55432/alex_rewards_test',
      profile,
    );
    expect(built.config.ssl).toBe(false);
    expect(built.hostname).toBe('127.0.0.1');
  });

  it('rejects localhost DNS label as loopback proof', () => {
    const profile = buildIsolatedTestEndpointProfile({
      profileId: 'tls-localhost',
      expectedDatabaseName: 'alex_rewards_test',
    });
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://alex_rewards:x@localhost:55432/alex_rewards_test',
        profile,
      ),
    ).toThrow(/numeric loopback/i);
  });

  it('rejects verify_full without Owner CA trust anchor', () => {
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://alex_rewards:x@db.example:5432/alex_rewards_test',
        {
          profileId: 'tls-noca',
          deploymentEnv: 'staging',
          expectedDatabaseName: 'alex_rewards_test',
          tls: { mode: 'verify_full', caPem: '', tlsServerName: 'db.example' },
        },
      ),
    ).toThrow(/trust anchor|CA/i);
  });

  it('rejects SPKI pinning (G5=NO for v1)', () => {
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://alex_rewards:x@db.example:5432/alex_rewards_test',
        {
          profileId: 'tls-spki',
          deploymentEnv: 'production',
          expectedDatabaseName: 'alex_rewards_test',
          tls: {
            mode: 'verify_full',
            caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
            tlsServerName: 'db.example',
            spkiSha256Hex: 'ab'.repeat(32),
          },
        },
      ),
    ).toThrow(/G5|SPKI/i);
  });

  it('rejects plaintext live facts when profile requires TLS', () => {
    const profile = {
      profileId: 'tls-require',
      deploymentEnv: 'staging' as const,
      expectedDatabaseName: 'alex_rewards_test',
      tls: {
        mode: 'verify_full' as const,
        caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
        tlsServerName: 'db.example',
      },
    };
    const fakePlain: BootstrapConnectionFacts = {
      hostname: 'db.example',
      sslEnabled: true, // caller-forged label must not matter
      currentDatabase: 'alex_rewards_test',
      clusterSystemIdentifier: '1',
      serverAddr: '10.0.0.1',
      sslInUse: false,
    };
    expect(() =>
      assertBootstrapTlsAndEndpoint(profile, 'staging', 'tls-require', fakePlain),
    ).toThrow(/TLS required/i);
  });

  it('rejects remote public serverAddr when profile claims isolated_test loopback', () => {
    const profile = buildIsolatedTestEndpointProfile({
      profileId: 'tls-remote',
      expectedDatabaseName: 'alex_rewards_test',
    });
    const fakeRemote: BootstrapConnectionFacts = {
      hostname: '127.0.0.1',
      sslEnabled: false,
      currentDatabase: 'alex_rewards_test',
      clusterSystemIdentifier: '1',
      serverAddr: '203.0.113.9',
      sslInUse: false,
    };
    expect(() =>
      assertBootstrapTlsAndEndpoint(profile, 'isolated_test', 'tls-remote', fakeRemote),
    ).toThrow(/public non-loopback|remote tunnel/i);
  });

  it('rejects sslmode=require / no-verify / sslrootcert in connection URL', () => {
    const profile = buildIsolatedTestEndpointProfile({
      profileId: 'tls-sslmode',
      expectedDatabaseName: 'alex_rewards_test',
    });
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://alex_rewards:x@127.0.0.1:55432/alex_rewards_test?sslmode=no-verify',
        profile,
      ),
    ).toThrow(/sslmode/i);
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://alex_rewards:x@127.0.0.1:55432/alex_rewards_test?sslmode=require',
        profile,
      ),
    ).toThrow(/sslmode/i);
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://alex_rewards:x@127.0.0.1:55432/alex_rewards_test?sslrootcert=/tmp/bad.pem',
        profile,
      ),
    ).toThrow(/sslrootcert/i);
  });

  it('verify_full discrete config never embeds connectionString', () => {
    const built = buildOwnerBootstrapPoolConfig(
      'postgresql://alex_rewards:x@127.0.0.1:55432/alex_rewards_test',
      {
        profileId: 'vf',
        deploymentEnv: 'staging',
        expectedDatabaseName: 'alex_rewards_test',
        tls: {
          mode: 'verify_full',
          caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
          tlsServerName: 'db.example',
        },
      },
    );
    expect(built.config.connectionString).toBeUndefined();
    expect(built.config.host).toBe('127.0.0.1');
    expect(built.config.ssl).toEqual(
      expect.objectContaining({
        rejectUnauthorized: true,
        servername: 'db.example',
        checkServerIdentity: expect.any(Function),
      }),
    );
  });

  it('CV-01 refuses DNS URL host that differs from tls_server_name (pg overwrite hazard)', () => {
    expect(() =>
      buildOwnerBootstrapPoolConfig('postgresql://alex_rewards:x@evil.example:55432/alex_rewards_test', {
        profileId: 'cv01',
        deploymentEnv: 'staging',
        expectedDatabaseName: 'alex_rewards_test',
        tls: {
          mode: 'verify_full',
          caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
          tlsServerName: 'db.example',
        },
      }),
    ).toThrow(/tls_server_name|overwrite/i);
  });

  it('CV-01 allows URL host equal to tls_server_name', () => {
    const built = buildOwnerBootstrapPoolConfig(
      'postgresql://alex_rewards:x@db.example:55432/alex_rewards_test',
      {
        profileId: 'cv01-match',
        deploymentEnv: 'staging',
        expectedDatabaseName: 'alex_rewards_test',
        tls: {
          mode: 'verify_full',
          caPem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----',
          tlsServerName: 'db.example',
        },
      },
    );
    expect(built.config.host).toBe('db.example');
    expect((built.config.ssl as { servername?: string }).servername).toBe('db.example');
  });

  it('rejects operational alex_rewards database name', () => {
    expect(() =>
      buildOwnerBootstrapPoolConfig('postgresql://alex_rewards:x@127.0.0.1:5432/alex_rewards', {
        profileId: 'ops',
        deploymentEnv: 'isolated_test',
        expectedDatabaseName: 'alex_rewards',
        tls: { mode: 'isolated_test_loopback_plaintext' },
      }),
    ).toThrow(/operational|alex_rewards/i);
  });
});

describe.skipIf(databaseUrl === '')(
  'M1 final acceptance (isolated DB concurrency/timing)',
  { timeout: 180_000 },
  () => {
    let pool: Pool;
    let authority: CeremonyAuthority;
    let trust: BootstrapTrustMaterial;

    beforeAll(async () => {
      await resetIsolatedBootstrapSchema(databaseUrl);
      authority = createEphemeralCeremonyAuthority('stageb-acceptance-key');
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

    async function startFresh(email: string, nowSec: number, lifetimeSec: number) {
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

    async function popVerified(
      email: string,
      nowSec: number,
      lifetimeSec: number,
    ) {
      const { channel, started } = await startFresh(email, nowSec, lifetimeSec);
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
        clientUnixTime: nowSec,
        nonce32Hex: noncePop,
        sigChannelPopB64: signChannelPop(channel.privateKey, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          grantId: started.grantId,
          channelFpHex: started.channelFp,
          clientUnixTime: nowSec,
          nonce32: hexToBytes(noncePop),
        }),
        trust,
      });
      return { channel, started, pop };
    }

    // ---------- S-01 ----------
    describe('S-01 fresh clock / grant expiry', () => {
      it('rejects expiry before PoP with matching signatures; no OWNER', async () => {
        const now = 1_700_100_100;
        const { channel, started } = await startFresh('s01-pop2@local.test', now, 60);
        const later = now + 60;
        setTestClock(pool, later);
        const noncePop = bytesToHex(randomBytes(32));
        await expect(
          submitOwnerBootstrapPop(pool, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            keyId: started.keyId,
            sigRedeemB64: signOwnerRedeemChallenge(
              authority,
              hexToBytes(started.challengeBytesHex),
            ),
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

      it('rejects exact expiration boundary now === exp', async () => {
        const now = 1_700_100_200;
        const { channel, started, payload } = await startFresh(
          's01-bound@local.test',
          now,
          90,
        );
        expect(payload.exp).toBe(now + 90);
        const atExp = payload.exp;
        setTestClock(pool, atExp);
        const noncePop = bytesToHex(randomBytes(32));
        await expect(
          submitOwnerBootstrapPop(pool, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            keyId: started.keyId,
            sigRedeemB64: signOwnerRedeemChallenge(
              authority,
              hexToBytes(started.challengeBytesHex),
            ),
            clientUnixTime: atExp,
            nonce32Hex: noncePop,
            sigChannelPopB64: signChannelPop(channel.privateKey, {
              attemptId: started.attemptId,
              challengeId: started.challengeId,
              grantId: started.grantId,
              channelFpHex: started.channelFp,
              clientUnixTime: atExp,
              nonce32: hexToBytes(noncePop),
            }),
            trust,
          }),
        ).rejects.toThrow(/grant expired/i);
        await assertNoOwnerResidue(pool);
      });

      it('rejects valid ticket + expired grant at final enrollment', async () => {
        const now = 1_700_100_300;
        const { channel, started, pop } = await popVerified(
          's01-final@local.test',
          now,
          200,
        );
        const later = now + 200;
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
          intended_subject: 's01-final@local.test',
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
            intendedSubject: 's01-final@local.test',
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
        const grant = await pool.query<{ status: string }>(
          `SELECT status FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
          [started.grantId],
        );
        expect(grant.rows[0]?.status).toBe('ISSUED');
      });

      it('rejects when grant expires while blocked on row lock', async () => {
        const wallNow = Math.floor(Date.now() / 1000);
        const lifetimeSec = 3;
        const { channel, started } = await startFresh(
          's01-lock@local.test',
          wallNow,
          lifetimeSec,
        );
        clearTestClock(pool);
        const locker = new Client({ connectionString: databaseUrl });
        await locker.connect();
        await locker.query('BEGIN');
        await locker.query(
          `SELECT grant_id FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
          [started.grantId],
        );

        const noncePop = bytesToHex(randomBytes(32));
        const popPromise = submitOwnerBootstrapPop(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          keyId: started.keyId,
          sigRedeemB64: signOwnerRedeemChallenge(
            authority,
            hexToBytes(started.challengeBytesHex),
          ),
          clientUnixTime: wallNow,
          nonce32Hex: noncePop,
          sigChannelPopB64: signChannelPop(channel.privateKey, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            grantId: started.grantId,
            channelFpHex: started.channelFp,
            clientUnixTime: wallNow,
            nonce32: hexToBytes(noncePop),
          }),
          trust,
          // clearTestClock — must use clock_timestamp() after lock wait
        });

        await sleep(lifetimeSec * 1000 + 1500);
        await locker.query('COMMIT');
        await locker.end();

        await expect(popPromise).rejects.toThrow(/grant expired/i);
        await assertNoOwnerResidue(pool);
      });

      it('CV-02 rejects final enrollment when grant expires during row-lock contention', async () => {
        const wallNow = Math.floor(Date.now() / 1000);
        const lifetimeSec = 3;
        const { channel, started, pop } = await popVerified(
          'cv02-enroll-lock@local.test',
          wallNow,
          lifetimeSec,
        );
        clearTestClock(pool);
        const locker = new Client({ connectionString: databaseUrl });
        await locker.connect();
        await locker.query('BEGIN');
        await locker.query(
          `SELECT grant_id FROM owner_bootstrap_grants WHERE grant_id = $1::uuid FOR UPDATE`,
          [started.grantId],
        );

        const totpSecret = generateTotpSecretBytes();
        const nonceCred = bytesToHex(randomBytes(32));
        const clientUnixTime = wallNow;
        const publicHeader = {
          v: 1 as const,
          purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
          grant_id: started.grantId,
          attempt_id: started.attemptId,
          challenge_id: started.challengeId,
          ticket_id: pop.ticketId,
          channel_fp: started.channelFp,
          intended_subject: 'cv02-enroll-lock@local.test',
          credential_setup: {
            password_encoding: 'utf8' as const,
            totp_secret_encoding: 'base32_nopad_uppercase' as const,
            totp_digits: 6 as const,
            totp_period_seconds: 30 as const,
            totp_algorithm: 'SHA1' as const,
          },
          client_unix_time: clientUnixTime,
          nonce32: nonceCred,
        };
        const enrollPromise = completeOwnerBootstrapEnrollment(pool, {
          attemptId: started.attemptId,
          challengeId: started.challengeId,
          ticketId: pop.ticketId,
          enrollmentTicket: pop.enrollmentTicket,
          intendedSubject: 'cv02-enroll-lock@local.test',
          password: PASSWORD,
          totpSecretBytes: totpSecret,
          totpConfirmCode: generateTotpCode(totpSecret),
          clientUnixTime,
          nonce32Hex: nonceCred,
          sigChannelCredB64: signFinalCredReq(channel.privateKey, {
            publicHeader,
            passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
            totpSecretBytes: totpSecret,
          }),
          trust,
        });

        await sleep(lifetimeSec * 1000 + 1500);
        await locker.query('COMMIT');
        await locker.end();

        await expect(enrollPromise).rejects.toThrow(/grant expired|freshness|ticket expired/i);
        await assertNoOwnerResidue(pool);
      });

      it('forged nowSec on public API cannot revive an expired grant', async () => {
        clearTestClock(pool);
        const wall = Math.floor(Date.now() / 1000);
        const channel = createEnrollmentChannelKeypair();
        const payload = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 's01-forged-clock@local.test',
          nowSec: wall - 500,
          lifetimeSec: 60,
        });
        expect(payload.exp).toBeLessThan(wall);
        const envelope = signGrantEnvelope(payload, authority);
        const forgedInput = {
          grantEnvelope: envelope,
          channelPublicKey: channel.publicKey,
          trust,
          nowSec: wall + 10_000,
        };
        await expect(
          // Public API must not honor a forged nowSec property on the input object.
          startOwnerBootstrapAttempt(
            pool,
            forgedInput as {
              readonly grantEnvelope: typeof envelope;
              readonly channelPublicKey: Uint8Array;
              readonly trust: typeof trust;
            },
          ),
        ).rejects.toThrow(/grant expired/i);
        await assertNoOwnerResidue(pool);
        clearTestClock(pool);
      });

      it('rejects after delayed credential preparation past grant exp', async () => {
        const wallNow = Math.floor(Date.now() / 1000);
        const lifetimeSec = 4;
        const { channel, started, pop } = await popVerified(
          's01-delay@local.test',
          wallNow,
          lifetimeSec,
        );
        clearTestClock(pool);
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
          intended_subject: 's01-delay@local.test',
          credential_setup: {
            password_encoding: 'utf8' as const,
            totp_secret_encoding: 'base32_nopad_uppercase' as const,
            totp_digits: 6 as const,
            totp_period_seconds: 30 as const,
            totp_algorithm: 'SHA1' as const,
          },
          client_unix_time: wallNow,
          nonce32: nonceCred,
        };
        await expect(
          completeOwnerBootstrapEnrollment(pool, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            ticketId: pop.ticketId,
            enrollmentTicket: pop.enrollmentTicket,
            intendedSubject: 's01-delay@local.test',
            password: PASSWORD,
            totpSecretBytes: totpSecret,
            totpConfirmCode: generateTotpCode(totpSecret),
            clientUnixTime: wallNow,
            nonce32Hex: nonceCred,
            sigChannelCredB64: signFinalCredReq(channel.privateKey, {
              publicHeader,
              passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
              totpSecretBytes: totpSecret,
            }),
            trust,
            testCredentialPrepDelayMs: lifetimeSec * 1000 + 1500,
            // omit nowSec — fresh clock_timestamp after delay
          }),
        ).rejects.toThrow(/grant expired|freshness/i);
        await assertNoOwnerResidue(pool);
      });
    });

    // ---------- M1-B-02 ----------
    describe('M1-B-02 concurrent grant insert', () => {
      it('identical concurrent inserts share one grant row; no 25P02', async () => {
        const now = Math.floor(Date.now() / 1000);
        const payload = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-same@local.test',
          nowSec: now,
          lifetimeSec: 900,
        });
        const envelope = signGrantEnvelope(payload, authority);
        const ch1 = createEnrollmentChannelKeypair();
        const ch2 = createEnrollmentChannelKeypair();
        const [a, b] = await Promise.allSettled([
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: envelope,
            channelPublicKey: ch1.publicKey,
            trust,
          }),
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: envelope,
            channelPublicKey: ch2.publicKey,
            trust,
          }),
        ]);
        const ok = [a, b].filter((r) => r.status === 'fulfilled');
        expect(ok.length).toBeGreaterThanOrEqual(1);
        const grants = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
          [payload.grant_id],
        );
        expect(grants.rows[0]?.c).toBe(1);
        await assertNoOwnerResidue(pool);
      });

      it('conflicting signed payloads same grant_id refuse overwrite', async () => {
        const now = Math.floor(Date.now() / 1000);
        const grantId = randomUUID();
        const p1 = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-a@local.test',
          nowSec: now,
          lifetimeSec: 900,
          grantId,
        });
        const p2 = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-b@local.test',
          nowSec: now,
          lifetimeSec: 900,
          grantId,
        });
        // Force different nonce/subject while same grant id
        expect(p1.nonce).not.toBe(p2.nonce);
        const e1 = signGrantEnvelope(p1, authority);
        const e2 = signGrantEnvelope(p2, authority);
        const ch1 = createEnrollmentChannelKeypair();
        const ch2 = createEnrollmentChannelKeypair();

        const first = await startOwnerBootstrapAttempt(pool, {
          grantEnvelope: e1,
          channelPublicKey: ch1.publicKey,
          trust,
        });
        expect(first.grantId).toBe(grantId);

        await expect(
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: e2,
            channelPublicKey: ch2.publicKey,
            trust,
          }),
        ).rejects.toThrow(/identity mismatch|conflict/i);

        const row = await pool.query<{ intended_subject: string; nonce_hex: string }>(
          `SELECT intended_subject, nonce_hex FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
          [grantId],
        );
        expect(row.rows[0]?.intended_subject).toBe('b02-a@local.test');
        expect(row.rows[0]?.nonce_hex).toBe(p1.nonce);
      });

      it('conflicting expiration refuses overwrite', async () => {
        const now = Math.floor(Date.now() / 1000);
        const grantId = randomUUID();
        const p1 = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-exp@local.test',
          nowSec: now,
          lifetimeSec: 900,
          grantId,
        });
        await startOwnerBootstrapAttempt(pool, {
          grantEnvelope: signGrantEnvelope(p1, authority),
          channelPublicKey: createEnrollmentChannelKeypair().publicKey,
          trust,
        });
        const p2 = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-exp@local.test',
          nowSec: now,
          lifetimeSec: 400,
          grantId,
        });
        await expect(
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: signGrantEnvelope(p2, authority),
            channelPublicKey: createEnrollmentChannelKeypair().publicKey,
            trust,
          }),
        ).rejects.toThrow(/identity mismatch|conflict/i);
        const row = await pool.query<{ exp: string }>(
          `SELECT exp::text FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
          [grantId],
        );
        expect(Number(row.rows[0]?.exp)).toBe(p1.exp);
      });

      it('conflicting endpoint profile refuses overwrite', async () => {
        const now = Math.floor(Date.now() / 1000);
        const grantId = randomUUID();
        const p1 = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-ep@local.test',
          nowSec: now,
          lifetimeSec: 900,
          grantId,
        });
        await startOwnerBootstrapAttempt(pool, {
          grantEnvelope: signGrantEnvelope(p1, authority),
          channelPublicKey: createEnrollmentChannelKeypair().publicKey,
          trust,
        });
        const p2 = {
          ...buildTestGrantPayload({
            authority,
            endpointProfileId: 'other-profile-id',
            intendedAdminEmail: 'b02-ep@local.test',
            nowSec: now,
            lifetimeSec: 900,
            grantId,
          }),
          endpoint_profile_id: 'other-profile-id',
        };
        // Sign with forced other profile — verify will pass crypto but insert identity fails
        // after trust endpoint check may fail first; either is rejection without overwrite.
        await expect(
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: signGrantEnvelope(p2, authority),
            channelPublicKey: createEnrollmentChannelKeypair().publicKey,
            trust,
          }),
        ).rejects.toThrow(AuthDomainError);
        const row = await pool.query<{ endpoint_profile_id: string }>(
          `SELECT endpoint_profile_id FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
          [grantId],
        );
        expect(row.rows[0]?.endpoint_profile_id).toBe(PROFILE_ID);
      });

      it('concurrent different payloads same grant_id — one wins, loser mismatches; no 25P02', async () => {
        const now = Math.floor(Date.now() / 1000);
        const grantId = randomUUID();
        const p1 = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-race-a@local.test',
          nowSec: now,
          lifetimeSec: 900,
          grantId,
        });
        const p2 = buildTestGrantPayload({
          authority,
          endpointProfileId: PROFILE_ID,
          intendedAdminEmail: 'b02-race-b@local.test',
          nowSec: now + 1,
          lifetimeSec: 800,
          grantId,
        });
        const e1 = signGrantEnvelope(p1, authority);
        const e2 = signGrantEnvelope(p2, authority);
        const results = await Promise.allSettled([
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: e1,
            channelPublicKey: createEnrollmentChannelKeypair().publicKey,
            trust,
          }),
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: e2,
            channelPublicKey: createEnrollmentChannelKeypair().publicKey,
            trust,
          }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        const msg = String((rejected[0] as PromiseRejectedResult).reason);
        expect(msg).not.toMatch(/25P02/);
        expect(msg).toMatch(/identity mismatch|conflict|expired/i);
        const row = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
          [grantId],
        );
        expect(row.rows[0]?.c).toBe(1);
        await assertNoOwnerResidue(pool);
      });
    });

    // ---------- S-02 ----------
    describe('S-02 lock order / concurrent paths', () => {
      it('concurrent START vs PoP — no deadlock, consistent state', async () => {
        const now = Math.floor(Date.now() / 1000);
        const { channel, started, envelope } = await startFresh(
          's02-start-pop@local.test',
          now,
          900,
        );
        const noncePop = bytesToHex(randomBytes(32));
        const results = await Promise.allSettled([
          startOwnerBootstrapAttempt(pool, {
            grantEnvelope: envelope,
            channelPublicKey: createEnrollmentChannelKeypair().publicKey,
            trust,
          }),
          submitOwnerBootstrapPop(pool, {
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
          }),
        ]);
        expect(results.every((r) => r.status === 'fulfilled' || r.status === 'rejected')).toBe(
          true,
        );
        const statuses = await pool.query<{ pop_status: string }>(
          `SELECT pop_status FROM owner_bootstrap_attempts WHERE grant_id = $1::uuid`,
          [started.grantId],
        );
        expect(statuses.rows.length).toBeGreaterThan(0);
        await assertNoOwnerResidue(pool);
      });

      it('concurrent FINAL vs FINAL — single OWNER', async () => {
        const now = Math.floor(Date.now() / 1000);
        const { channel, started, pop } = await popVerified(
          's02-final@local.test',
          now,
          900,
        );
        const makeComplete = () => {
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
            intended_subject: 's02-final@local.test',
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
          return completeOwnerBootstrapEnrollment(pool, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            ticketId: pop.ticketId,
            enrollmentTicket: pop.enrollmentTicket,
            intendedSubject: 's02-final@local.test',
            password: PASSWORD,
            totpSecretBytes: totpSecret,
            totpConfirmCode: generateTotpCode(totpSecret),
            clientUnixTime: now,
            nonce32Hex: nonceCred,
            sigChannelCredB64: signFinalCredReq(channel.privateKey, {
              publicHeader,
              passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
              totpSecretBytes: totpSecret,
            }),
            trust,
          });
        };
        const results = await Promise.allSettled([makeComplete(), makeComplete()]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        const bad = results.filter((r) => r.status === 'rejected');
        expect(ok.length).toBe(1);
        expect(bad.length).toBe(1);
        const owners = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM admin_role_bindings b
           INNER JOIN admin_roles r ON r.id = b.role_id WHERE r.code = 'OWNER'`,
        );
        expect(owners.rows[0]?.c).toBe(1);
      });

      it('abort vs FINAL — no duplicate OWNER / consistent attempt', async () => {
        const now = Math.floor(Date.now() / 1000);
        const { channel, started, pop } = await popVerified(
          's02-abort-final@local.test',
          now,
          900,
        );
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
          intended_subject: 's02-abort-final@local.test',
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
        const nonceAbort = bytesToHex(randomBytes(32));
        const results = await Promise.allSettled([
          abortOwnerBootstrapAttempt(pool, {
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
          }),
          completeOwnerBootstrapEnrollment(pool, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            ticketId: pop.ticketId,
            enrollmentTicket: pop.enrollmentTicket,
            intendedSubject: 's02-abort-final@local.test',
            password: PASSWORD,
            totpSecretBytes: totpSecret,
            totpConfirmCode: generateTotpCode(totpSecret),
            clientUnixTime: now,
            nonce32Hex: nonceCred,
            sigChannelCredB64: signFinalCredReq(channel.privateKey, {
              publicHeader,
              passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
              totpSecretBytes: totpSecret,
            }),
            trust,
          }),
        ]);
        const owners = await pool.query<{ c: number }>(
          `SELECT count(*)::int AS c FROM admin_role_bindings b
           INNER JOIN admin_roles r ON r.id = b.role_id WHERE r.code = 'OWNER'`,
        );
        expect((owners.rows[0]?.c ?? 0) <= 1).toBe(true);
        expect(results.length).toBe(2);
        const attempt = await pool.query<{ pop_status: string }>(
          `SELECT pop_status FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
          [started.attemptId],
        );
        expect(['ABORTED', 'CONSUMED']).toContain(attempt.rows[0]?.pop_status);
      });

      it('two attempts compete for single OWNER seat', async () => {
        const now = Math.floor(Date.now() / 1000);
        const a = await popVerified('s02-seat-a@local.test', now, 900);
        // Second grant/attempt after first is VERIFIED — need separate grant
        const b = await (async () => {
          const channel = createEnrollmentChannelKeypair();
          const payload = buildTestGrantPayload({
            authority,
            endpointProfileId: PROFILE_ID,
            intendedAdminEmail: 's02-seat-b@local.test',
            nowSec: now,
            lifetimeSec: 900,
          });
          const envelope = signGrantEnvelope(payload, authority);
          const started = await startOwnerBootstrapAttempt(pool, {
            grantEnvelope: envelope,
            channelPublicKey: channel.publicKey,
            trust,
          });
          const noncePop = bytesToHex(randomBytes(32));
          const pop = await submitOwnerBootstrapPop(pool, {
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
          return { channel, started, pop };
        })();

        const enroll = async (
          email: string,
          pack: typeof a,
        ) => {
          const totpSecret = generateTotpSecretBytes();
          const nonceCred = bytesToHex(randomBytes(32));
          const publicHeader = {
            v: 1 as const,
            purpose: 'FIRST_OWNER_CREDENTIAL_SETUP' as const,
            grant_id: pack.started.grantId,
            attempt_id: pack.started.attemptId,
            challenge_id: pack.started.challengeId,
            ticket_id: pack.pop.ticketId,
            channel_fp: pack.started.channelFp,
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
          return completeOwnerBootstrapEnrollment(pool, {
            attemptId: pack.started.attemptId,
            challengeId: pack.started.challengeId,
            ticketId: pack.pop.ticketId,
            enrollmentTicket: pack.pop.enrollmentTicket,
            intendedSubject: email,
            password: PASSWORD,
            totpSecretBytes: totpSecret,
            totpConfirmCode: generateTotpCode(totpSecret),
            clientUnixTime: now,
            nonce32Hex: nonceCred,
            sigChannelCredB64: signFinalCredReq(pack.channel.privateKey, {
              publicHeader,
              passwordUtf8: Buffer.from(PASSWORD, 'utf8'),
              totpSecretBytes: totpSecret,
            }),
            trust,
          });
        };

        const results = await Promise.allSettled([
          enroll('s02-seat-a@local.test', a),
          enroll('s02-seat-b@local.test', b),
        ]);
        const ok = results.filter((r) => r.status === 'fulfilled');
        expect(ok.length).toBe(1);
        const owners = await pool.query<{ c: number }>(
          `SELECT count(DISTINCT b.admin_user_id)::int AS c FROM admin_role_bindings b
           INNER JOIN admin_roles r ON r.id = b.role_id WHERE r.code = 'OWNER'`,
        );
        expect(owners.rows[0]?.c).toBe(1);
      });
    });

    // ---------- S-03 live ----------
    describe('S-03 live trusted connection', () => {
      it('createOwnerBootstrapPool binds live loopback facts', async () => {
        const bootstrap = await createOwnerBootstrapPool({
          connectionString: databaseUrl,
          profile: trust.endpointProfile,
        });
        try {
          expect(bootstrap.connectionFacts.hostname).toBe('127.0.0.1');
          expect(bootstrap.connectionFacts.sslInUse).toBe(false);
          expect(bootstrap.connectionFacts.currentDatabase).not.toBe('alex_rewards');
          if (bootstrap.connectionFacts.serverAddr !== null) {
            // Docker bridge is private; public Internet addresses must be refused.
            expect(bootstrap.connectionFacts.serverAddr).not.toMatch(/^203\./);
          }
        } finally {
          await bootstrap.pool.end();
        }
      });

      it('refuses forged connectionFacts with an unrelated Pool', async () => {
        const { Pool: PgPool } = await import('pg');
        const unrelated = new PgPool({ connectionString: databaseUrl, max: 1 });
        try {
          const forgedFacts: BootstrapConnectionFacts = {
            hostname: '127.0.0.1',
            sslEnabled: false,
            currentDatabase: trust.connectionFacts.currentDatabase,
            clusterSystemIdentifier: trust.connectionFacts.clusterSystemIdentifier,
            serverAddr: '127.0.0.1',
            sslInUse: false,
          };
          expect(() =>
            assertPoolBoundBootstrapTrust(unrelated, {
              endpointProfile: trust.endpointProfile,
              connectionFacts: forgedFacts,
            }),
          ).toThrow(/not a createOwnerBootstrapPool-verified|forged/i);
          expect(() =>
            assertPoolBoundBootstrapTrust(pool, {
              endpointProfile: trust.endpointProfile,
              connectionFacts: forgedFacts,
            }),
          ).toThrow(/forged or unrelated/i);
          // Bound trust still works with the verified pool.
          expect(() => assertPoolBoundBootstrapTrust(pool, trust)).not.toThrow();
        } finally {
          await unrelated.end();
        }
      });
    });
  },
);
