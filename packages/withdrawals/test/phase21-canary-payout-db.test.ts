import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { CeremonyEndpointProfileV1 } from '@alex-rewards/auth';

import {
  Phase21CanaryPlanDbError,
  buildPhase21CanaryPlanVerifiedConnectionString,
  extractCredentialsFromDatabaseUrl,
  isRailwayInternalHostname,
  loadPhase21CanaryPlanEndpointProfile,
  openPhase21CanaryPlanVerifiedPool,
  refuseGenericPoolForPhase21CanaryPlan,
  resolvePhase21CanaryPlanProxyHost,
  resolvePhase21CanaryPlanProxyPort,
} from '../src/phase21-canary-payout-db.js';
import type { Phase21CeremonyVerifiedPool } from '../src/phase21-ceremony-verified-pool.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const PROFILE: CeremonyEndpointProfileV1 = {
  v: 1,
  profile_id: 'phase21-canary-plan-test',
  deployment_env: 'production',
  expected_database_name: 'alex_rewards',
  expected_system_identifier: '1234567890123456789',
  tls: {
    mode: 'verify_full',
    ca_pem: '-----BEGIN CERTIFICATE-----\nMIIBTESTONLY\n-----END CERTIFICATE-----\n',
    tls_server_name: 'postgres.railway.internal',
  },
};

const envKeys = [
  'DATABASE_URL',
  'PHASE21_CEREMONY_PROXY_HOST',
  'PHASE21_CEREMONY_PROXY_PORT',
  'RAILWAY_TCP_PROXY_HOST',
  'RAILWAY_TCP_PROXY_DOMAIN',
  'RAILWAY_TCP_PROXY_PORT',
  'PHASE21_CEREMONY_ENDPOINT_PROFILE_FILE',
  'PHASE21_CEREMONY_DIR',
] as const;

const prev: Record<string, string | undefined> = {};

function snapEnv(): void {
  for (const k of envKeys) prev[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of envKeys) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
}

function writeTempProfile(profile: CeremonyEndpointProfileV1 = PROFILE): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'phase21-canary-plan-'));
  const file = path.join(dir, 'production-endpoint-profile.json');
  writeFileSync(file, JSON.stringify(profile), 'utf8');
  return file;
}

