/**
 * G1 ceremony seal v1 — isolated unit tests (NON-OPERATIONAL synthetic public data).
 * Owner ACCEPTed BD-1…BD-6 design only. Schema validity ≠ authenticated trust root.
 */
import { describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import type { CeremonyEndpointProfileV1 } from '../src/owner-bootstrap/ceremony-profile-v1.js';
import {
  assertSealProfileDigestMatchesProfile,
  digestCeremonySealV1,
  parseCeremonySealV1Json,
  validateCeremonySealV1,
  type CeremonySealV1,
} from '../src/owner-bootstrap/ceremony-seal-v1.js';
import { DuplicateJsonKeyError } from '../src/owner-bootstrap/strict-json.js';

/** G2 Vector A profile (decision record) — NON-OPERATIONAL. */
const PROFILE_A: CeremonyEndpointProfileV1 = {
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

const DIGEST_A = 'af8d279c39a2c274c6372f8b52de7fde9d73c686db392c60688b9593203b8035';

/** Synthetic public key material (32 zero bytes) — NOT a ceremony key. */
const SYNTH_PUB_HEX = '0000000000000000000000000000000000000000000000000000000000000000';
const SYNTH_FP_HEX = '66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925';

function validSeal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    ceremony_id: '00000000-0000-4000-8000-000000000099',
    ceremony_time_unix: 1_700_000_000,
    authorizer_display_name: 'TEST_AUTHORIZER_PLACEHOLDER',
    witnesses: [
      {
        display_name: 'TEST_WITNESS_PLACEHOLDER',
        role: 'independent_witness',
        attestation_ref: 'TEST_ATTESTATION_REF_PLACEHOLDER',
      },
    ],
    key_id: 'test-key-id-placeholder',
    alg: 'Ed25519',
    public_key_raw_hex: SYNTH_PUB_HEX,
    public_key_sha256_hex: SYNTH_FP_HEX,
    endpoint_profile_id: 'example-profile-v1',
    profile_digest_method: 'JCS_SHA256_V1',
    profile_digest_hex: DIGEST_A,
    key_authorizes_grant_and_redeem_pop: true,
    provenance_channel_b: 'offline_paper_seal',
    ...overrides,
  };
}

describe('G1 ceremony seal validateCeremonySealV1', () => {
  it('accepts a structurally valid synthetic seal', () => {
    const seal = validateCeremonySealV1(validSeal());
    expect(seal.v).toBe(1);
    expect(seal.witnesses).toHaveLength(1);
    expect(seal.profile_digest_method).toBe('JCS_SHA256_V1');
    expect(seal.provenance_channel_b).toBe('offline_paper_seal');
  });

  it('digestCeremonySealV1 is deterministic for the same object', () => {
    const a = digestCeremonySealV1(validSeal());
    const b = digestCeremonySealV1(validSeal());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('assertSealProfileDigestMatchesProfile binds G2 Vector A', () => {
    expect(() =>
      assertSealProfileDigestMatchesProfile(validSeal(), PROFILE_A),
    ).not.toThrow();
  });

  it('rejects digest mismatch against profile (field substitution)', () => {
    expect(() =>
      assertSealProfileDigestMatchesProfile(
        validSeal({ profile_digest_hex: SYNTH_FP_HEX }),
        PROFILE_A,
      ),
    ).toThrow(/profile_digest_hex does not match/);
  });

  it('rejects duplicate JSON keys', () => {
    expect(() =>
      parseCeremonySealV1Json(
        '{"v":1,"v":1,"ceremony_id":"00000000-0000-4000-8000-000000000099","ceremony_time_unix":1,"authorizer_display_name":"A","witnesses":[{"display_name":"W","role":"independent_witness","attestation_ref":"R"}],"key_id":"k","alg":"Ed25519","public_key_raw_hex":"' +
          SYNTH_PUB_HEX +
          '","public_key_sha256_hex":"' +
          SYNTH_FP_HEX +
          '","endpoint_profile_id":"example-profile-v1","profile_digest_method":"JCS_SHA256_V1","profile_digest_hex":"' +
          DIGEST_A +
          '","key_authorizes_grant_and_redeem_pop":true,"provenance_channel_b":"offline_paper_seal"}',
      ),
    ).toThrow(DuplicateJsonKeyError);
  });

  it('rejects unknown fields', () => {
    expect(() => validateCeremonySealV1(validSeal({ sig: 'x' }))).toThrow(
      /unexpected ceremony seal field: sig/,
    );
    expect(() => validateCeremonySealV1(validSeal({ deployment_env: 'staging' }))).toThrow(
      /unexpected ceremony seal field/,
    );
  });

  it('rejects incorrect version', () => {
    expect(() => validateCeremonySealV1(validSeal({ v: 2 }))).toThrow(/v must be integer 1/);
  });

  it('rejects missing required fields', () => {
    const { witnesses: _w, ...noWitnesses } = validSeal();
    expect(() => validateCeremonySealV1(noWitnesses)).toThrow(/missing/);
  });

  it('rejects empty witnesses and bad witness role', () => {
    expect(() => validateCeremonySealV1(validSeal({ witnesses: [] }))).toThrow(/non-empty/);
    expect(() =>
      validateCeremonySealV1(
        validSeal({
          witnesses: [
            {
              display_name: 'W',
              role: 'authorizer_owner',
              attestation_ref: 'R',
            },
          ],
        }),
      ),
    ).toThrow(/independent_witness/);
  });

  it('rejects malformed encodings and fingerprint mismatch', () => {
    expect(() =>
      validateCeremonySealV1(validSeal({ public_key_raw_hex: 'abcd' })),
    ).toThrow(/public_key_raw_hex/);
    expect(() =>
      validateCeremonySealV1(
        validSeal({
          public_key_sha256_hex: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        }),
      ),
    ).toThrow(/does not match SHA-256/);
    expect(() =>
      validateCeremonySealV1(validSeal({ ceremony_time_unix: '1700000000' })),
    ).toThrow(/ceremony_time_unix/);
    expect(() => validateCeremonySealV1(validSeal({ ceremony_time_unix: 1.5 }))).toThrow(
      /ceremony_time_unix/,
    );
  });

  it('rejects unsupported algorithms and provenance / digest method', () => {
    expect(() => validateCeremonySealV1(validSeal({ alg: 'RSA' }))).toThrow(/Ed25519/);
    expect(() =>
      validateCeremonySealV1(validSeal({ profile_digest_method: 'SHA256_FILE' })),
    ).toThrow(/JCS_SHA256_V1/);
    expect(() =>
      validateCeremonySealV1(validSeal({ provenance_channel_b: 'config_signing' })),
    ).toThrow(/offline_paper_seal/);
    expect(() =>
      validateCeremonySealV1(validSeal({ key_authorizes_grant_and_redeem_pop: false })),
    ).toThrow(/must be true/);
  });

  it('does not claim authentication — validated seal is typed public data only', () => {
    const seal: CeremonySealV1 = validateCeremonySealV1(validSeal());
    expect(seal).toBeDefined();
    // Structural pass must not be confused with dual-channel trust establishment.
    expect(seal.provenance_channel_b).toBe('offline_paper_seal');
  });

  it('rejects AuthDomainError for invalid ceremony_id', () => {
    expect(() => validateCeremonySealV1(validSeal({ ceremony_id: 'not-a-uuid' }))).toThrow(
      AuthDomainError,
    );
  });
});
