/**
 * G2 JCS_SHA256_V1 ceremony profile digest — isolated unit tests.
 * Vectors from DECISION_RECORD_G2_G3_G4.md (NON-OPERATIONAL). Not Owner approval of G2.
 */
import { describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  bootstrapEndpointProfileFromCeremonyWire,
  ceremonyWireFromBootstrapEndpointProfile,
  digestCeremonyEndpointProfileV1,
  parseCeremonyEndpointProfileV1Json,
  validateCeremonyEndpointProfileV1,
  type CeremonyEndpointProfileV1,
} from '../src/owner-bootstrap/ceremony-profile-v1.js';
import { canonicalizeToJcs } from '../src/owner-bootstrap/jcs.js';
import { DuplicateJsonKeyError } from '../src/owner-bootstrap/strict-json.js';
import type { BootstrapEndpointProfile } from '../src/owner-bootstrap/endpoint.js';

/** Complete Vector A input — decision record JCS source object (NON-OPERATIONAL). */
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

/** Complete Vector B = A + expected_system_identifier (decision record). */
const VECTOR_B: CeremonyEndpointProfileV1 = {
  ...VECTOR_A,
  expected_system_identifier: '1234567890123456789',
};

const DIGEST_A = 'af8d279c39a2c274c6372f8b52de7fde9d73c686db392c60688b9593203b8035';
const DIGEST_B = '522cfa392d784b849d34f05697e2e940c24c92043b84b47323a105e25a2523b9';

const VECTOR_A_JCS =
  '{"deployment_env":"staging","expected_database_name":"alex_rewards","profile_id":"example-profile-v1","tls":{"ca_pem":"-----BEGIN CERTIFICATE-----\\nMIIBTESTONLYNOTAREALCERT\\n-----END CERTIFICATE-----\\n","mode":"verify_full","tls_server_name":"db.example.invalid"},"v":1}';