describe('phase21 canary PLAN verified DB path', () => {
  afterEach(() => {
    restoreEnv();
  });

  it('detects railway.internal hostnames', () => {
    expect(isRailwayInternalHostname('postgres.railway.internal')).toBe(true);
    expect(isRailwayInternalHostname('db.railway.internal')).toBe(true);
    expect(isRailwayInternalHostname('proxy.rlwy.net')).toBe(false);
  });

  it('prefers ceremony proxy envs then Railway TCP proxy domain', () => {
    snapEnv();
    delete process.env.PHASE21_CEREMONY_PROXY_HOST;
    delete process.env.RAILWAY_TCP_PROXY_HOST;
    process.env.RAILWAY_TCP_PROXY_DOMAIN = 'example.proxy.rlwy.net';
    expect(resolvePhase21CanaryPlanProxyHost()).toBe('example.proxy.rlwy.net');
    process.env.PHASE21_CEREMONY_PROXY_HOST = 'ceremony-proxy.example';
    expect(resolvePhase21CanaryPlanProxyHost()).toBe('ceremony-proxy.example');
    process.env.RAILWAY_TCP_PROXY_PORT = '23456';
    expect(resolvePhase21CanaryPlanProxyPort()).toBe(23456);
  });

  it('extracts credentials without requiring dial to railway.internal', () => {
    const creds = extractCredentialsFromDatabaseUrl(
      'postgresql://owner:s3cret@postgres.railway.internal:5432/alex_rewards',
    );
    expect(creds.user).toBe('owner');
    expect(creds.password).toBe('s3cret');
    expect(creds.database).toBe('alex_rewards');
    expect(isRailwayInternalHostname(creds.sourceHost)).toBe(true);
  });

  it('builds verified connection string via public proxy IP (not railway.internal)', async () => {
    const built = await buildPhase21CanaryPlanVerifiedConnectionString({
      profile: PROFILE,
      databaseUrl: 'postgresql://owner:s3cret@postgres.railway.internal:5432/alex_rewards',
      proxyHost: 'example.proxy.rlwy.net',
      proxyPort: 23456,
      resolveDialIps: async () => ['203.0.113.10'],
    });
    expect(built.dialIp).toBe('203.0.113.10');
    expect(built.connectionString).toContain('@203.0.113.10:23456/alex_rewards');
    expect(built.connectionString).not.toContain('railway.internal');
    expect(built.connectionString).toContain('owner');
    expect(built.connectionString).toContain(encodeURIComponent('s3cret'));
  });

  it('refuses railway.internal as proxy host', async () => {
    await expect(
      buildPhase21CanaryPlanVerifiedConnectionString({
        profile: PROFILE,
        databaseUrl: 'postgresql://owner:s3cret@postgres.railway.internal:5432/alex_rewards',
        proxyHost: 'postgres.railway.internal',
        proxyPort: 5432,
        resolveDialIps: async () => ['203.0.113.10'],
      }),
    ).rejects.toMatchObject({ code: 'RAILWAY_INTERNAL_HOST_FORBIDDEN_FROM_WORKSTATION' });
  });

  it('refuses wrong database identity vs profile', async () => {
    await expect(
      buildPhase21CanaryPlanVerifiedConnectionString({
        profile: PROFILE,
        databaseUrl: 'postgresql://owner:s3cret@postgres.railway.internal:5432/wrong_db',
        proxyHost: 'example.proxy.rlwy.net',
        proxyPort: 23456,
        resolveDialIps: async () => ['203.0.113.10'],
      }),
    ).rejects.toMatchObject({ code: 'PLAN_DATABASE_IDENTITY_MISMATCH' });
  });

  it('refuses non-verify_full TLS profile', async () => {
    const bad = {
      ...PROFILE,
      tls: { ...PROFILE.tls, mode: 'isolated_test_loopback_plaintext' as const },
    };
    await expect(
      buildPhase21CanaryPlanVerifiedConnectionString({
        profile: bad as unknown as CeremonyEndpointProfileV1,
        databaseUrl: 'postgresql://owner:s3cret@postgres.railway.internal:5432/alex_rewards',
        proxyHost: 'example.proxy.rlwy.net',
        proxyPort: 23456,
        resolveDialIps: async () => ['203.0.113.10'],
      }),
    ).rejects.toMatchObject({ code: 'VERIFY_FULL_TLS_REQUIRED' });
  });

  it('requires ceremony endpoint profile (generic pool refused)', () => {
    snapEnv();
    delete process.env.PHASE21_CEREMONY_ENDPOINT_PROFILE_FILE;
    delete process.env.PHASE21_CEREMONY_DIR;
    expect(() => loadPhase21CanaryPlanEndpointProfile([])).toThrow(Phase21CanaryPlanDbError);
    try {
      loadPhase21CanaryPlanEndpointProfile([]);
    } catch (error) {
      expect(error).toMatchObject({ code: 'CEREMONY_ENDPOINT_PROFILE_REQUIRED' });
    }
    const refused = refuseGenericPoolForPhase21CanaryPlan();
    expect(refused.code).toBe('GENERIC_POOL_REFUSED_FOR_PRODUCTION_PLAN');
  });

  it('verified-pool PLAN open succeeds with injected verified pool', async () => {
    snapEnv();
    const profileFile = writeTempProfile();
    process.env.PHASE21_CEREMONY_PROXY_HOST = 'example.proxy.rlwy.net';
    process.env.PHASE21_CEREMONY_PROXY_PORT = '23456';
    process.env.DATABASE_URL =
      'postgresql://owner:s3cret@postgres.railway.internal:5432/alex_rewards';

    const fakeVerified: Phase21CeremonyVerifiedPool = {
      brand: 'Phase21CeremonyVerifiedPool',
      pool: {} as Phase21CeremonyVerifiedPool['pool'],
      databaseName: 'alex_rewards',
      systemIdentifier: '1234567890123456789',
      tlsServerName: 'postgres.railway.internal',
      sslInUse: true,
      close: async () => undefined,
    };

    const opened = await openPhase21CanaryPlanVerifiedPool({
      argv: ['--ceremony-endpoint-profile', profileFile],
      resolveDialIps: async () => ['203.0.113.10'],
      createVerifiedPool: async () => fakeVerified,
    });

    expect(opened.evidence.verifiedPool).toBe(true);
    expect(opened.evidence.sslInUse).toBe(true);
    expect(opened.evidence.tlsMode).toBe('verify_full');
    expect(opened.evidence.tlsServerName).toBe('postgres.railway.internal');
    expect(opened.evidence.currentDatabaseMatchesProfile).toBe(true);
    expect(opened.evidence.systemIdentifierMatchesProfile).toBe(true);
    expect(opened.evidence.sanitized).toBe(true);
    await opened.close();
  });

  it('wrong system identifier from verified pool is refused', async () => {
    snapEnv();
    const profileFile = writeTempProfile();
    process.env.PHASE21_CEREMONY_PROXY_HOST = 'example.proxy.rlwy.net';
    process.env.PHASE21_CEREMONY_PROXY_PORT = '23456';
    process.env.DATABASE_URL =
      'postgresql://owner:s3cret@postgres.railway.internal:5432/alex_rewards';

    await expect(
      openPhase21CanaryPlanVerifiedPool({
        argv: ['--ceremony-endpoint-profile', profileFile],
        resolveDialIps: async () => ['203.0.113.10'],
        createVerifiedPool: async () => ({
          brand: 'Phase21CeremonyVerifiedPool',
          pool: {} as Phase21CeremonyVerifiedPool['pool'],
          databaseName: 'alex_rewards',
          systemIdentifier: '9999999999999999999',
          tlsServerName: 'postgres.railway.internal',
          sslInUse: true,
          close: async () => undefined,
        }),
      }),
    ).rejects.toMatchObject({ code: 'PLAN_SYSTEM_IDENTIFIER_MISMATCH' });
  });

  it('maps createProductionOwnerBootstrapPool system_identifier mismatch', async () => {
    snapEnv();
    const profileFile = writeTempProfile();
    process.env.PHASE21_CEREMONY_PROXY_HOST = 'example.proxy.rlwy.net';
    process.env.PHASE21_CEREMONY_PROXY_PORT = '23456';
    process.env.DATABASE_URL =
      'postgresql://owner:s3cret@postgres.railway.internal:5432/alex_rewards';

    await expect(
      openPhase21CanaryPlanVerifiedPool({
        argv: ['--ceremony-endpoint-profile', profileFile],
        resolveDialIps: async () => ['203.0.113.10'],
        createVerifiedPool: async () => {
          throw new Error('system_identifier mismatch');
        },
      }),
    ).rejects.toMatchObject({ code: 'PLAN_SYSTEM_IDENTIFIER_MISMATCH' });
  });

  it('CLI source uses verified pool and never generic Pool(connectionString)', () => {
    const src = readFileSync(path.resolve(here, '../src/cli/phase21-canary-payout.ts'), 'utf8');
    expect(src).toMatch(/openPhase21CanaryPlanVerifiedPool/);
    expect(src).toMatch(/--ceremony-endpoint-profile/);
    expect(src).toMatch(/dbVerification/);
    expect(src).not.toMatch(/new Pool\s*\(/);
    expect(src).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    expect(src).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(src).toMatch(/refusePhase21CanaryPayoutApply/);
  });

  it('preserves verify_full requirement in verified-pool module source', () => {
    const src = readFileSync(
      path.resolve(here, '../src/phase21-ceremony-verified-pool.ts'),
      'utf8',
    );
    expect(src).toMatch(/verify_full/);
    expect(src).toMatch(/sslInUse: true/);
    expect(src).not.toMatch(/rejectUnauthorized\s*:\s*false/);
  });
});
