/**
 * Phase 21 Step 4B — production Owner bootstrap hardening tests.
 * Disposable keys/DB only. Never generates real Owner material.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

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
  authenticateProductionCeremonyFromOwnerTty,
  runAuthenticatedProductionOwnerBootstrapPreflightOnly,
  hydrateIntendedExistingAdminBindingFromDatabase,
  loadProductionPublicKey,
  OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE,
  OWNER_APPLY_CONFIRMATION_PHRASE,
  attestOwnerOfflineBackupsInteractive,
  confirmProductionOwnerBootstrapApplyInteractive,
  APPLY_PREFLIGHT_NOT_READY,
  assertApplyPreflightReady,
  listApplyPreflightBlockers,
  verifyProductionOwnerBootstrapApplyReadOnly,
  generateTotpSecretBytes,
  generateTotpCode,
  type ProductionOwnerBootstrapPreflightOnlyResult,
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

      const totpSecret = generateTotpSecretBytes();
      const totpConfirmCode = generateTotpCode(totpSecret);
      const callerSecretBefore = Buffer.from(totpSecret).toString('hex');
      const result = await orchestrateProductionOwnerBootstrapCeremony({
        pool: sim.pool,
        productionTrust,
        encryptedKeyBundle: encBundle,
        bootstrapPassphrase: PASSPHRASE,
        password: 'Disposable-Owner-Password-12',
        passwordConfirm: 'Disposable-Owner-Password-12',
        totpSecretBytes: totpSecret,
        totpConfirmCode,
        apply: true,
        deploymentEnvIsProduction: true,
        ownerProductionBootstrapEnabled: true,
        ownerProductionBootstrapApply: true,
      });
      // The orchestrator zeroizes only its own copy; the caller's buffer is untouched.
      expect(Buffer.from(totpSecret).toString('hex')).toBe(callerSecretBefore);

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

      // Post-apply verification: read-only, sanitized, ok after a successful apply.
      const seen: string[] = [];
      const holder = sim.pool as unknown as { connect: (...args: unknown[]) => Promise<unknown> };
      const origConnect = holder.connect.bind(sim.pool);
      holder.connect = async (...connectArgs: unknown[]) => {
        if (connectArgs.length > 0) return origConnect(...connectArgs);
        const client = (await origConnect()) as {
          query: (...args: unknown[]) => Promise<unknown>;
        };
        const oq = client.query.bind(client);
        client.query = (...args: unknown[]) => {
          const first = args[0];
          seen.push(typeof first === 'string' ? first : String((first as { text?: string }).text));
          return oq(...args);
        };
        return client;
      };
      let verified: Awaited<ReturnType<typeof verifyProductionOwnerBootstrapApplyReadOnly>>;
      let wrongAttempt: Awaited<ReturnType<typeof verifyProductionOwnerBootstrapApplyReadOnly>>;
      try {
        verified = await verifyProductionOwnerBootstrapApplyReadOnly(sim.pool, {
          adminUserId: result.adminUserId,
          grantId: result.grantId,
          attemptId: result.attemptId,
        });
        wrongAttempt = await verifyProductionOwnerBootstrapApplyReadOnly(sim.pool, {
          adminUserId: result.adminUserId,
          grantId: result.grantId,
          attemptId: 'ffffffff-0000-4000-8000-00000000ffff',
        });
      } finally {
        holder.connect = origConnect;
      }
      expect(seen[0]).toBe('BEGIN READ ONLY');
      expect(seen[1]).toMatch(/SHOW transaction_read_only/);
      expect(seen.some((s) => /^\s*(INSERT|UPDATE|DELETE|COMMIT)\b/i.test(s))).toBe(false);
      expect(verified.ok).toBe(true);
      expect(verified.failures).toEqual([]);
      expect(verified.operationalDbMutation).toBe(false);
      expect(verified.readOnlyTransaction).toBe(true);
      expect(verified.activeOwnerBindingCount).toBe(1);
      expect(verified.activePasswordCredentialCount).toBe(1);
      expect(verified.activeTotpCredentialCount).toBe(1);
      expect(verified.grantStatus).toBe('CONSUMED');
      expect(verified.attemptStatus).toBe('CONSUMED');
      expect(JSON.stringify(verified)).not.toContain(ADMIN_EMAIL);
      expect(wrongAttempt.ok).toBe(false);
      expect(wrongAttempt.failures).toContain('ATTEMPT_NOT_CONSUMED');
      expect(wrongAttempt.failures).toContain('ENROLLMENT_AUDIT_MISSING');
      await expect(
        verifyProductionOwnerBootstrapApplyReadOnly(sim.pool, {
          adminUserId: 'not-a-uuid',
          grantId: result.grantId,
          attemptId: result.attemptId,
        }),
      ).rejects.toThrow(/UUID/);

      const secondSecret = generateTotpSecretBytes();
      await expect(
        orchestrateProductionOwnerBootstrapCeremony({
          pool: sim.pool,
          productionTrust,
          encryptedKeyBundle: encBundle,
          bootstrapPassphrase: 'wrong-passphrase-xxxxx',
          password: 'Disposable-Owner-Password-12',
          passwordConfirm: 'Disposable-Owner-Password-12',
          totpSecretBytes: secondSecret,
          totpConfirmCode: generateTotpCode(secondSecret),
          apply: true,
          deploymentEnvIsProduction: true,
          ownerProductionBootstrapEnabled: true,
          ownerProductionBootstrapApply: true,
        }),
      ).rejects.toThrow();

      // Pool still usable after orchestration, and closes cleanly.
      const ping = await sim.pool.query(`SELECT 1 AS ok`);
      expect(ping.rows[0]?.ok).toBe(1);
      await sim.pool.end();
      expect((sim.pool as unknown as { ended: boolean }).ended).toBe(true);
      } finally {
        if (simPool) await simPool.pool.end().catch(() => undefined);
        delete process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM;
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);

    it('wrong TOTP confirm code throws before ANY mutation (seat null, no credentials, no grant)', async () => {
      enableTestTemp();
      process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
      try {
        await resetIsolatedBootstrapSchema(databaseUrl);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (/ECONNREFUSED|connect/i.test(msg)) {
          console.warn('skipping wrong-TOTP test - test DB unavailable:', msg);
          return;
        }
        throw error;
      }
      const dir = mkdtempSync(join(tmpdir(), 'p21-s4b2-badtotp-'));
      const dbName = dbNameFromUrl(databaseUrl);
      let simPool: Awaited<ReturnType<typeof createDisposableProductionSimPool>> | null = null;
      try {
        generateProductionBootstrapKeypairFiles({
          ceremonyDir: dir,
          keyId: 'owner-boot-badtotp',
          phase21ProductionOwnerBootstrap: true,
          requireInteractiveTty: false,
          passphrase: PASSPHRASE,
          passphraseConfirm: PASSPHRASE,
          repoRootHint: repoRoot,
          testFastKdf: true,
        });
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
          ceremony_id: 'd44d44d4-0000-4000-8000-000000000045',
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

        const totpSecret = generateTotpSecretBytes();
        const goodCode = generateTotpCode(totpSecret);
        const wrongCode = goodCode === '000000' ? '111111' : '000000';
        const base = {
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
        };

        await expect(
          orchestrateProductionOwnerBootstrapCeremony({
            ...base,
            totpSecretBytes: totpSecret,
            totpConfirmCode: wrongCode,
          }),
        ).rejects.toThrow(/TOTP confirmation failed/);
        await expect(
          orchestrateProductionOwnerBootstrapCeremony({ ...base, totpConfirmCode: goodCode }),
        ).rejects.toThrow(/PRODUCTION_TOTP_SECRET_REQUIRED/);
        await expect(
          orchestrateProductionOwnerBootstrapCeremony({ ...base, totpSecretBytes: totpSecret }),
        ).rejects.toThrow(/PRODUCTION_TOTP_CODE_REQUIRED/);

        const seat = await sim.pool.query(
          `SELECT holder_admin_user_id::text AS h FROM admin_owner_authority WHERE seat = 1`,
        );
        expect(seat.rows[0]?.h ?? null).toBeNull();
        const creds = await sim.pool.query(
          `SELECT count(*)::int AS c FROM admin_credentials WHERE admin_user_id = $1::uuid`,
          [ADMIN_ID],
        );
        expect(Number(creds.rows[0]?.c)).toBe(0);
        const bindings = await sim.pool.query(
          `SELECT count(*)::int AS c FROM admin_role_bindings WHERE admin_user_id = $1::uuid`,
          [ADMIN_ID],
        );
        expect(Number(bindings.rows[0]?.c)).toBe(0);
        const grants = await sim.pool.query(`SELECT count(*)::int AS c FROM owner_bootstrap_grants`);
        expect(Number(grants.rows[0]?.c)).toBe(0);
        const attempts = await sim.pool.query(
          `SELECT count(*)::int AS c FROM owner_bootstrap_attempts`,
        );
        expect(Number(attempts.rows[0]?.c)).toBe(0);
      } finally {
        if (simPool) await simPool.pool.end().catch(() => undefined);
        delete process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM;
        rmSync(dir, { recursive: true, force: true });
      }
    }, 180_000);
  },
);


function mintFakeBrandedTrust() {
  enableTestTemp();
  const kp = generateEd25519KeyPair();
  const trust = {
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
  return mintAuthenticatedProductionBootstrapTrustForTests({
    trust,
    bundle,
    bundleDigestHex: digestProductionCeremonyBundleV1(bundle),
  });
}

describe('phase21 step4b1 authenticated read-only preflight (no DB)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('boolean and fake objects cannot authenticate the authenticated preflight', async () => {
    await expect(
      runAuthenticatedProductionOwnerBootstrapPreflightOnly({
        productionTrust: true as never,
        pool: {} as never,
      }),
    ).rejects.toThrow(/AuthenticatedProductionBootstrapTrust required/);
    await expect(
      runAuthenticatedProductionOwnerBootstrapPreflightOnly({
        productionTrust: {
          brand: 'AuthenticatedProductionBootstrapTrust',
          trustClass: 'production_sealed_v1',
        } as never,
        pool: {} as never,
      }),
    ).rejects.toThrow(/AuthenticatedProductionBootstrapTrust required/);
    const minted = mintFakeBrandedTrust();
    await expect(
      runAuthenticatedProductionOwnerBootstrapPreflightOnly({
        productionTrust: { ...minted },
        pool: {} as never,
      }),
    ).rejects.toThrow(/AuthenticatedProductionBootstrapTrust required/);
  });

  it('branded trust is required AND must be bound to a verified pool', async () => {
    const minted = mintFakeBrandedTrust();
    const unrelated = new Pool({ host: '127.0.0.1', port: 1 });
    try {
      await expect(
        runAuthenticatedProductionOwnerBootstrapPreflightOnly({
          productionTrust: minted,
          pool: unrelated,
        }),
      ).rejects.toThrow(/verified bootstrap pool|production-bound/);
    } finally {
      await unrelated.end().catch(() => undefined);
    }
  });

  it('tampered branded trust fields are refused', async () => {
    const minted = mintFakeBrandedTrust();
    const mutable = minted as unknown as { intendedAdminUserId: string };
    const original = mutable.intendedAdminUserId;
    mutable.intendedAdminUserId = 'ffffffff-0000-4000-8000-00000000ffff';
    try {
      await expect(
        runAuthenticatedProductionOwnerBootstrapPreflightOnly({
          productionTrust: minted,
          pool: {} as never,
        }),
      ).rejects.toThrow(/tampered/);
    } finally {
      mutable.intendedAdminUserId = original;
    }
  });

  it('authenticated API has no admin/email override and never calls the orchestrator', () => {
    const src = readSrc('../src/owner-bootstrap/production-authenticated-preflight-only.ts');
    expect(src).not.toMatch(/readonly intendedAdmin(UserId|Email)/);
    expect(src).not.toMatch(/orchestrateProductionOwnerBootstrapCeremony/);
    expect(src).not.toMatch(/process\.env\.[A-Z0-9_]*BACKUP/);
    expect(src).toMatch(/BEGIN READ ONLY/);
    expect(src).toMatch(/SHOW transaction_read_only/);
    expect(src).toMatch(/ROLLBACK/);
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b\s/);
    const unauth = readSrc('../src/owner-bootstrap/production-preflight-only.ts');
    expect(unauth).not.toMatch(/trustAuthenticated\?\s*:/);
    expect(unauth).toMatch(/trustAuthenticated: false,\s*readyForOwnerBootstrapApply: false/);
  });

  it('authenticate: non-TTY refused before reading digest or opening a pool', async () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-tty-'));
    dirs.push(dir);
    prepCeremonyDir(dir, repoRoot);
    const pub = loadProductionPublicKey(dir);
    const reader = vi.fn(async () => 'ab'.repeat(32));
    const factory = vi.fn();
    const stdinTty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(
        authenticateProductionCeremonyFromOwnerTty({
          ceremonyDir: dir,
          connectionString: 'postgresql://u:p@127.0.0.1:5432/x_test',
          pinnedPublicKeyRawHex: pub.public_key_raw_hex,
          readOfflineBundleDigestHex: reader,
          createPoolForTests: factory,
        }),
      ).rejects.toThrow(/INTERACTIVE_TTY_REQUIRED/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
    }
    expect(reader).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });

  it('createPoolForTests is refused when a real TTY is required', async () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-ttyhook-'));
    dirs.push(dir);
    prepCeremonyDir(dir, repoRoot);
    const pub = loadProductionPublicKey(dir);
    const digest = validateProductionCeremonyBundleStructurally(dir).bundleDigestHex;
    const factory = vi.fn();
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await expect(
        authenticateProductionCeremonyFromOwnerTty({
          ceremonyDir: dir,
          connectionString: 'postgresql://u:p@127.0.0.1:5432/x_test',
          pinnedPublicKeyRawHex: pub.public_key_raw_hex,
          readOfflineBundleDigestHex: async () => digest,
          createPoolForTests: factory,
        }),
      ).rejects.toThrow(/createPoolForTests requires/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('authenticate: wrong or malformed digest fails without creating a pool', async () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-dig-'));
    dirs.push(dir);
    prepCeremonyDir(dir, repoRoot);
    const pub = loadProductionPublicKey(dir);
    const factory = vi.fn();
    const base = {
      ceremonyDir: dir,
      connectionString: 'postgresql://u:p@127.0.0.1:5432/x_test',
      pinnedPublicKeyRawHex: pub.public_key_raw_hex,
      requireInteractiveTty: false,
      createPoolForTests: factory,
    };
    await expect(
      authenticateProductionCeremonyFromOwnerTty({
        ...base,
        readOfflineBundleDigestHex: async () => 'ab'.repeat(32),
      }),
    ).rejects.toThrow(/does not match recomputed/);
    await expect(
      authenticateProductionCeremonyFromOwnerTty({
        ...base,
        readOfflineBundleDigestHex: async () => 'not-hex',
      }),
    ).rejects.toThrow(/64 lowercase hex/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('createPoolForTests is refused without TEST_HOOKS', async () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-hook-'));
    dirs.push(dir);
    prepCeremonyDir(dir, repoRoot);
    const pub = loadProductionPublicKey(dir);
    const digest = validateProductionCeremonyBundleStructurally(dir).bundleDigestHex;
    const factory = vi.fn();
    delete process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS;
    try {
      await expect(
        authenticateProductionCeremonyFromOwnerTty({
          ceremonyDir: dir,
          connectionString: 'postgresql://u:p@127.0.0.1:5432/x_test',
          pinnedPublicKeyRawHex: pub.public_key_raw_hex,
          readOfflineBundleDigestHex: async () => digest,
          requireInteractiveTty: false,
          createPoolForTests: factory,
        }),
      ).rejects.toThrow(/TEST_HOOKS/);
    } finally {
      enableTestTemp();
    }
    expect(factory).not.toHaveBeenCalled();
  });

  it('pool is closed when minting fails after pool creation', async () => {
    enableTestTemp();
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-close-'));
    dirs.push(dir);
    prepCeremonyDir(dir, repoRoot);
    const pub = loadProductionPublicKey(dir);
    const structural = validateProductionCeremonyBundleStructurally(dir);
    const pool = new Pool({ host: '127.0.0.1', port: 1 });
    const endSpy = vi.spyOn(pool, 'end');
    await expect(
      authenticateProductionCeremonyFromOwnerTty({
        ceremonyDir: dir,
        connectionString: 'postgresql://u:p@127.0.0.1:5432/x_test',
        pinnedPublicKeyRawHex: pub.public_key_raw_hex,
        readOfflineBundleDigestHex: async () => structural.bundleDigestHex,
        requireInteractiveTty: false,
        createPoolForTests: async ({ profile }) => ({
          pool,
          profile,
          hostname: '127.0.0.1',
          database: profile.expectedDatabaseName,
          connectionFacts: {
            hostname: '127.0.0.1',
            sslEnabled: false,
            currentDatabase: profile.expectedDatabaseName,
            clusterSystemIdentifier: '1',
            serverAddr: null,
            sslInUse: false,
          },
        }),
      }),
    ).rejects.toThrow(/not registered as verified/);
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('profile validation rejects extra keys (dial, created_for, credential_url_omitted)', () => {
    for (const key of ['dial', 'created_for', 'credential_url_omitted']) {
      expect(() => productionProfile({ [key]: 'x' })).toThrow(/unexpected ceremony profile field/);
      expect(() => productionProfile({ [key]: true })).toThrow(/unexpected ceremony profile field/);
    }
    expect(() =>
      productionProfile({
        tls: {
          mode: 'verify_full',
          ca_pem: FAKE_CA,
          tls_server_name: 'postgres.example.internal',
          dial: '1.2.3.4',
        },
      }),
    ).toThrow(/unexpected tls field/);
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-prof-'));
    dirs.push(dir);
    expect(() =>
      writeProductionEndpointProfile(dir, {
        ...productionProfile(),
        dial: '1.2.3.4',
      } as never),
    ).toThrow(/unexpected ceremony profile field/);
  });

  it('CLI wires authenticated preflight + hydrate with session cleanup and no spoofable inputs', () => {
    const src = readSrc('../src/cli/owner-production-bootstrap.ts');
    expect(src).toMatch(/--authenticated-preflight-only/);
    expect(src).toMatch(/hydrate-intended-admin/);
    expect(src).toMatch(/runAuthenticatedProductionOwnerBootstrapPreflightOnly/);
    expect(src).toMatch(/ownerKeyOfflineBackupsReady = await attestOwnerOfflineBackupsInteractive\(\)/);
    expect(src).not.toMatch(/trustAuthenticated/);
    expect(src.match(/await session\?\.close\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src.match(/authenticateProductionCeremonyFromOwnerTty\(\{/g)?.length).toBe(3);
    expect(src).toMatch(/pool: session\.verifiedPool\.pool/);
    expect(src).toMatch(/MUTUALLY_EXCLUSIVE_MODES/);
    expect(src).toMatch(/PROFILE_ONLY_PARAMETER/);
    expect(src).toMatch(/INTERACTIVE_TTY_REQUIRED/);
  });
});

describe.skipIf(databaseUrl === '')(
  'phase21 step4b1 authenticated read-only preflight on disposable simulation DB',
  () => {
    const dirs: string[] = [];
    const sessions: Array<{ close(): Promise<void> }> = [];
    let dbName = '';

    beforeAll(async () => {
      enableTestTemp();
      process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
      await resetIsolatedBootstrapSchema(databaseUrl);
      dbName = dbNameFromUrl(databaseUrl);
    }, 120_000);

    afterAll(async () => {
      for (const s of sessions.splice(0)) await s.close();
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
      delete process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM;
    });

    async function openSession(dir: string) {
      const pub = loadProductionPublicKey(dir);
      const structural = validateProductionCeremonyBundleStructurally(dir);
      const session = await authenticateProductionCeremonyFromOwnerTty({
        ceremonyDir: dir,
        connectionString: databaseUrl,
        pinnedPublicKeyRawHex: pub.public_key_raw_hex,
        readOfflineBundleDigestHex: async () => structural.bundleDigestHex,
        requireInteractiveTty: false,
        createPoolForTests: ({ profile }) =>
          createDisposableProductionSimPool({
            connectionString: databaseUrl,
            profileId: profile.profileId,
            expectedDatabaseName: dbName,
          }),
      });
      sessions.push(session);
      return session;
    }

    async function snapshot(pool: Pool) {
      const tables = [
        'admin_users',
        'admin_credentials',
        'admin_role_bindings',
        'admin_sessions',
        'owner_bootstrap_grants',
        'owner_bootstrap_attempts',
        'audit_logs',
      ];
      const counts: Record<string, number> = {};
      for (const t of tables) {
        const r = await pool.query<{ c: number }>(`SELECT count(*)::int AS c FROM ${t}`);
        counts[t] = Number(r.rows[0]?.c);
      }
      const seat = await pool.query<{ h: string | null }>(
        `SELECT holder_admin_user_id::text AS h FROM admin_owner_authority WHERE seat = 1`,
      );
      return { counts, seat: seat.rows[0]?.h ?? null };
    }

    it('authenticated preflight is read-only, branded, and backups-pending by default', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-db-'));
      dirs.push(dir);
      prepCeremonyDir(dir, repoRoot);
      const session = await openSession(dir);
      const pool = session.verifiedPool.pool;
      await pool.query(
        `INSERT INTO admin_users (id, email, display_name, status)
         VALUES ($1::uuid, $2, 'Target Admin', 'ACTIVE')`,
        [ADMIN_ID, ADMIN_EMAIL],
      );
      expect(isAuthenticatedProductionBootstrapTrust(session.productionTrust)).toBe(true);

      const seen: string[] = [];
      const holder = pool as unknown as { connect: (...args: unknown[]) => Promise<unknown> };
      const origConnect = holder.connect.bind(pool);
      holder.connect = async (...connectArgs: unknown[]) => {
        // pg-pool's own pool.query() uses the callback form - leave that untouched.
        if (connectArgs.length > 0) return origConnect(...connectArgs);
        const client = (await origConnect()) as {
          query: (...args: unknown[]) => Promise<unknown>;
        };
        const oq = client.query.bind(client);
        client.query = (...args: unknown[]) => {
          const first = args[0];
          seen.push(typeof first === 'string' ? first : String((first as { text?: string }).text));
          return oq(...args);
        };
        return client;
      };

      const before = await snapshot(pool);
      let result: Awaited<ReturnType<typeof runAuthenticatedProductionOwnerBootstrapPreflightOnly>>;
      try {
        result = await runAuthenticatedProductionOwnerBootstrapPreflightOnly({
          productionTrust: session.productionTrust,
          pool,
        });
      } finally {
        holder.connect = origConnect;
      }
      const trace = seen.slice();
      const after = await snapshot(pool);
      expect(after).toEqual(before);

      expect(trace[0]).toBe('BEGIN READ ONLY');
      expect(trace[1]).toMatch(/SHOW transaction_read_only/);
      expect(trace.at(-1)).toBe('ROLLBACK');
      expect(trace.some((s) => /^\s*(INSERT|UPDATE|DELETE|COMMIT)\b/i.test(s))).toBe(false);

      expect(result.trustAuthenticated).toBe(true);
      expect(result.operationalDbMutation).toBe(false);
      expect(result.schemaReady).toBe(true);
      expect(result.ownerSeatReady).toBe(true);
      expect(result.targetAdminReady).toBe(true);
      expect(result.targetAdminSecurityState).toBe('CLEAN');
      expect(result.targetExistingAdminId).toBe(ADMIN_ID);
      expect(result.ownerKeyBackupsReady).toBe(false);
      expect(result.readyForOwnerBootstrapApply).toBe(false);
      expect(result.refuseCode).toBe('OWNER_KEY_OFFLINE_BACKUPS_PENDING');
      expect(result.authenticatedBundleDigestHex).toBe(session.productionTrust.bundleDigestHex);
      expect(result.authenticatedKeyId).toBe(session.productionTrust.keyId);
      expect(JSON.stringify(result)).not.toContain(ADMIN_EMAIL);

      const ready = await runAuthenticatedProductionOwnerBootstrapPreflightOnly({
        productionTrust: session.productionTrust,
        pool,
        ownerKeyOfflineBackupsReady: true,
      });
      expect(ready.readyForOwnerBootstrapApply).toBe(true);
      expect(ready.refuseCode).toBeNull();
      expect(await snapshot(pool)).toEqual(before);

      // Spoofed extra admin/email params are ignored: authority is the branded trust only.
      const spoofed = await runAuthenticatedProductionOwnerBootstrapPreflightOnly({
        productionTrust: session.productionTrust,
        pool,
        intendedAdminUserId: 'ffffffff-0000-4000-8000-00000000ffff',
        intendedAdminEmail: 'attacker@example.local',
      } as never);
      expect(spoofed.targetExistingAdminId).toBe(ADMIN_ID);

      await session.close();
      expect((pool as unknown as { ended: boolean }).ended).toBe(true);
      await session.close();
    }, 120_000);

    it('refuses pool/trust connection-fact mismatch (forged facts, foreign pool)', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-mm-'));
      dirs.push(dir);
      prepCeremonyDir(dir, repoRoot);
      const session = await openSession(dir);
      const other = await openSession(dir);
      try {
        await expect(
          runAuthenticatedProductionOwnerBootstrapPreflightOnly({
            productionTrust: session.productionTrust,
            pool: other.verifiedPool.pool,
          }),
        ).rejects.toThrow(/not bound to this verified pool/);

        const facts = session.verifiedPool.connectionFacts as unknown as {
          clusterSystemIdentifier: string;
          currentDatabase: string;
        };
        const sid = facts.clusterSystemIdentifier;
        facts.clusterSystemIdentifier = '999';
        try {
          await expect(
            runAuthenticatedProductionOwnerBootstrapPreflightOnly({
              productionTrust: session.productionTrust,
              pool: session.verifiedPool.pool,
            }),
          ).rejects.toThrow(/system_identifier/);
        } finally {
          facts.clusterSystemIdentifier = sid;
        }
        const db = facts.currentDatabase;
        facts.currentDatabase = 'railway';
        try {
          await expect(
            runAuthenticatedProductionOwnerBootstrapPreflightOnly({
              productionTrust: session.productionTrust,
              pool: session.verifiedPool.pool,
            }),
          ).rejects.toThrow(/database/);
        } finally {
          facts.currentDatabase = db;
        }
      } finally {
        await session.close();
        await other.close();
      }
    }, 120_000);

    it('hydrate-intended-admin reads canonical email from DB without printing it', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'p21-s4b1-hyd-'));
      dirs.push(dir);
      const mixedEmail = 'Hydrate-Target@Example.Local';
      const hydrateId = 'e55e55e5-0000-4000-8000-000000000055';
      writeIntendedExistingAdminBinding(dir, {
        enrollment_mode: 'CLAIM_EXISTING_ADMIN',
        intended_admin_user_id: hydrateId,
        intended_admin_email: 'placeholder@example.local',
        note: 'locator_only_not_authority',
      });
      const bootstrap = await createDisposableProductionSimPool({
        connectionString: databaseUrl,
        profileId: 'prod-profile-v1',
        expectedDatabaseName: dbName,
      });
      try {
        await bootstrap.pool.query(
          `INSERT INTO admin_users (id, email, display_name, status)
           VALUES ($1::uuid, $2, 'Hydrate Target', 'ACTIVE')`,
          [hydrateId, mixedEmail],
        );
        const before = await snapshot(bootstrap.pool);
        const result = await hydrateIntendedExistingAdminBindingFromDatabase({
          ceremonyDir: dir,
          bootstrap,
        });
        expect(await snapshot(bootstrap.pool)).toEqual(before);
        expect(result.adminUserId).toBe(hydrateId);
        expect(result.emailMasked).toBe('h***@example.local');
        const printed = JSON.stringify(result);
        expect(printed.toLowerCase()).not.toContain('hydrate-target');
        const written = JSON.parse(
          readFileSync(join(dir, 'intended-existing-admin.json'), 'utf8'),
        ) as { intended_admin_email: string; intended_admin_user_id: string };
        expect(written.intended_admin_email).toBe('hydrate-target@example.local');
        expect(written.intended_admin_user_id).toBe(hydrateId);
        expect(result.bundleMatchesBinding).toBeNull();

        await bootstrap.pool.query(`UPDATE admin_users SET status = 'LOCKED' WHERE id = $1::uuid`, [
          hydrateId,
        ]);
        await expect(
          hydrateIntendedExistingAdminBindingFromDatabase({ ceremonyDir: dir, bootstrap }),
        ).rejects.toThrow(/TARGET_ADMIN_NOT_ACTIVE/);
        await expect(
          hydrateIntendedExistingAdminBindingFromDatabase({
            ceremonyDir: dir,
            bootstrap,
            intendedAdminUserId: 'a77a77a7-0000-4000-8000-000000000077',
          }),
        ).rejects.toThrow(/TARGET_ADMIN_NOT_FOUND/);
      } finally {
        await bootstrap.pool.end().catch(() => undefined);
      }
    }, 120_000);
  },
);

describe('phase21 step4b2 safe apply hardening (no DB)', () => {
  const readSrc = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const savedHooks = process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS;
  const savedArgv = [...process.argv];

  afterEach(() => {
    if (savedHooks === undefined) delete process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS;
    else process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = savedHooks;
    delete process.env.OWNER_OFFLINE_BACKUPS_ATTESTED;
    delete process.env.OWNER_OFFLINE_BACKUP_ATTESTATION;
    process.argv = [...savedArgv];
  });

  function withNonTty<T>(fn: () => Promise<T>): Promise<T> {
    const stdinDesc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    return fn().finally(() => {
      if (stdinDesc) Object.defineProperty(process.stdin, 'isTTY', stdinDesc);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    });
  }

  it('backup attestation: env/argv/boolean cannot authorize; non-TTY fails', async () => {
    enableTestTemp();
    process.env.OWNER_OFFLINE_BACKUPS_ATTESTED = '1';
    process.env.OWNER_OFFLINE_BACKUP_ATTESTATION = OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE;
    process.argv = [...process.argv, '--attest-backups', OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE];
    await withNonTty(async () => {
      await expect(attestOwnerOfflineBackupsInteractive()).rejects.toThrow(
        /OWNER_BACKUP_ATTESTATION_FAILED.*INTERACTIVE_TTY_REQUIRED/,
      );
      await expect(attestOwnerOfflineBackupsInteractive({})).rejects.toThrow(/TTY/);
    });
    // Booleans / unknown fields are simply not part of the API.
    await withNonTty(async () => {
      await expect(
        attestOwnerOfflineBackupsInteractive({ attested: true } as never),
      ).rejects.toThrow(/TTY/);
    });
  });

  it('backup attestation: injection needs TEST_HOOKS; wrong phrase fails; exact phrase passes', async () => {
    enableTestTemp();
    const exact = async () => OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE;
    // TTY-required (default) still fails closed in a non-TTY test runner even with a reader.
    await withNonTty(async () => {
      await expect(attestOwnerOfflineBackupsInteractive({ readPhrase: exact })).rejects.toThrow(
        /TTY/,
      );
    });
    // requireInteractiveTty=false without a reader is refused.
    await expect(
      attestOwnerOfflineBackupsInteractive({ requireInteractiveTty: false }),
    ).rejects.toThrow(/injected reader/);
    // Wrong / empty / case-changed phrase fails.
    for (const bad of [
      '',
      'yes',
      'true',
      OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE.toLowerCase(),
      `${OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE}X`,
      OWNER_APPLY_CONFIRMATION_PHRASE,
    ]) {
      await expect(
        attestOwnerOfflineBackupsInteractive({
          requireInteractiveTty: false,
          readPhrase: async () => bad,
        }),
      ).rejects.toThrow(/OWNER_BACKUP_ATTESTATION_FAILED/);
    }
    // Exact phrase (trimmed) succeeds with TEST_HOOKS + injected reader.
    await expect(
      attestOwnerOfflineBackupsInteractive({
        requireInteractiveTty: false,
        readPhrase: async () => `  ${OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE}\n`,
      }),
    ).resolves.toBe(true);
    // Without TEST_HOOKS no injection is honoured at all.
    delete process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS;
    await expect(
      attestOwnerOfflineBackupsInteractive({ requireInteractiveTty: false, readPhrase: exact }),
    ).rejects.toThrow(/TEST_HOOKS/);
    await expect(attestOwnerOfflineBackupsInteractive({ readPhrase: exact })).rejects.toThrow(
      /TEST_HOOKS/,
    );
  });

  it('final APPLY confirmation phrase: same TTY rules, exact phrase only', async () => {
    enableTestTemp();
    expect(OWNER_APPLY_CONFIRMATION_PHRASE).toBe('APPLY_LOOTRA_PRODUCTION_OWNER_BOOTSTRAP');
    expect(OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE).toBe(
      'I_HAVE_TWO_SHA256_VERIFIED_OFFLINE_OWNER_KEY_BACKUPS',
    );
    await withNonTty(async () => {
      await expect(confirmProductionOwnerBootstrapApplyInteractive()).rejects.toThrow(
        /APPLY_CONFIRMATION_FAILED.*INTERACTIVE_TTY_REQUIRED/,
      );
    });
    for (const bad of ['', 'APPLY', 'apply_lootra_production_owner_bootstrap', 'yes']) {
      await expect(
        confirmProductionOwnerBootstrapApplyInteractive({
          requireInteractiveTty: false,
          readPhrase: async () => bad,
        }),
      ).rejects.toThrow(/APPLY_CONFIRMATION_FAILED/);
    }
    await expect(
      confirmProductionOwnerBootstrapApplyInteractive({
        requireInteractiveTty: false,
        readPhrase: async () => OWNER_OFFLINE_BACKUP_ATTESTATION_PHRASE,
      }),
    ).rejects.toThrow(/APPLY_CONFIRMATION_FAILED/);
    await expect(
      confirmProductionOwnerBootstrapApplyInteractive({
        requireInteractiveTty: false,
        readPhrase: async () => ` ${OWNER_APPLY_CONFIRMATION_PHRASE} `,
      }),
    ).resolves.toBe(true);
    delete process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS;
    await expect(
      confirmProductionOwnerBootstrapApplyInteractive({
        requireInteractiveTty: false,
        readPhrase: async () => OWNER_APPLY_CONFIRMATION_PHRASE,
      }),
    ).rejects.toThrow(/TEST_HOOKS/);
  });

  function readyPreflight(): ProductionOwnerBootstrapPreflightOnlyResult {
    return {
      trustClass: PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
      mode: 'preflight-only',
      operationalDbMutation: false,
      trustAuthenticated: true,
      tlsEndpointVerified: true,
      schemaReady: true,
      ownerSeatReady: true,
      targetAdminReady: true,
      targetAdminSecurityState: 'CLEAN',
      ownerKeyBackupsReady: true,
      readyForOwnerBootstrapApply: true,
      refuseCode: null,
      dialIp: '203.0.113.10',
      tlsServerName: 'postgres.example.internal',
      operationalDatabaseName: 'railway',
      operationalSystemIdentifier: '1',
      requiredMigrationsPresent: [],
      requiredMigrationsMissing: [],
      ownerSeatStatus: null,
      ownerBindingHistoryCount: 0,
      activeOwnerBindingCount: 0,
      ownerRoleStatus: 'ACTIVE',
      targetExistingAdminId: ADMIN_ID,
      targetExistingAdminStatus: 'ACTIVE',
      authCounts: null,
      authenticatedBundleDigestHex: 'ab'.repeat(32),
      authenticatedKeyId: 'k',
      notes: [],
    } as unknown as ProductionOwnerBootstrapPreflightOnlyResult;
  }

  it('assertApplyPreflightReady: only a fully READY preflight passes; every blocker refuses', () => {
    expect(() => assertApplyPreflightReady(readyPreflight())).not.toThrow();
    expect(listApplyPreflightBlockers(readyPreflight())).toEqual([]);
    const mutations: Array<[string, Record<string, unknown>]> = [
      ['trustAuthenticated', { trustAuthenticated: false }],
      ['tlsEndpointVerified', { tlsEndpointVerified: false }],
      ['schemaReady', { schemaReady: false }],
      ['ownerSeatReady', { ownerSeatReady: false }],
      ['targetAdminReady', { targetAdminReady: false }],
      ['targetAdminSecurityState', { targetAdminSecurityState: 'REQUIRES_OWNER_REVIEW' }],
      ['targetAdminSecurityState', { targetAdminSecurityState: 'UNKNOWN' }],
      ['ownerKeyBackupsReady', { ownerKeyBackupsReady: false }],
      ['readyForOwnerBootstrapApply', { readyForOwnerBootstrapApply: false }],
      ['refuseCode', { refuseCode: 'OWNER_KEY_OFFLINE_BACKUPS_PENDING' }],
      ['operationalDbMutation', { operationalDbMutation: true }],
    ];
    for (const [blocker, patch] of mutations) {
      const r = { ...readyPreflight(), ...patch } as ProductionOwnerBootstrapPreflightOnlyResult;
      expect(listApplyPreflightBlockers(r)).toContain(blocker);
      expect(() => assertApplyPreflightReady(r)).toThrow(new RegExp(APPLY_PREFLIGHT_NOT_READY));
    }
  });

  it('CLI --apply order: gates, TTY, auth, attest, preflight, READY gate, TOTP, secrets, policy, confirm, orchestrate, verify', () => {
    const src = readSrc('../src/cli/owner-production-bootstrap.ts');
    const start = src.indexOf('async function runApplyCommand');
    const end = src.indexOf('async function runVerifyApplyCommand');
    expect(start).toBeGreaterThan(0);
    const apply = src.slice(start, end);
    const order = [
      'assertProductionCeremonyApplyGates(',
      'process.stdin.isTTY',
      'loadEncryptedOwnerBootstrapKeyBundle(',
      'buildProductionConnectionString(',
      'authenticateProductionCeremonyFromOwnerTty(',
      'attestOwnerOfflineBackupsInteractive()',
      'runAuthenticatedProductionOwnerBootstrapPreflightOnly(',
      'assertApplyPreflightReady(',
      'enrollOwnerTotpInteractive()',
      "readSecret(\n      'Owner bootstrap passphrase",
      'assertPasswordPolicy(password)',
      'confirmProductionOwnerBootstrapApplyInteractive()',
      'orchestrateProductionOwnerBootstrapCeremony(',
      'verifyProductionOwnerBootstrapApplyReadOnly(',
    ];
    let last = -1;
    for (const needle of order) {
      const at = apply.indexOf(needle);
      expect(at, `missing ${needle}`).toBeGreaterThan(-1);
      expect(at, `out of order: ${needle}`).toBeGreaterThan(last);
      last = at;
    }
    // The orchestrator (the only decrypt/mutate path) is invoked exactly once, after the READY gate.
    expect(apply.match(/orchestrateProductionOwnerBootstrapCeremony\(\{/g)?.length).toBe(1);
    expect(apply).toMatch(/failPreMutation\(\s*APPLY_PREFLIGHT_NOT_READY/);
    expect(apply).toMatch(/ownerKeyOfflineBackupsReady: true/);
    expect(apply).toMatch(/PRE_MUTATION_FAILURE/);
    expect(apply).toMatch(/PARTIAL_LIFECYCLE_RECONCILIATION_REQUIRED/);
    expect(apply).toMatch(/rollbackClaimed: false/);
    expect(apply).toMatch(/zeroizeBytes\(totp\.secret\)/);
    expect(apply).toMatch(/await session\?\.close\(\)/);
    // Human TOTP UX: secret shown once, Owner types a live code.
    expect(src).toMatch(/Enter current 6-digit code/);
    expect(src).toMatch(/Issuer: LOOTRA/);
    expect(src).toMatch(/displaySecretOnceOnInteractiveStderr/);
    expect(src).toMatch(/verifyTotpCode\(secret, code\)/);
    // No auto-confirm in the CLI, no secrets from env/argv, no maskless email output.
    expect(src).not.toMatch(/generateTotpCode/);
    expect(apply).not.toMatch(/email:\s*result\.email/);
    expect(src).toMatch(/verify-apply/);
    expect(src).toMatch(/emailMasked: maskEmail\(result\.email\)/);
  });

  it('orchestrator source has no TOTP auto-generation or auto-confirm', () => {
    const src = readSrc('../src/owner-bootstrap/production-ceremony-orchestrator.ts');
    expect(src).not.toMatch(/generateTotpCode/);
    expect(src).not.toMatch(/generateTotpSecretBytes/);
    expect(src).toMatch(/PRODUCTION_TOTP_SECRET_REQUIRED/);
    expect(src).toMatch(/PRODUCTION_TOTP_CODE_REQUIRED/);
    expect(src).toMatch(/verifyTotpCode\(secret, code\)/);
    expect(src).toMatch(/zeroizeBytes\(totpSecret\)/);
    // TOTP is validated before the pool is ever used.
    expect(src.indexOf('requireProductionTotpConfirmation(input)')).toBeLessThan(
      src.indexOf('input.pool.connect()'),
    );
  });

  it('orchestrator: missing/empty secret, missing code and wrong code throw before touching the pool', async () => {
    enableTestTemp();
    const productionTrust = mintFakeBrandedTrust();
    let poolTouched = false;
    const pool = {
      connect: async () => {
        poolTouched = true;
        throw new Error('POOL_TOUCHED');
      },
    } as unknown as Pool;
    const base = {
      pool,
      productionTrust,
      encryptedKeyBundle: {} as never,
      bootstrapPassphrase: PASSPHRASE,
      password: 'Disposable-Owner-Password-12',
      passwordConfirm: 'Disposable-Owner-Password-12',
      apply: true,
      deploymentEnvIsProduction: true,
      ownerProductionBootstrapEnabled: true,
      ownerProductionBootstrapApply: true,
    };
    const secret = generateTotpSecretBytes();
    const good = generateTotpCode(secret);
    const wrong = good === '000000' ? '111111' : '000000';

    await expect(orchestrateProductionOwnerBootstrapCeremony(base)).rejects.toThrow(
      /PRODUCTION_TOTP_SECRET_REQUIRED/,
    );
    await expect(
      orchestrateProductionOwnerBootstrapCeremony({ ...base, totpConfirmCode: good }),
    ).rejects.toThrow(/PRODUCTION_TOTP_SECRET_REQUIRED/);
    await expect(
      orchestrateProductionOwnerBootstrapCeremony({
        ...base,
        totpSecretBytes: new Uint8Array(0),
        totpConfirmCode: good,
      }),
    ).rejects.toThrow(/PRODUCTION_TOTP_SECRET_REQUIRED/);
    await expect(
      orchestrateProductionOwnerBootstrapCeremony({ ...base, totpSecretBytes: secret }),
    ).rejects.toThrow(/PRODUCTION_TOTP_CODE_REQUIRED/);
    await expect(
      orchestrateProductionOwnerBootstrapCeremony({
        ...base,
        totpSecretBytes: secret,
        totpConfirmCode: '',
      }),
    ).rejects.toThrow(/PRODUCTION_TOTP_CODE_REQUIRED/);
    await expect(
      orchestrateProductionOwnerBootstrapCeremony({
        ...base,
        totpSecretBytes: secret,
        totpConfirmCode: '12ab56',
      }),
    ).rejects.toThrow(/6 digits/);
    await expect(
      orchestrateProductionOwnerBootstrapCeremony({
        ...base,
        totpSecretBytes: secret,
        totpConfirmCode: wrong,
      }),
    ).rejects.toThrow(/TOTP confirmation failed/);
    // Disposable simulation flags do NOT re-enable auto-confirm.
    process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
    try {
      await expect(orchestrateProductionOwnerBootstrapCeremony(base)).rejects.toThrow(
        /PRODUCTION_TOTP_SECRET_REQUIRED/,
      );
    } finally {
      delete process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM;
    }
    expect(poolTouched).toBe(false);
  });

  it('post-apply verify is wired read-only (source) and exported', () => {
    const src = readSrc('../src/owner-bootstrap/production-post-apply-verify.ts');
    expect(src).toMatch(/BEGIN READ ONLY/);
    expect(src).toMatch(/SHOW transaction_read_only/);
    expect(src).toMatch(/ROLLBACK/);
    expect(src).not.toMatch(/\b(INSERT|UPDATE|DELETE|COMMIT)\b/);
    expect(AuthPackage).toHaveProperty('verifyProductionOwnerBootstrapApplyReadOnly');
    expect(AuthPackage).toHaveProperty('attestOwnerOfflineBackupsInteractive');
    expect(AuthPackage).toHaveProperty('confirmProductionOwnerBootstrapApplyInteractive');
  });
});