describe('G2 ceremony profile digest JCS_SHA256_V1', () => {
  it('Vector A: independent recompute matches decision-record digest', () => {
    expect(canonicalizeToJcs(VECTOR_A)).toBe(VECTOR_A_JCS);
    expect(digestCeremonyEndpointProfileV1(VECTOR_A)).toBe(DIGEST_A);
  });

  it('Vector B: independent recompute matches decision-record digest', () => {
    expect(digestCeremonyEndpointProfileV1(VECTOR_B)).toBe(DIGEST_B);
  });

  it('optional-field omission: A without system id differs from B', () => {
    expect(digestCeremonyEndpointProfileV1(VECTOR_A)).not.toBe(
      digestCeremonyEndpointProfileV1(VECTOR_B),
    );
  });

  it('deterministic canonicalization: key insertion order does not change digest', () => {
    const shuffled = {
      tls: {
        tls_server_name: VECTOR_A.tls.tls_server_name,
        ca_pem: VECTOR_A.tls.ca_pem,
        mode: 'verify_full' as const,
      },
      v: 1 as const,
      expected_database_name: VECTOR_A.expected_database_name,
      deployment_env: VECTOR_A.deployment_env,
      profile_id: VECTOR_A.profile_id,
    };
    expect(digestCeremonyEndpointProfileV1(shuffled)).toBe(DIGEST_A);
  });

  it('rejects duplicate JSON keys before ordinary parsing', () => {
    expect(() =>
      parseCeremonyEndpointProfileV1Json(
        '{"v":1,"v":1,"profile_id":"p","deployment_env":"staging","expected_database_name":"db","tls":{"mode":"verify_full","ca_pem":"x","tls_server_name":"h"}}',
      ),
    ).toThrow(DuplicateJsonKeyError);
  });

  it('rejects unknown fields', () => {
    expect(() =>
      validateCeremonyEndpointProfileV1({ ...VECTOR_A, extra: true }),
    ).toThrow(/unexpected ceremony profile field: extra/);
    expect(() =>
      validateCeremonyEndpointProfileV1({
        ...VECTOR_A,
        tls: { ...VECTOR_A.tls, extra_tls: 1 },
      }),
    ).toThrow(/unexpected tls field/);
  });

  it('rejects incorrect v', () => {
    expect(() => validateCeremonyEndpointProfileV1({ ...VECTOR_A, v: 2 })).toThrow(
      /v must be integer 1/,
    );
    expect(() => validateCeremonyEndpointProfileV1({ ...VECTOR_A, v: 1.5 })).toThrow(
      /v must be integer 1/,
    );
  });

  it('rejects missing required fields', () => {
    const { profile_id: _p, ...noProfileId } = VECTOR_A;
    expect(() => validateCeremonyEndpointProfileV1(noProfileId)).toThrow(/missing/);
    const { tls: _t, ...noTls } = VECTOR_A;
    expect(() => validateCeremonyEndpointProfileV1(noTls)).toThrow(/missing/);
  });

  it('rejects invalid deployment environment', () => {
    expect(() =>
      validateCeremonyEndpointProfileV1({ ...VECTOR_A, deployment_env: 'isolated_test' }),
    ).toThrow(/production or staging/);
  });

  it('rejects invalid TLS configuration', () => {
    expect(() =>
      validateCeremonyEndpointProfileV1({
        ...VECTOR_A,
        tls: { ...VECTOR_A.tls, mode: 'isolated_test_loopback_plaintext' },
      }),
    ).toThrow(/verify_full/);
    expect(() =>
      validateCeremonyEndpointProfileV1({
        ...VECTOR_A,
        tls: { ...VECTOR_A.tls, ca_pem: '' },
      }),
    ).toThrow(/ca_pem/);
    expect(() =>
      validateCeremonyEndpointProfileV1({
        ...VECTOR_A,
        tls: { ...VECTOR_A.tls, spki_sha256_hex: 'ABCD' },
      }),
    ).toThrow(/G5|SPKI|spki_sha256_hex/i);
    expect(() =>
      validateCeremonyEndpointProfileV1({
        ...VECTOR_A,
        tls: {
          ...VECTOR_A.tls,
          spki_sha256_hex: 'ab'.repeat(32),
        },
      }),
    ).toThrow(/G5|SPKI|unsupported/i);
  });

  it('adapter round-trip preserves digest', () => {
    const runtime = bootstrapEndpointProfileFromCeremonyWire(VECTOR_B);
    const wire = ceremonyWireFromBootstrapEndpointProfile(runtime);
    expect(digestCeremonyEndpointProfileV1(wire)).toBe(DIGEST_B);
    expect(wire).toEqual(VECTOR_B);
  });

  it('adapter rejects isolated_test, SPKI, and ambiguous empty optionals', () => {
    const isolated: BootstrapEndpointProfile = {
      profileId: 'p',
      deploymentEnv: 'isolated_test',
      expectedDatabaseName: 'alex_rewards_test',
      tls: { mode: 'isolated_test_loopback_plaintext' },
    };
    expect(() => ceremonyWireFromBootstrapEndpointProfile(isolated)).toThrow(AuthDomainError);

    const withSpki: BootstrapEndpointProfile = {
      profileId: 'example-profile-v1',
      deploymentEnv: 'staging',
      expectedDatabaseName: 'alex_rewards',
      tls: {
        mode: 'verify_full',
        caPem: VECTOR_A.tls.ca_pem,
        tlsServerName: VECTOR_A.tls.tls_server_name,
        spkiSha256Hex: 'ab'.repeat(32),
      },
    };
    expect(() => ceremonyWireFromBootstrapEndpointProfile(withSpki)).toThrow(/G5|SPKI/i);

    const emptySid: BootstrapEndpointProfile = {
      profileId: 'example-profile-v1',
      deploymentEnv: 'staging',
      expectedDatabaseName: 'alex_rewards',
      expectedSystemIdentifier: '',
      tls: {
        mode: 'verify_full',
        caPem: VECTOR_A.tls.ca_pem,
        tlsServerName: VECTOR_A.tls.tls_server_name,
      },
    };
    expect(() => ceremonyWireFromBootstrapEndpointProfile(emptySid)).toThrow(/ambiguous/);
  });
});
