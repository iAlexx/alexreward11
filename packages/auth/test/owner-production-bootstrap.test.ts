import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
  tryForgeProductionTrustFromCallerTrustClass,
  mintAuthenticatedProductionBootstrapTrust,
  WITNESS_MODEL,
} from '../src/owner-bootstrap/index.js';

const FAKE_CA = `-----BEGIN CERTIFICATE-----
MIIBtjCCAVugAwIBAgIUTestCA000000000000000000000wDQYJKoZIhvcNAQEL
BQAwDTELMAkGA1UEBhMCVVMwHhcNMjYwMTAxMDAwMDAwWhcNMzYwMTAxMDAwMDAw
WjANMQswCQYDVQQGEwJVUzBcMA0GCSqGSIb3DQEBAQUAA0sAMEgCQQDfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffAgMBAAGjUzBRMB0GA1UdDgQWBBT///////////////////////////////AfBgNVHSMEGDAWgBT///////////////////////////////APBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA0EAf//////////////////////////////////////////w==
-----END CERTIFICATE-----`;

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

function prepCeremonyDir(dir: string) {
  generateProductionBootstrapKeypairFiles({
    ceremonyDir: dir,
    keyId: 'owner-boot-test-1',
    phase21ProductionOwnerBootstrap: true,
    requireInteractiveTty: false,
  });
  writeProductionEndpointProfile(dir, productionProfile());
  writeIntendedExistingAdminBinding(dir, {
    enrollment_mode: 'CLAIM_EXISTING_ADMIN',
    intended_admin_user_id: 'a11a11a1-0000-4000-8000-000000000011',
    intended_admin_email: 'owner@example.local',
    note: 'locator_only_not_authority',
  });
  const seal = draftProductionCeremonySeal({
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
  return seal;
}

describe('phase21 step4a.1 production owner bootstrap corrections', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
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

  it('caller trustClass string cannot forge authenticated production trust', () => {
    expect(tryForgeProductionTrustFromCallerTrustClass({ trustClass: 'production_sealed_v1' })).toBe(
      false,
    );
    expect(isAuthenticatedProductionBootstrapTrust({ trustClass: 'production_sealed_v1' })).toBe(
      false,
    );
  });

  it('structural validation distinct from authentication; AllowsEnrollment refuses', () => {
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4a1-'));
    dirs.push(dir);
    prepCeremonyDir(dir);
    const structural = validateProductionCeremonyBundleStructurally(dir);
    expect(structural.provenanceAuthenticated).toBe(false);
    expect(structural.witnessModel).toBe(WITNESS_MODEL);
    expect(structural.witnessCryptographicIdentityProven).toBe(false);
    expect(() => assertProductionCeremonyAllowsEnrollment(dir)).toThrow(
      /UNAUTHENTICATED_PROVENANCE|authenticateProductionCeremonyFromOwnerTty/i,
    );
    // Channel B documentary file alone still not enrollment authority
    const digest = digestProductionCeremonyBundleV1(structural.bundle);
    recordProductionChannelBDigest({ ceremonyDir: dir, ownerTypedDigestHex: digest });
    expect(() => assertProductionCeremonyAllowsEnrollment(dir)).toThrow(/UNAUTHENTICATED/);
  });

  it('bundle digest binds intended admin; tamper after digest fails', () => {
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4a1b-'));
    dirs.push(dir);
    prepCeremonyDir(dir);
    const before = validateProductionCeremonyBundleStructurally(dir);
    writeIntendedExistingAdminBinding(dir, {
      enrollment_mode: 'CLAIM_EXISTING_ADMIN',
      intended_admin_user_id: 'b22b22b2-0000-4000-8000-000000000022',
      intended_admin_email: 'owner@example.local',
      note: 'tampered',
    });
    expect(() => validateProductionCeremonyBundleStructurally(dir)).toThrow(/intended admin id mismatch/i);
    void before;
  });

  it('keygen requires phase21 flag; TTY bypass needs test hooks', () => {
    process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
    const dir = mkdtempSync(join(tmpdir(), 'p21-s4a1k-'));
    dirs.push(dir);
    expect(() =>
      generateProductionBootstrapKeypairFiles({
        ceremonyDir: dir,
        keyId: 'k',
        phase21ProductionOwnerBootstrap: false,
        requireInteractiveTty: false,
      }),
    ).toThrow(/phase21-production-owner-bootstrap/i);
  });

  it('production profile requires system_identifier and verify_full; refuses loopback', () => {
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

  it('readiness derives source ready without hardcoding ceremony ready', () => {
    const report = buildProductionOwnerBootstrapReadinessReport({});
    expect(report.productionOwnerBootstrapSourceReady).toBe(true);
    expect(report.readyForProductionOwnerBootstrapCeremony).toBe(false);
    expect(report.callerControlledProductionTrustClass).toBe(false);
    expect(report.productionTrustRuntimeBranded).toBe(true);
    expect(report.layerCDProvenanceAuthImplemented).toBe(true);
    expect(report.sameHostChannelBFileSufficient).toBe(false);
    expect(report.channelBOperationalSource).toBe('LIVE_OWNER_TTY_OFFLINE_MEDIA');
    expect(report.witnessCryptographicIdentityProven).toBe(false);
  });

  it('claim preflight uses correct session columns and fails closed on query error', async () => {
    const clientFail = {
      async query(sql: string) {
        if (sql.includes('admin_roles')) return { rows: [{ id: 'role-1', status: 'ACTIVE' }] };
        if (sql.includes('admin_owner_authority')) return { rows: [{ holder: null }] };
        if (sql.includes('count(DISTINCT')) return { rows: [{ c: 0 }] };
        if (sql.includes("revoked_at IS NULL") && sql.includes('admin_role_bindings'))
          return { rows: [{ c: 0 }] };
        if (sql.includes('FROM admin_users WHERE id'))
          return {
            rows: [
              {
                id: 'a11a11a1-0000-4000-8000-000000000011',
                email: 'owner@example.local',
                status: 'ACTIVE',
              },
            ],
          };
        if (sql.includes('lower(trim(email))')) return { rows: [{ c: 1 }] };
        if (sql.includes('admin_sessions')) throw new Error('schema boom');
        return { rows: [] };
      },
    };
    const failed = await preflightClaimExistingAdmin(clientFail as never, {
      intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
      intendedAdminEmail: 'owner@example.local',
      lockForUpdate: false,
    });
    expect(failed.eligible).toBe(false);
    expect(failed.refuseCode).toBe('EXISTING_ADMIN_SECURITY_STATE_UNKNOWN');
  });

  it('claim preflight refuses active session / webauthn / recovery / action tokens', async () => {
    function clientWith(overrides: Record<string, unknown>) {
      let i = 0;
      const seq = [
        { rows: [{ id: 'role-1', status: 'ACTIVE' }] },
        { rows: [{ holder: null }] },
        { rows: [{ c: 0 }] },
        { rows: [{ c: 0 }] },
        {
          rows: [
            {
              id: 'a11a11a1-0000-4000-8000-000000000011',
              email: 'owner@example.local',
              status: 'ACTIVE',
            },
          ],
        },
        { rows: [{ c: 1 }] },
        // credential total
        { rows: [{ c: overrides.credTotal ?? 0 }] },
        // credential group
        { rows: (overrides.credRows as unknown[]) ?? [] },
        // recovery
        { rows: [{ c: overrides.recovery ?? 0 }] },
        // sessions
        { rows: [{ c: overrides.sessions ?? 0 }] },
        // action tokens
        { rows: [{ c: overrides.tokens ?? 0 }] },
      ];
      return {
        async query() {
          return seq[i++] ?? { rows: [] };
        },
      };
    }

    const sess = await preflightClaimExistingAdmin(clientWith({ sessions: 1 }) as never, {
      intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
      intendedAdminEmail: 'owner@example.local',
      lockForUpdate: false,
    });
    expect(sess.eligible).toBe(false);
    expect(sess.refuseCode).toBe('EXISTING_ADMIN_AUTH_STATE_REQUIRES_OWNER_REVIEW');

    const wa = await preflightClaimExistingAdmin(
      clientWith({
        credTotal: 1,
        credRows: [{ credential_type: 'WEBAUTHN', status: 'ACTIVE', c: 1 }],
      }) as never,
      {
        intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
        intendedAdminEmail: 'owner@example.local',
        lockForUpdate: false,
      },
    );
    expect(wa.refuseCode).toBe('EXISTING_ADMIN_AUTH_STATE_REQUIRES_OWNER_REVIEW');

    const rec = await preflightClaimExistingAdmin(clientWith({ recovery: 2 }) as never, {
      intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
      intendedAdminEmail: 'owner@example.local',
      lockForUpdate: false,
    });
    expect(rec.refuseCode).toBe('EXISTING_ADMIN_AUTH_STATE_REQUIRES_OWNER_REVIEW');

    const tok = await preflightClaimExistingAdmin(clientWith({ tokens: 1 }) as never, {
      intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
      intendedAdminEmail: 'owner@example.local',
      lockForUpdate: false,
    });
    expect(tok.refuseCode).toBe('EXISTING_ADMIN_AUTH_STATE_REQUIRES_OWNER_REVIEW');
  });

  it('claim preflight eligible only when fully clean', async () => {
    const queue: Array<{ rows: unknown[] }> = [
      { rows: [{ id: 'role-1', status: 'ACTIVE' }] },
      { rows: [{ holder: null }] },
      { rows: [{ c: 0 }] },
      { rows: [{ c: 0 }] },
      {
        rows: [
          {
            id: 'a11a11a1-0000-4000-8000-000000000011',
            email: 'owner@example.local',
            status: 'ACTIVE',
          },
        ],
      },
      { rows: [{ c: 1 }] },
      { rows: [{ c: 0 }] },
      { rows: [] },
      { rows: [{ c: 0 }] },
      { rows: [{ c: 0 }] },
      { rows: [{ c: 0 }] },
    ];
    let i = 0;
    const client = {
      async query() {
        return queue[i++] ?? { rows: [] };
      },
    };
    const ok = await preflightClaimExistingAdmin(client as never, {
      intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
      intendedAdminEmail: 'owner@example.local',
      lockForUpdate: false,
    });
    expect(ok.eligible).toBe(true);
    expect(ok.credentialState).toBe('CLEAN_FIRST_OWNER_CLAIM_ELIGIBLE');
    expect(ok.authCounts.activeSessionCount).toBe(0);
  });

  it('CLI enroll-existing remains refuse-by-default and secrets forbidden', () => {
    const src = readFileSync(
      new URL('../src/cli/owner-production-bootstrap.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/STEP4A_SOURCE_ONLY_REFUSES_APPLY|APPLY_GATES_REQUIRED|STEP4A1/);
    expect(src).toMatch(/OWNER_PRODUCTION_BOOTSTRAP_APPLY/);
    expect(src).toMatch(/phase21-production-owner-bootstrap/);
    expect(src).not.toMatch(/forceApply\s*=\s*true/);
    expect(src).toMatch(/SECRET_ARGV_FORBIDDEN|SECRET_ENV_FORBIDDEN/);
  });

  it('minted trust is runtime branded', () => {
    const fakeTrust = {
      pinnedPublicKeys: new Map(),
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
      bootstrap_public_key_sha256_hex: 'ef'.repeat(32),
      enrollment_mode: 'CLAIM_EXISTING_ADMIN' as const,
      intended_admin_user_id: 'a11a11a1-0000-4000-8000-000000000011',
      intended_admin_email: 'owner@example.local',
      witness_model: 'HUMAN_ATTESTED' as const,
      witness_cryptographic_identity_proven: false as const,
      witness_count: 1,
    };
    const minted = mintAuthenticatedProductionBootstrapTrust({
      trust: fakeTrust,
      bundle,
      bundleDigestHex: digestProductionCeremonyBundleV1(bundle),
    });
    expect(isAuthenticatedProductionBootstrapTrust(minted)).toBe(true);
    expect(isAuthenticatedProductionBootstrapTrust({ ...minted })).toBe(false);
  });
});