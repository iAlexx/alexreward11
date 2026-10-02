import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS,
  assertProductionProfileRequiresSystemIdentifier,
  assertWitnessesAreConcrete,
  buildOwnerBootstrapPoolConfig,
  buildProductionOwnerBootstrapPoolConfig,
  buildProductionOwnerBootstrapReadinessReport,
  digestCeremonyEndpointProfileV1,
  draftProductionCeremonySeal,
  generateProductionBootstrapKeypairFiles,
  missingProductionTrustResources,
  preflightClaimExistingAdmin,
  recordProductionChannelBDigest,
  validateCeremonyEndpointProfileV1,
  writeIntendedExistingAdminBinding,
  writeProductionEndpointProfile,
  assertProductionCeremonyAllowsEnrollment,
  digestCeremonySealV1,
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

describe('phase21 step4a production owner bootstrap (source)', () => {
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

  it('production profile requires system_identifier and verify_full', () => {
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
      buildProductionOwnerBootstrapPoolConfig('postgresql://u:p@10.0.0.1:5432/railway', {
        profileId: 'p',
        deploymentEnv: 'production',
        expectedDatabaseName: 'railway',
        expectedSystemIdentifier: '99',
        tls: { mode: 'isolated_test_loopback_plaintext' as never },
      }),
    ).toThrow(/verify_full|FORBIDDEN/);
  });

  it('production pool refuses loopback and TLS downgrade', () => {
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

  it('wrong DB name / missing CA refused by production pool config', () => {
    expect(() =>
      buildProductionOwnerBootstrapPoolConfig('postgresql://u:p@10.0.0.2:5432/otherdb', {
        profileId: 'p',
        deploymentEnv: 'production',
        expectedDatabaseName: 'railway',
        expectedSystemIdentifier: '99',
        tls: { mode: 'verify_full', caPem: FAKE_CA, tlsServerName: 'db.example' },
      }),
    ).toThrow(/database/);

    expect(() =>
      buildProductionOwnerBootstrapPoolConfig('postgresql://u:p@10.0.0.2:5432/railway', {
        profileId: 'p',
        deploymentEnv: 'production',
        expectedDatabaseName: 'railway',
        expectedSystemIdentifier: '99',
        tls: { mode: 'verify_full', caPem: '   ', tlsServerName: 'db.example' },
      }),
    ).toThrow(/CA|fail closed/i);
  });

  it('missing seal / witness / channel B refused by gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p21-prod-boot-'));
    dirs.push(dir);
    expect(missingProductionTrustResources(dir).length).toBeGreaterThan(3);

    const pub = generateProductionBootstrapKeypairFiles({
      ceremonyDir: dir,
      keyId: 'owner-boot-test-1',
    });
    expect(pub.trust_class).toBe(PRODUCTION_OWNER_BOOTSTRAP_TRUST_CLASS);

    writeProductionEndpointProfile(dir, productionProfile());
    writeIntendedExistingAdminBinding(dir, {
      enrollment_mode: 'CLAIM_EXISTING_ADMIN',
      intended_admin_user_id: 'a11a11a1-0000-4000-8000-000000000011',
      intended_admin_email: 'owner@example.local',
      note: 'locator_only_not_authority',
    });

    expect(() =>
      draftProductionCeremonySeal({
        ceremonyDir: dir,
        authorizerDisplayName: 'Owner',
        witnesses: [],
      }),
    ).toThrow(/witness/i);

    expect(() =>
      draftProductionCeremonySeal({
        ceremonyDir: dir,
        authorizerDisplayName: 'Owner',
        witnesses: [
          { display_name: 'Cursor', role: 'independent_witness', attestation_ref: 'n/a' },
        ],
      }),
    ).toThrow(/forbidden placeholder|placeholder|witness/i);

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
    expect(seal.profile_digest_hex).toBe(digestCeremonyEndpointProfileV1(productionProfile()));

    expect(() => assertProductionCeremonyAllowsEnrollment(dir)).toThrow(/Channel B|CHANNEL_B|ENOENT|no such file/i);

    const digest = digestCeremonySealV1(seal);
    expect(() =>
      recordProductionChannelBDigest({ ceremonyDir: dir, ownerTypedDigestHex: '00'.repeat(32) }),
    ).toThrow(/Channel B digest does not match/);

    recordProductionChannelBDigest({ ceremonyDir: dir, ownerTypedDigestHex: digest });
    const gated = assertProductionCeremonyAllowsEnrollment(dir);
    expect(gated.provenanceAuthenticated).toBe(false);
    expect(gated.intendedAdmin.enrollment_mode).toBe('CLAIM_EXISTING_ADMIN');
  });

  it('seal digest mismatch / wrong bootstrap key refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p21-prod-boot2-'));
    dirs.push(dir);
    generateProductionBootstrapKeypairFiles({ ceremonyDir: dir, keyId: 'k1' });
    writeProductionEndpointProfile(dir, productionProfile());
    writeIntendedExistingAdminBinding(dir, {
      enrollment_mode: 'CLAIM_EXISTING_ADMIN',
      intended_admin_user_id: 'a11a11a1-0000-4000-8000-000000000011',
      intended_admin_email: 'owner@example.local',
      note: 'x',
    });
    const seal = draftProductionCeremonySeal({
      ceremonyDir: dir,
      authorizerDisplayName: 'Owner',
      witnesses: [
        {
          display_name: 'Witness Bob',
          role: 'independent_witness',
          attestation_ref: 'paper-ref-bob',
        },
      ],
    });
    recordProductionChannelBDigest({
      ceremonyDir: dir,
      ownerTypedDigestHex: digestCeremonySealV1(seal),
    });
    // Tamper Channel B digest after recording — enrollment must refuse A/B mismatch
    const bPath = join(dir, 'channel-b-owner-digest-record.json');
    const b = JSON.parse(readFileSync(bPath, 'utf8')) as Record<string, unknown>;
    b.seal_content_digest_hex = 'ab'.repeat(32);
    writeFileSync(bPath, JSON.stringify(b));
    expect(() => assertProductionCeremonyAllowsEnrollment(dir)).toThrow(/Channel A\/B|mismatch/i);
  });

  it('readiness reports source ready but ceremony not ready', () => {
    const report = buildProductionOwnerBootstrapReadinessReport({});
    expect(report.productionOwnerBootstrapSourceReady).toBe(true);
    expect(report.readyForProductionOwnerBootstrapCeremony).toBe(false);
    expect(report.isolatedBootstrapProductionAllowed).toBe(false);
    expect(report.hotWalletKeyReuseForbidden).toBe(true);
    expect(report.claimExistingAdminSupported).toBe(true);
    expect(report.duplicateAdminCreationAllowed).toBe(false);
    expect(report.programmaticForceApply).toBe(false);
    expect(report.missingProductionTrustResources.length).toBeGreaterThan(0);
  });

  it('claim preflight refuses mismatch / seat held / credentials / history (mocked client)', async () => {
    const responses: Array<{ rows: unknown[] }> = [
      { rows: [{ id: 'role-1', status: 'ACTIVE' }] }, // OWNER role
      { rows: [{ holder: 'someone' }] }, // seat held
    ];
    let i = 0;
    const client = {
      async query() {
        return responses[i++] ?? { rows: [] };
      },
    };
    const held = await preflightClaimExistingAdmin(client as never, {
      intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
      intendedAdminEmail: 'owner@example.local',
    });
    expect(held.eligible).toBe(false);
    expect(held.refuseCode).toBe('OWNER_SEAT_ALREADY_HELD');
  });

  it('claim preflight eligible for clean vacant seat + matching ACTIVE admin', async () => {
    const queue: Array<{ rows: unknown[] }> = [
      { rows: [{ id: 'role-1', status: 'ACTIVE' }] },
      { rows: [{ holder: null }] },
      { rows: [{ c: 0 }] }, // history
      { rows: [{ c: 0 }] }, // active
      {
        rows: [
          {
            id: 'a11a11a1-0000-4000-8000-000000000011',
            email: 'owner@example.local',
            status: 'ACTIVE',
          },
        ],
      },
      { rows: [{ c: 1 }] }, // email unique
      { rows: [] }, // credentials
      { rows: [{ c: 0 }] }, // sessions
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
    });
    expect(ok.eligible).toBe(true);
    expect(ok.credentialState).toBe('CLEAN_FIRST_OWNER_CLAIM_ELIGIBLE');
    expect(ok.notes).toContain('locator_only_not_authority');
  });


  it('claim preflight refuses email mismatch / disabled / credentials / history', async () => {
    async function run(queue: Array<{ rows: unknown[] }>) {
      let i = 0;
      const client = {
        async query() {
          return queue[i++] ?? { rows: [] };
        },
      };
      return preflightClaimExistingAdmin(client as never, {
        intendedAdminUserId: 'a11a11a1-0000-4000-8000-000000000011',
        intendedAdminEmail: 'owner@example.local',
      });
    }

    const baseOk = [
      { rows: [{ id: 'role-1', status: 'ACTIVE' }] },
      { rows: [{ holder: null }] },
      { rows: [{ c: 0 }] },
      { rows: [{ c: 0 }] },
    ];

    const emailMismatch = await run([
      ...baseOk,
      {
        rows: [
          {
            id: 'a11a11a1-0000-4000-8000-000000000011',
            email: 'other@example.local',
            status: 'ACTIVE',
          },
        ],
      },
    ]);
    expect(emailMismatch.eligible).toBe(false);
    expect(emailMismatch.refuseCode).toMatch(/EMAIL|MISMATCH|INTENDED/i);

    const disabled = await run([
      ...baseOk,
      {
        rows: [
          {
            id: 'a11a11a1-0000-4000-8000-000000000011',
            email: 'owner@example.local',
            status: 'DISABLED',
          },
        ],
      },
    ]);
    expect(disabled.eligible).toBe(false);
    expect(disabled.refuseCode).toMatch(/DISABLED|STATUS|ACTIVE/i);

    const history = await run([
      { rows: [{ id: 'role-1', status: 'ACTIVE' }] },
      { rows: [{ holder: null }] },
      { rows: [{ c: 1 }] },
    ]);
    expect(history.eligible).toBe(false);
    expect(history.refuseCode).toBe('OWNER_BINDING_HISTORY_EXISTS');

    const creds = await run([
      ...baseOk,
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
      {
        rows: [
          { credential_type: 'PASSWORD', status: 'ACTIVE', c: 1 },
          { credential_type: 'TOTP', status: 'ACTIVE', c: 1 },
        ],
      },
      { rows: [{ c: 0 }] },
    ]);
    expect(creds.eligible).toBe(false);
    expect(creds.refuseCode).toBe('EXISTING_ADMIN_CREDENTIAL_STATE_REQUIRES_OWNER_REVIEW');
    expect(creds.credentialState).toBe('EXISTING_ADMIN_CREDENTIAL_STATE_REQUIRES_OWNER_REVIEW');
  });

  it('assertWitnessesAreConcrete rejects empty', () => {
    expect(() => assertWitnessesAreConcrete([])).toThrow(/witness/);
  });

  it('CLI enroll-existing remains refuse-by-default (source assertion)', () => {
    const src = readFileSync(
      new URL('../src/cli/owner-production-bootstrap.ts', import.meta.url),
      'utf8',
    );
    expect(src).toMatch(/STEP4A_SOURCE_ONLY_REFUSES_APPLY|APPLY_GATES_REQUIRED/);
    expect(src).toMatch(/OWNER_PRODUCTION_BOOTSTRAP_APPLY/);
    expect(src).not.toMatch(/forceApply\s*=\s*true/);
    expect(src).toMatch(/SECRET_ARGV_FORBIDDEN|SECRET_ENV_FORBIDDEN/);
  });
});