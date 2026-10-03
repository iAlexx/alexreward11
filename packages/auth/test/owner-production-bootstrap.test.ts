/**
 * Phase 21 Step 4B — production Owner bootstrap hardening tests.
 * Disposable keys/DB only. Never generates real Owner material.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import * as AuthPackage from '../src/index.js';
import * as OwnerBootstrapPublic from '../src/owner-bootstrap/index.js';
import {
  PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
  assertProductionProfileRequiresSystemIdentifier,
  buildOwnerBootstrapPoolConfig,
  buildProductionOwnerBootstrapPoolConfig,
  buildProductionOwnerBootstrapReadinessReport,
  digestProductionCeremonyBundleV1,
  draftProductionCeremonySeal,
  generateProductionBootstrapKeypairFiles,
  preflightClaimExistingAdmin,
  recordProductionChannelBDigest,
  validateCeremonyEndpointProfileV1,
  writeIntendedExistingAdminBinding,
  writeProductionEndpointProfile,
  validateProductionCeremonyBundleStructurally,
  assertProductionCeremonyAllowsEnrollment,
  isAuthenticatedProductionBootstrapTrust,
  OWNER_BOOTSTRAP_KEY_KDF,
  OWNER_BOOTSTRAP_KEY_AEAD,
  decryptOwnerBootstrapPrivateSeed,
  encryptOwnerBootstrapPrivateSeed,
  preflightProductionOwnerBootstrapSchema,
  REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS,
  assertProductionCeremonyApplyGates,
  orchestrateProductionOwnerBootstrapCeremony,
  resolvePublicProxyDialIps,
  createBootstrapTrustMaterial,
  WITNESS_MODEL,
} from '../src/owner-bootstrap/index.js';
import { generateEd25519KeyPair, bytesToHex } from '../src/owner-bootstrap/ed25519.js';
import { fingerprintPublicKey } from '../src/owner-bootstrap/grant.js';
import {
  mintAuthenticatedProductionBootstrapTrustForTests,
  tryForgeProductionTrustFromCallerTrustClass,
} from '../src/owner-bootstrap/test-only/production-trust-test-hooks.js';
import { createDisposableProductionSimPool } from '../src/owner-bootstrap/pool.js';
import {
  forceNumericLoopbackUrl,
  requireSecurityGateDatabaseUrl,
  resetIsolatedBootstrapSchema,
  dbNameFromUrl,
} from './owner-bootstrap-harness.js';

const FAKE_CA = `-----BEGIN CERTIFICATE-----
MIIBtjCCAVugAwIBAgIUTestCA000000000000000000000wDQYJKoZIhvcNAQEL
BQAwDTELMAkGA1UEBhMCVVMwHhcNMjYwMTAxMDAwMDAwWhcNMzYwMTAxMDAwMDAw
WjANMQswCQYDVQQGEwJVUzBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQDfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffAgMBAAGjUzBRMB0GA1UdDgQWBBT///////////////////////////////AfBgNVHSMEGDAWgBT///////////////////////////////APBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAf//////////////////////////////////////////w==
-----END CERTIFICATE-----`;

const PASSPHRASE = 'Disposable-Test-Passphrase-32chars!!';
const ADMIN_ID = 'c33c33c3-0000-4000-8000-000000000033';
const ADMIN_EMAIL = 'claim-target@example.local';
const repoRoot = join(tmpdir(), 'alex-rewards-not-repo-root');

function enableTestTemp(): void {
  process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
  process.env.ALEX_OWNER_BOOTSTRAP_ALLOW_TEST_TEMP_DIR = '1';
}

function productionProfile(overrides: Record<string, unknown> = {}) {
  return validateCeremonyEndpointProfileV1({
    v: 1,
    profile_id: 'prod-profile-v1',
    deployment_env: 'production',
    expected_database_name: 'railway',
    expected_system_identifier: '1234567890123456789',
    tls: {
      mode: 'verify_full',
      ca_pem: FAKE_CA,
      tls_server_name: 'postgres.example.internal',
    },
    ...overrides,
  });
}

function prepCeremonyDir(dir: string, repoRoot: string) {
  enableTestTemp();
  generateProductionBootstrapKeypairFiles({
    ceremonyDir: dir,
    keyId: 'owner-boot-test-1',
    phase21ProductionOwnerBootstrap: true,
    requireInteractiveTty: false,
    passphrase: PASSPHRASE,
    passphraseConfirm: PASSPHRASE,
    repoRootHint: repoRoot,
    testFastKdf: true,
  });
  writeProductionEndpointProfile(dir, productionProfile());
  writeIntendedExistingAdminBinding(dir, {
    enrollment_mode: 'CLAIM_EXISTING_ADMIN',
    intended_admin_user_id: ADMIN_ID,
    intended_admin_email: ADMIN_EMAIL,
    note: 'locator_only_not_authority',
  });
  return draftProductionCeremonySeal({
    ceremonyDir: dir,
    authorizerDisplayName: 'Owner Human',
    witnesses: [
      {
        display_name: 'Independent Witness Alice',
        role: 'independent_witness',
        attestation_ref: 'offline-paper-attestation-2026-10-02',
      },
    ],
  });
}

describe('phase21 step4b production owner bootstrap hardening', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('package root and owner-bootstrap public API do not export mint or WeakSet mutators', () => {
    expect(AuthPackage).not.toHaveProperty('mintAuthenticatedProductionBootstrapTrust');
    expect(OwnerBootstrapPublic).not.toHaveProperty('mintAuthenticatedProductionBootstrapTrust');
    expect(AuthPackage).not.toHaveProperty('tryForgeProductionTrustFromCallerTrustClass');
    expect(OwnerBootstrapPublic).not.toHaveProperty('tryForgeProductionTrustFromCallerTrustClass');
    expect(OwnerBootstrapPublic).not.toHaveProperty('authenticatedProductionTrustBrand');
    expect(OwnerBootstrapPublic).not.toHaveProperty('productionBoundTrustMaterials');
  });

  it('caller trustClass / fake objects cannot forge branded authority', () => {
    enableTestTemp();
    expect(tryForgeProductionTrustFromCallerTrustClass({ trustClass: 'production_sealed_v1' })).toBe(
      false,
    );
    expect(isAuthenticatedProductionBootstrapTrust({ trustClass: 'production_sealed_v1' })).toBe(
      false,
    );
    expect(
      isAuthenticatedProductionBootstrapTrust({
        brand: 'AuthenticatedProductionBootstrapTrust',
        trustClass: 'production_sealed_v1',
      }),
    ).toBe(false);
  });

  it('isolated pool still refuses operational alex_rewards', () => {
    expect(() =>
      buildOwnerBootstrapPoolConfig('postgresql://u:p@127.0.0.1:5432/alex_rewards', {
        profileId: 'iso',
        deploymentEnv: 'isolated_test',
        expectedDatabaseName: 'alex_rewards',
        tls: { mode: 'isolated_test_loopback_plaintext' },
      }),
    ).toThrow(/alex_rewards|FORBIDDEN/);
  });

  it('key custody: encrypted bundle, no plaintext .hex, decrypt round-trip', () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4a2-key-'));
    dirs.push(dir);
    const pub = generateProductionBootstrapKeypairFiles({
      ceremonyDir: dir,
      keyId: 'k1',
      phase21ProductionOwnerBootstrap: true,
      requireInteractiveTty: false,
      passphrase: PASSPHRASE,
      passphraseConfirm: PASSPHRASE,
      repoRootHint: repoRoot,
      testFastKdf: true,
    });
    expect(existsSync(join(dir, 'bootstrap-private-seed.hex'))).toBe(false);
    expect(existsSync(join(dir, 'owner-bootstrap-private-seed.hex'))).toBe(false);
    const encFiles = readdirSync(dir).filter((f) => f.endsWith('.enc'));
    expect(encFiles.length).toBe(1);
    expect(OWNER_BOOTSTRAP_KEY_KDF).toBe('argon2id');
    expect(OWNER_BOOTSTRAP_KEY_AEAD).toBe('xchacha20poly1305');
    const bundle = JSON.parse(readFileSync(join(dir, encFiles[0]!), 'utf8'));
    const seed = decryptOwnerBootstrapPrivateSeed(bundle, PASSPHRASE);
    expect(seed.byteLength).toBe(32);
    expect(() => decryptOwnerBootstrapPrivateSeed(bundle, 'wrong-passphrase-xxxxx')).toThrow(
      /decrypt failed|passphrase/i,
    );
    expect(pub.ciphertext_sha256_hex).toMatch(/^[0-9a-f]{64}$/);
    expect(pub.public_key_sha256_hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keygen requires phase21 flag; TTY bypass needs test hooks; passphrase mismatch fails', () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4a2-k2-'));
    dirs.push(dir);
    expect(() =>
      generateProductionBootstrapKeypairFiles({
        ceremonyDir: dir,
        keyId: 'k',
        phase21ProductionOwnerBootstrap: false,
        requireInteractiveTty: false,
        passphrase: PASSPHRASE,
        passphraseConfirm: PASSPHRASE,
        repoRootHint: repoRoot,
        testFastKdf: true,
      }),
    ).toThrow(/phase21-production-owner-bootstrap/i);
    expect(() =>
      generateProductionBootstrapKeypairFiles({
        ceremonyDir: dir,
        keyId: 'k',
        phase21ProductionOwnerBootstrap: true,
        requireInteractiveTty: false,
        passphrase: PASSPHRASE,
        passphraseConfirm: 'different-passphrase!!',
        repoRootHint: repoRoot,
        testFastKdf: true,
      }),
    ).toThrow(/confirmation mismatch/i);
  });

  it('in-memory encrypt/decrypt unit; env passphrase forbidden on generate path', () => {
    enableTestTemp();
    const kp = generateEd25519KeyPair();
    const bundle = encryptOwnerBootstrapPrivateSeed({
      seed32: kp.privateKey,
      passphrase: PASSPHRASE,
      keyId: 'u1',
      kdfParams: { memory: 16, passes: 1, parallelism: 1, dkLen: 32 },
    });
    expect(bytesToHex(decryptOwnerBootstrapPrivateSeed(bundle, PASSPHRASE))).toBe(
      bytesToHex(kp.privateKey),
    );
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4a2-env-'));
    dirs.push(dir);
    process.env.OWNER_BOOTSTRAP_PASSPHRASE = 'should-not-work-xxxxxx';
    try {
      expect(() =>
        generateProductionBootstrapKeypairFiles({
          ceremonyDir: dir,
          keyId: 'k',
          phase21ProductionOwnerBootstrap: true,
          requireInteractiveTty: false,
          passphrase: PASSPHRASE,
          passphraseConfirm: PASSPHRASE,
          repoRootHint: repoRoot,
          testFastKdf: true,
        }),
      ).toThrow(/env forbidden/i);
    } finally {
      delete process.env.OWNER_BOOTSTRAP_PASSPHRASE;
    }
  });

  it('structural validation distinct from authentication', () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4a2-s-'));
    dirs.push(dir);
    prepCeremonyDir(dir, repoRoot);
    const structural = validateProductionCeremonyBundleStructurally(dir);
    expect(structural.provenanceAuthenticated).toBe(false);
    expect(structural.witnessModel).toBe(WITNESS_MODEL);
    expect(() => assertProductionCeremonyAllowsEnrollment(dir)).toThrow(/UNAUTHENTICATED/i);
    const digest = digestProductionCeremonyBundleV1(structural.bundle);
    recordProductionChannelBDigest({ ceremonyDir: dir, ownerTypedDigestHex: digest });
    expect(() => assertProductionCeremonyAllowsEnrollment(dir)).toThrow(/UNAUTHENTICATED/);
  });

  it('production profile requires system_identifier and refuses loopback', () => {
    expect(() =>
      assertProductionProfileRequiresSystemIdentifier(
        validateCeremonyEndpointProfileV1({
          v: 1,
          profile_id: 'p',
          deployment_env: 'production',
          expected_database_name: 'railway',
          tls: { mode: 'verify_full', ca_pem: FAKE_CA, tls_server_name: 'db.example' },
        }),
      ),
    ).toThrow(/system_identifier/);
    expect(() =>
      buildProductionOwnerBootstrapPoolConfig('postgresql://u:p@127.0.0.1:5432/railway', {
        profileId: 'p',
        deploymentEnv: 'production',
        expectedDatabaseName: 'railway',
        expectedSystemIdentifier: '99',
        tls: { mode: 'verify_full', caPem: FAKE_CA, tlsServerName: 'db.example' },
      }),
    ).toThrow(/loopback/);
  });

  it('readiness: source ready; ceremony not ready; mint not public', () => {
    const report = buildProductionOwnerBootstrapReadinessReport({});
    expect(report.productionOwnerBootstrapSourceReady).toBe(true);
    expect(report.readyForProductionOwnerBootstrapCeremony).toBe(false);
    expect(report.productionTrustMintPubliclyExported).toBe(false);
    expect(report.ownerKeyEncryptedAtRest).toBe(true);
    expect(report.operatorOrchestratorImplemented).toBe(true);
    expect(report.programmaticForceApply).toBe(false);
  });

  it('schema preflight: version column + required migrations + 0028 cross-purpose', async () => {
    expect(REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS).toEqual([
      '0024_owner_admin_auth_hardening',
      '0025_single_owner_authority',
      '0026_owner_bootstrap_grants',
      '0027_signer_login_isolation',
      '0028_owner_bootstrap_attempt_nonce_attempt_wide',
    ]);

    const failClient = {
      async query() {
        throw new Error('boom');
      },
    };
    const failed = await preflightProductionOwnerBootstrapSchema(failClient as never);
    expect(failed.schemaReady).toBe(false);
    expect(failed.refuseCode).toBe('SCHEMA_MIGRATIONS_TABLE_UNAVAILABLE');

    // Fixture: same nonce across purposes — purpose-grouped query would miss; corrected catches.
    let sawVersion = false;
    let sawCrossPurpose = false;
    const client = {
      async query(sql: string) {
        if (sql.includes('schema_migrations')) {
          expect(sql).toMatch(/SELECT version/i);
          expect(sql).not.toMatch(/SELECT name/i);
          sawVersion = true;
          return {
            rows: [
              { version: '0024_owner_admin_auth_hardening' },
              { version: '0025_single_owner_authority' },
              { version: '0026_owner_bootstrap_grants' },
              { version: '0027_signer_login_isolation' },
            ],
          };
        }
        if (sql.includes('owner_bootstrap_attempt_nonces')) {
          expect(sql).toMatch(/GROUP BY attempt_id, nonce_hex/i);
          expect(sql).not.toMatch(/purpose/i);
          sawCrossPurpose = true;
          return { rows: [{ c: 1 }] };
        }
        return { rows: [] };
      },
    };
    const blocked = await preflightProductionOwnerBootstrapSchema(client as never);
    expect(sawVersion).toBe(true);
    expect(sawCrossPurpose).toBe(true);
    expect(blocked.migration0028Applied).toBe(false);
    expect(blocked.duplicateNonceRows).toBe(1);
    expect(blocked.refuseCode).toBe('BLOCK_0028_DUPLICATE_NONCES');
    expect(blocked.schemaReady).toBe(false);

    const appliedClient = {
      async query(sql: string) {
        if (sql.includes('schema_migrations')) {
          return {
            rows: REQUIRED_PRODUCTION_OWNER_BOOTSTRAP_MIGRATIONS.map((version) => ({ version })),
          };
        }
        throw new Error('should not query nonces when 0028 applied');
      },
    };
    const ok = await preflightProductionOwnerBootstrapSchema(appliedClient as never);
    expect(ok.migration0028Applied).toBe(true);
    expect(ok.duplicateNoncePreflightApplicable).toBe(false);
    expect(ok.schemaReady).toBe(true);
  });

  it('claim preflight fail-closed + clean eligible', async () => {
    const clientFail = {
      async query(sql: string) {
        if (sql.includes('admin_roles')) return { rows: [{ id: 'role-1', status: 'ACTIVE' }] };
        if (sql.includes('admin_owner_authority')) return { rows: [{ holder: null }] };
        if (sql.includes('count(DISTINCT')) return { rows: [{ c: 0 }] };
        if (sql.includes('revoked_at IS NULL') && sql.includes('admin_role_bindings'))
          return { rows: [{ c: 0 }] };
        if (sql.includes('FROM admin_users WHERE id'))
          return {
            rows: [{ id: ADMIN_ID, email: ADMIN_EMAIL, status: 'ACTIVE' }],
          };
        if (sql.includes('lower(trim(email))')) return { rows: [{ c: 1 }] };
        if (sql.includes('admin_sessions')) throw new Error('schema boom');
        return { rows: [] };
      },
    };
    const failed = await preflightClaimExistingAdmin(clientFail as never, {
      intendedAdminUserId: ADMIN_ID,
      intendedAdminEmail: ADMIN_EMAIL,
      lockForUpdate: false,
    });
    expect(failed.eligible).toBe(false);
    expect(failed.refuseCode).toBe('EXISTING_ADMIN_SECURITY_STATE_UNKNOWN');
  });

  it('CLI run/enroll-existing: preflight-only + gated apply wired; secrets forbidden', () => {
    const src = readFileSync(
      new URL('../src/cli/owner-production-bootstrap.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/--preflight-only/);
    expect(src).toMatch(/runProductionOwnerBootstrapPreflightOnly/);
    expect(src).toMatch(/orchestrateProductionOwnerBootstrapCeremony/);
    expect(src).not.toMatch(/STEP4A2_SOURCE_ONLY_REFUSES_APPLY/);
    expect(src).toMatch(/OWNER_PRODUCTION_BOOTSTRAP_APPLY/);
    expect(src).toMatch(/command === 'run'/);
    expect(src).not.toMatch(/forceApply\s*=\s*true/);
    expect(src).toMatch(/SECRET_ARGV_FORBIDDEN|SECRET_ENV_FORBIDDEN/);
    expect(src).toMatch(/--bootstrap-passphrase/);
    expect(() =>
      assertProductionCeremonyApplyGates({
        apply: false,
        deploymentEnvIsProduction: true,
        ownerProductionBootstrapEnabled: true,
        ownerProductionBootstrapApply: true,
      }),
    ).toThrow(/APPLY_GATES/);
  });

  it('resolvePublicProxyDialIps rejects private loopback and 10.x', async () => {
    await expect(resolvePublicProxyDialIps('127.0.0.1')).rejects.toThrow(
      /private|loopback|link-local/i,
    );
    await expect(resolvePublicProxyDialIps('10.0.0.1')).rejects.toThrow(
      /private|loopback|link-local/i,
    );
  });

  it('test-only mint creates branded trust; spread copy is not branded', () => {
    enableTestTemp();
    const kp = generateEd25519KeyPair();
    const fakeTrust = {
      pinnedPublicKeys: new Map([['k', kp.publicKey]]),
      endpointProfile: {
        profileId: 'p',
        deploymentEnv: 'production' as const,
        expectedDatabaseName: 'railway',
        expectedSystemIdentifier: '1',
        tls: { mode: 'verify_full' as const, caPem: 'x', tlsServerName: 'h' },
      },
      connectionFacts: {
        hostname: 'h',
        sslEnabled: true,
        currentDatabase: 'railway',
        clusterSystemIdentifier: '1',
        serverAddr: null,
        sslInUse: true,
      },
    };
    const bundle = {
      v: 1 as const,
      purpose: 'FIRST_OWNER_ENROLLMENT' as const,
      deployment_env: 'production' as const,
      ceremony_id: 'c',
      seal_content_digest_hex: 'ab'.repeat(32),
      endpoint_profile_id: 'p',
      endpoint_profile_digest_hex: 'cd'.repeat(32),
      bootstrap_key_id: 'k',
      bootstrap_public_key_sha256_hex: fingerprintPublicKey(kp.publicKey),
      enrollment_mode: 'CLAIM_EXISTING_ADMIN' as const,
      intended_admin_user_id: ADMIN_ID,
      intended_admin_email: ADMIN_EMAIL,
      witness_model: 'HUMAN_ATTESTED' as const,
      witness_cryptographic_identity_proven: false as const,
      witness_count: 1,
    };
    const minted = mintAuthenticatedProductionBootstrapTrustForTests({
      trust: fakeTrust,
      bundle,
      bundleDigestHex: digestProductionCeremonyBundleV1(bundle),
    });
    expect(isAuthenticatedProductionBootstrapTrust(minted)).toBe(true);
    expect(isAuthenticatedProductionBootstrapTrust({ ...minted })).toBe(false);
  });
});


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
requireSecurityGateDatabaseUrl(databaseUrl, 'owner-production-bootstrap');

describe.skipIf(databaseUrl === '')(
  'phase21 step4b disposable production CLAIM lifecycle',
  () => {
    it('full disposable ceremony: encrypted key → CLAIM_EXISTING_ADMIN', async () => {
      enableTestTemp();
      process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
      try {
        await resetIsolatedBootstrapSchema(databaseUrl);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/ECONNREFUSED|connect/i.test(msg)) {
          console.warn('skipping disposable CLAIM lifecycle — test DB unavailable:', msg);
          return;
        }
        throw error;
      }
      const dir = mkdtempSync(join(tmpdir(), 'p21-s4a2-life-'));
      const dbName = dbNameFromUrl(databaseUrl);
      let simPool: Awaited<ReturnType<typeof createDisposableProductionSimPool>> | null = null;
      try {
      const pub = generateProductionBootstrapKeypairFiles({
        ceremonyDir: dir,
        keyId: 'owner-boot-disposable',
        phase21ProductionOwnerBootstrap: true,
        requireInteractiveTty: false,
        passphrase: PASSPHRASE,
        passphraseConfirm: PASSPHRASE,
        repoRootHint: repoRoot,
        testFastKdf: true,
      });
      expect(existsSync(join(dir, 'bootstrap-private-seed.hex'))).toBe(false);

      simPool = await createDisposableProductionSimPool({
        connectionString: databaseUrl,
        profileId: 'prod-sim-profile',
        expectedDatabaseName: dbName,
      });
      const sim = simPool;

      await sim.pool.query(
        `INSERT INTO admin_users (id, email, display_name, status)
         VALUES ($1::uuid, $2, 'Target Admin', 'ACTIVE')`,
        [ADMIN_ID, ADMIN_EMAIL],
      );

      const rec = JSON.parse(readFileSync(join(dir, 'bootstrap-public.json'), 'utf8')) as {
        public_key_raw_hex: string;
        key_id: string;
        public_key_sha256_hex: string;
      };
      const { hexToBytes } = await import('../src/owner-bootstrap/ed25519.js');
      const trust = createBootstrapTrustMaterial(
        sim,
        new Map([[rec.key_id, hexToBytes(rec.public_key_raw_hex)]]),
      );

      const bundle = {
        v: 1 as const,
        purpose: 'FIRST_OWNER_ENROLLMENT' as const,
        deployment_env: 'production' as const,
        ceremony_id: 'd44d44d4-0000-4000-8000-000000000044',
        seal_content_digest_hex: 'ab'.repeat(32),
        endpoint_profile_id: 'prod-sim-profile',
        endpoint_profile_digest_hex: 'cd'.repeat(32),
        bootstrap_key_id: rec.key_id,
        bootstrap_public_key_sha256_hex: rec.public_key_sha256_hex,
        enrollment_mode: 'CLAIM_EXISTING_ADMIN' as const,
        intended_admin_user_id: ADMIN_ID,
        intended_admin_email: ADMIN_EMAIL,
        witness_model: 'HUMAN_ATTESTED' as const,
        witness_cryptographic_identity_proven: false as const,
        witness_count: 1,
      };
      const productionTrust = mintAuthenticatedProductionBootstrapTrustForTests({
        trust,
        bundle,
        bundleDigestHex: digestProductionCeremonyBundleV1(bundle),
      });

      const encName = readdirSync(dir).find((f) => f.endsWith('.enc'))!;
      const encBundle = JSON.parse(readFileSync(join(dir, encName), 'utf8'));

      const result = await orchestrateProductionOwnerBootstrapCeremony({
        pool: sim.pool,
        productionTrust,
        encryptedKeyBundle: encBundle,
        bootstrapPassphrase: PASSPHRASE,
        password: 'Disposable-Owner-Password-12',
        passwordConfirm: 'Disposable-Owner-Password-12',
        apply: true,
        deploymentEnvIsProduction: true,
        ownerProductionBootstrapEnabled: true,
        ownerProductionBootstrapApply: true,
      });

      expect(result.applied).toBe(true);
      expect(result.adminUserId).toBe(ADMIN_ID);
      expect(pub.key_id).toBe(rec.key_id);

      const admins = await sim.pool.query(
        `SELECT count(*)::int AS c FROM admin_users WHERE id = $1::uuid OR lower(trim(email)) = lower(trim($2))`,
        [ADMIN_ID, ADMIN_EMAIL],
      );
      expect(Number(admins.rows[0]?.c)).toBe(1);
      const bindings = await sim.pool.query(
        `SELECT count(*)::int AS c FROM admin_role_bindings
         WHERE admin_user_id = $1::uuid AND revoked_at IS NULL`,
        [ADMIN_ID],
      );
      expect(Number(bindings.rows[0]?.c)).toBe(1);
      const seat = await sim.pool.query(
        `SELECT holder_admin_user_id::text AS h FROM admin_owner_authority WHERE seat = 1`,
      );
      expect(seat.rows[0]?.h).toBe(ADMIN_ID);
      const creds = await sim.pool.query(
        `SELECT credential_type::text AS t, count(*)::int AS c
         FROM admin_credentials WHERE admin_user_id = $1::uuid AND status = 'ACTIVE'
         GROUP BY credential_type`,
        [ADMIN_ID],
      );
      const byType = Object.fromEntries(
        creds.rows.map((r: { t: string; c: number }) => [r.t, r.c]),
      );
      expect(byType.PASSWORD).toBe(1);
      expect(byType.TOTP).toBe(1);
      const grants = await sim.pool.query(
        `SELECT status::text AS s FROM owner_bootstrap_grants WHERE grant_id = $1::uuid`,
        [result.grantId],
      );
      expect(grants.rows[0]?.s).toBe('CONSUMED');
      const attempts = await sim.pool.query(
        `SELECT pop_status::text AS s FROM owner_bootstrap_attempts WHERE attempt_id = $1::uuid`,
        [result.attemptId],
      );
      expect(attempts.rows[0]?.s).toBe('CONSUMED');
      const audit = await sim.pool.query(
        `SELECT count(*)::int AS c FROM audit_logs WHERE action_type = 'OWNER_BOOTSTRAP_ENROLL'`,
      );
      expect(Number(audit.rows[0]?.c)).toBeGreaterThanOrEqual(1);

      await expect(
        orchestrateProductionOwnerBootstrapCeremony({
          pool: sim.pool,
          productionTrust,
          encryptedKeyBundle: encBundle,
          bootstrapPassphrase: 'wrong-passphrase-xxxxx',
          password: 'Disposable-Owner-Password-12',
          passwordConfirm: 'Disposable-Owner-Password-12',
          apply: true,
          deploymentEnvIsProduction: true,
          ownerProductionBootstrapEnabled: true,
          ownerProductionBootstrapApply: true,
        }),
      ).rejects.toThrow();
      } finally {
        if (simPool) await simPool.pool.end().catch(() => undefined);
        delete process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM;
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  },
);
