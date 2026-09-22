/**
 * G8 Channel A deployment trust derivative — isolated tests (synthetic public data).
 * Schema/consistency only. Not provenance authentication. Not trust installation.
 */
import { describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import type { CeremonyEndpointProfileV1 } from '../src/owner-bootstrap/ceremony-profile-v1.js';
import { digestCeremonySealV1 } from '../src/owner-bootstrap/ceremony-seal-v1.js';
import {
  assertDerivativeConsistentWithProfile,
  assertDerivativeDigestEqualsRecordedSealDigest,
  claimDerivativeProvenanceAuthenticated,
  parseDeploymentTrustDerivativeV1Json,
  refuseSameHostChecksumAsChannelB,
  validateDeploymentTrustDerivativeV1,
} from '../src/owner-bootstrap/ceremony-trust-derivative-v1.js';
import { DuplicateJsonKeyError, parseStrictJson } from '../src/owner-bootstrap/strict-json.js';

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

describe('G8 deployment trust derivative v1', () => {
  it('validates a valid derivative (seal body) with provenance_authenticated false', () => {
    const d = validateDeploymentTrustDerivativeV1(validSeal());
    expect(d.provenance_authenticated).toBe(false);
    expect(d.seal_content_digest_hex).toBe(digestCeremonySealV1(d.seal));
    expect(d.kind).toBe('alex_rewards_owner_ceremony_seal_v1');
  });

  it('rejects missing, extra, and duplicate fields', () => {
    const { key_id: _k, ...missing } = validSeal();
    expect(() => validateDeploymentTrustDerivativeV1(missing)).toThrow(/missing/);
    expect(() => validateDeploymentTrustDerivativeV1(validSeal({ extra: 1 }))).toThrow(
      /unexpected/,
    );
    expect(() =>
      parseDeploymentTrustDerivativeV1Json(
        JSON.stringify(validSeal()).replace('"v":1', '"v":1,"v":1'),
      ),
    ).toThrow(DuplicateJsonKeyError);
  });

  it('rejects key/fingerprint mismatch', () => {
    expect(() =>
      validateDeploymentTrustDerivativeV1(
        validSeal({
          public_key_sha256_hex:
            'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        }),
      ),
    ).toThrow(/does not match SHA-256/);
  });

  it('rejects seal field substitution changing content digest vs Channel B record', () => {
    const d = validateDeploymentTrustDerivativeV1(validSeal());
    const substituted = validateDeploymentTrustDerivativeV1(
      validSeal({ key_id: 'other-key-id-placeholder' }),
    );
    expect(substituted.seal_content_digest_hex).not.toBe(d.seal_content_digest_hex);
    expect(() =>
      assertDerivativeDigestEqualsRecordedSealDigest(
        substituted,
        d.seal_content_digest_hex,
      ),
    ).toThrow(/does not match recorded Channel B digest/);
  });

  it('rejects profile digest mismatch and profile id mismatch', () => {
    const d = validateDeploymentTrustDerivativeV1(validSeal());
    expect(() =>
      assertDerivativeConsistentWithProfile(
        validateDeploymentTrustDerivativeV1(
          validSeal({
            profile_digest_hex: SYNTH_FP_HEX,
          }),
        ),
        PROFILE_A,
      ),
    ).toThrow(/profile_digest_hex/);
    expect(() =>
      assertDerivativeConsistentWithProfile(
        validateDeploymentTrustDerivativeV1(
          validSeal({ endpoint_profile_id: 'other-profile-id' }),
        ),
        PROFILE_A,
      ),
    ).toThrow(/endpoint_profile_id/);
    expect(() => assertDerivativeConsistentWithProfile(d, PROFILE_A)).not.toThrow();
  });

  it('rejects environment mismatch when expectedDeploymentEnv provided', () => {
    const d = validateDeploymentTrustDerivativeV1(validSeal());
    expect(() =>
      assertDerivativeConsistentWithProfile(d, PROFILE_A, {
        expectedDeploymentEnv: 'production',
      }),
    ).toThrow(/deployment_env/);
    expect(() =>
      assertDerivativeConsistentWithProfile(d, PROFILE_A, {
        expectedDeploymentEnv: 'staging',
      }),
    ).not.toThrow();
  });

  it('rejects unsupported versions', () => {
    expect(() => validateDeploymentTrustDerivativeV1(validSeal({ v: 2 }))).toThrow(
      /v must be integer 1/,
    );
  });

  it('same-host copies cannot satisfy provenance', () => {
    expect(() =>
      refuseSameHostChecksumAsChannelB({
        channelAPath: '/host/trust/seal.json',
        claimedChannelBPath: '/host/trust/seal.sha256',
        sameHost: true,
      }),
    ).toThrow(/not independent Channel B/);
  });

  it('refuses to claim derivative provenance authenticated', () => {
    const d = validateDeploymentTrustDerivativeV1(validSeal());
    expect(() => claimDerivativeProvenanceAuthenticated(d)).toThrow(
      /not Owner provenance authentication/,
    );
  });

  it('invalid data fails closed via AuthDomainError', () => {
    expect(() => validateDeploymentTrustDerivativeV1(null)).toThrow(AuthDomainError);
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(DuplicateJsonKeyError);
  });

  it('assertDerivativeDigestEqualsRecordedSealDigest accepts matching digest', () => {
    const d = validateDeploymentTrustDerivativeV1(validSeal());
    expect(() =>
      assertDerivativeDigestEqualsRecordedSealDigest(d, d.seal_content_digest_hex),
    ).not.toThrow();
  });
});
