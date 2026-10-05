/**
 * Isolated Option C ceremony tool — disposable DB suite.
 *
 * Never targets alex_rewards_isolated_payout_test (Owner preserved data) or
 * operational alex_rewards / port 55432.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  assertConnectionUrlAllowedForIsolatedCeremony,
  assertIsolatedCeremonyAllowsEnrollment,
  digestCeremonySealV1,
  draftCeremonySeal,
  generateEphemeralCeremonyKeypairFiles,
  loadCeremonyAuthorityFromDir,
  openIsolatedCeremonyBootstrap,
  recordChannelBDigestFromOwner,
  refuseSameHostChecksumAsChannelB,
  runIsolatedOptionCEnrollment,
  signGrantEnvelope,
  signOwnerRedeemChallenge,
  startOwnerBootstrapAttempt,
  submitOwnerBootstrapPop,
  writeIsolatedCeremonyProfile,
  buildIsolatedCeremonyGrantPayload,
  createEnrollmentChannelKeypair,
  signChannelPop,
} from '../src/index.js';
import { bytesToHex, hexToBytes } from '../src/owner-bootstrap/ed25519.js';import {
  forceNumericLoopbackUrl,
  requireSecurityGateDatabaseUrl,
  resetIsolatedBootstrapSchema,
  dbNameFromUrl,
} from './owner-bootstrap-harness.js';

const PRESERVED_ISOLATED_DB = 'alex_rewards_isolated_payout_test';

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
requireSecurityGateDatabaseUrl(databaseUrl, 'owner-bootstrap-ceremony');

const PASSWORD = 'Isolated-Ceremony-Test-Password-12';

function portFromUrl(url: string): number {
  const u = new URL(url);
  return u.port === '' ? 5432 : Number(u.port);
}

function prepareCompleteCeremony(dir: string, dbName: string, port: number): string {
  generateEphemeralCeremonyKeypairFiles({
    ceremonyDir: dir,
    keyId: 'isolated-ceremony-test-key',
  });
  writeIsolatedCeremonyProfile({
    ceremonyDir: dir,
    expectedDatabaseName: dbName,
    expectedPort: port,
    profileId: 'isolated-ceremony-disposable-profile',
  });
  const seal = draftCeremonySeal({
    ceremonyDir: dir,
    authorizerDisplayName: 'Isolated Test Authorizer',
    witnesses: [
      {
        display_name: 'Isolated Test Witness',
        role: 'independent_witness',
        attestation_ref: 'isolated-test-attestation:disposable-db-suite-v1',
      },
    ],
  });
  const digest = digestCeremonySealV1(seal);
  recordChannelBDigestFromOwner({
    ceremonyDir: dir,
    digestHexFromOwner: digest,
  });
  return digest;
}

describe('isolated ceremony gate (no DB)', () => {
  it('refuses operational port 55432 and alex_rewards', () => {
    expect(() =>
      assertConnectionUrlAllowedForIsolatedCeremony(
        'postgresql://u:p@127.0.0.1:55432/alex_rewards_test',
      ),
    ).toThrow(/55432/);
    expect(() =>
      assertConnectionUrlAllowedForIsolatedCeremony(
        'postgresql://u:p@127.0.0.1:55440/alex_rewards',
      ),
    ).toThrow(/alex_rewards/);
  });

  it('refuses same-host Channel B file path', () => {
    expect(() =>
      refuseSameHostChecksumAsChannelB({
        channelAPath: 'a.json',
        claimedChannelBPath: 'b.json',
        sameHost: true,
      }),
    ).toThrow(/offline_paper_seal/);
  });

  it('refuses missing witnesses / placeholders before enrollment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alex-ceremony-'));
    try {
      generateEphemeralCeremonyKeypairFiles({
        ceremonyDir: dir,
        keyId: 'k1',
      });
      writeIsolatedCeremonyProfile({
        ceremonyDir: dir,
        expectedDatabaseName: 'alex_rewards_ceremony_unit_test',
        expectedPort: 55441,
        profileId: 'unit-profile',
      });
      expect(() =>
        draftCeremonySeal({
          ceremonyDir: dir,
          authorizerDisplayName: 'Authorizer',
          witnesses: [],
        }),
      ).toThrow(/non-empty|missing-witness/i);
      expect(() =>
        draftCeremonySeal({
          ceremonyDir: dir,
          authorizerDisplayName: 'Authorizer',
          witnesses: [
            {
              display_name: 'TEST_WITNESS_PLACEHOLDER',
              role: 'independent_witness',
              attestation_ref: 'real-ref',
            },
          ],
        }),
      ).toThrow(/placeholder/i);
      expect(() => assertIsolatedCeremonyAllowsEnrollment(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(
  databaseUrl === '' || dbNameFromUrl(databaseUrl) === PRESERVED_ISOLATED_DB,
)(
  'isolated Option C ceremony enrollment (disposable DB)',
  { timeout: 180_000 },
  () => {
    // Suite factory still evaluates under skipIf; guard empty URL.
    const dbName = databaseUrl === '' ? '' : dbNameFromUrl(databaseUrl);
    const port = databaseUrl === '' ? 0 : portFromUrl(databaseUrl);
    let ceremonyDir = '';

    beforeAll(async () => {
      if (port === 55432) {
        throw new Error('REFUSE disposable ceremony tests on port 55432');
      }
      await resetIsolatedBootstrapSchema(databaseUrl);
    });

    beforeEach(async () => {
      if (ceremonyDir !== '') {
        rmSync(ceremonyDir, { recursive: true, force: true });
      }
      ceremonyDir = mkdtempSync(join(tmpdir(), 'alex-ceremony-'));
      await resetIsolatedBootstrapSchema(databaseUrl);
      prepareCompleteCeremony(ceremonyDir, dbName, port);
    });

    afterAll(() => {
      if (ceremonyDir !== '') {
        rmSync(ceremonyDir, { recursive: true, force: true });
      }
    });

    it('legitimate enrollment succeeds with complete ceremony evidence', async () => {
      const enrolled = await runIsolatedOptionCEnrollment({
        ceremonyDir,
        connectionString: databaseUrl,
        expectedDatabase: dbName,
        intendedAdminEmail: 'ceremony-owner@local.test',
        subjectDisplay: 'Ceremony Owner',
        password: PASSWORD,
      });
      try {
        expect(enrolled.result.email).toBe('ceremony-owner@local.test');
        const seat = await enrolled.pool.query<{ holder: string | null }>(
          `SELECT holder_admin_user_id::text AS holder FROM admin_owner_authority WHERE seat = 1`,
        );
        expect(seat.rows[0]?.holder).toBe(enrolled.result.adminUserId);
      } finally {
        await enrolled.close();
      }
    });

    it('missing Channel B refuses enrollment', async () => {
      const incomplete = mkdtempSync(join(tmpdir(), 'alex-ceremony-incomplete-'));
      try {
        generateEphemeralCeremonyKeypairFiles({
          ceremonyDir: incomplete,
          keyId: 'incomplete-key',
        });
        writeIsolatedCeremonyProfile({
          ceremonyDir: incomplete,
          expectedDatabaseName: dbName,
          expectedPort: port,
          profileId: 'incomplete-profile',
        });
        draftCeremonySeal({
          ceremonyDir: incomplete,
          authorizerDisplayName: 'Authorizer',
          witnesses: [
            {
              display_name: 'Witness',
              role: 'independent_witness',
              attestation_ref: 'isolated-test-attestation:no-channel-b',
            },
          ],
        });
        expect(() => assertIsolatedCeremonyAllowsEnrollment(incomplete)).toThrow(
          /Channel B/i,
        );
        await expect(
          runIsolatedOptionCEnrollment({
            ceremonyDir: incomplete,
            connectionString: databaseUrl,
            expectedDatabase: dbName,
            intendedAdminEmail: 'x@local.test',
            subjectDisplay: 'X',
            password: PASSWORD,
          }),
        ).rejects.toThrow(/Channel B/i);
      } finally {
        rmSync(incomplete, { recursive: true, force: true });
      }
    });

    it('cross-DB rejection: profile bound to other database name', async () => {
      const other = mkdtempSync(join(tmpdir(), 'alex-ceremony-crossdb-'));
      try {
        prepareCompleteCeremony(other, 'alex_rewards_other_crossdb_test', port);
        await expect(
          runIsolatedOptionCEnrollment({
            ceremonyDir: other,
            connectionString: databaseUrl,
            expectedDatabase: dbName,
            intendedAdminEmail: 'cross@local.test',
            subjectDisplay: 'Cross',
            password: PASSWORD,
          }),
        ).rejects.toThrow(/cross-DB/i);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });

    it('invalid PoP is rejected after ceremony-gated start', async () => {
      const gated = assertIsolatedCeremonyAllowsEnrollment(ceremonyDir);
      const authority = loadCeremonyAuthorityFromDir(ceremonyDir);
      const opened = await openIsolatedCeremonyBootstrap({
        connectionString: databaseUrl,
        profile: gated.profile,
        authority,
        expectedDatabase: dbName,
      });
      try {
        const payload = buildIsolatedCeremonyGrantPayload({
          authority,
          seal: gated.seal,
          sealContentDigestHex: gated.sealContentDigestHex,
          profile: gated.profile,
          intendedAdminEmail: 'pop@local.test',
          subjectDisplay: 'PoP',
        });
        const envelope = signGrantEnvelope(payload, authority);
        const channel = createEnrollmentChannelKeypair();
        const started = await startOwnerBootstrapAttempt(opened.bootstrap.pool, {
          grantEnvelope: envelope,
          channelPublicKey: channel.publicKey,
          trust: opened.trust,
        });
        const challengeBytes = hexToBytes(started.challengeBytesHex);
        const badSig = signOwnerRedeemChallenge(
          {
            keyId: authority.keyId,
            publicKey: channel.publicKey,
            privateKey: channel.privateKey,
            fingerprintHex: '00'.repeat(32),
          },
          challengeBytes,
        );
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
        await expect(
          submitOwnerBootstrapPop(opened.bootstrap.pool, {
            attemptId: started.attemptId,
            challengeId: started.challengeId,
            keyId: started.keyId,
            sigRedeemB64: badSig,
            clientUnixTime: now,
            nonce32Hex: noncePop,
            sigChannelPopB64: sigChannelPop,
            trust: opened.trust,
          }),
        ).rejects.toThrow(AuthDomainError);
      } finally {
        await opened.bootstrap.pool.end();
      }
    });

    it('replay of consumed grant is rejected', async () => {
      const first = await runIsolatedOptionCEnrollment({
        ceremonyDir,
        connectionString: databaseUrl,
        expectedDatabase: dbName,
        intendedAdminEmail: 'replay@local.test',
        subjectDisplay: 'Replay',
        password: PASSWORD,
      });
      const grantEnvelope = first.grantEnvelope;
      await first.close();

      const gated = assertIsolatedCeremonyAllowsEnrollment(ceremonyDir);
      const authority = loadCeremonyAuthorityFromDir(ceremonyDir);
      const opened = await openIsolatedCeremonyBootstrap({
        connectionString: databaseUrl,
        profile: gated.profile,
        authority,
        expectedDatabase: dbName,
      });
      try {
        const channel = createEnrollmentChannelKeypair();
        await expect(
          startOwnerBootstrapAttempt(opened.bootstrap.pool, {
            grantEnvelope,
            channelPublicKey: channel.publicKey,
            trust: opened.trust,
          }),
        ).rejects.toThrow(AuthDomainError);
      } finally {
        await opened.bootstrap.pool.end();
      }
    });
  },
);
