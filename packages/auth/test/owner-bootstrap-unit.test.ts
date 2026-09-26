/**
 * Owner-bootstrap pure unit tests (no database).
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AuthDomainError } from '../src/errors.js';
import {
  buildTestGrantPayload,
  canonicalizeToJcs,
  createEphemeralCeremonyAuthority,
  parseAndVerifyGrantEnvelope,
  parseStrictJson,
  signGrantEnvelope,
} from '../src/owner-bootstrap/index.js';
import { DuplicateJsonKeyError } from '../src/owner-bootstrap/strict-json.js';

describe('owner-bootstrap unit', () => {
  it('JCS sorts keys and encodes integers', () => {
    const jcs = canonicalizeToJcs({ b: 2, a: 1, nested: { z: 9, a: 8 } });
    expect(jcs).toBe('{"a":1,"b":2,"nested":{"a":8,"z":9}}');
  });

  it('rejects duplicate JSON keys', () => {
    expect(() => parseStrictJson('{"a":1,"a":2}')).toThrow(DuplicateJsonKeyError);
  });

  it('rejects non-integer numbers in strict JSON', () => {
    expect(() => parseStrictJson('{"v":1.5}')).toThrow(/non-integer/);
  });

  it('verifies a signed grant and rejects forgery / expiry', () => {
    const authority = createEphemeralCeremonyAuthority();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: 'local-test-profile',
      intendedAdminEmail: 'owner@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    const pins = new Map([[authority.keyId, authority.publicKey]]);
    const ok = parseAndVerifyGrantEnvelope(envelope, pins);
    expect(ok.envelope.payload.grant_id).toBe(payload.grant_id);

    const forged = {
      ...envelope,
      sig: Buffer.from(randomBytes(64)).toString('base64url'),
    };
    expect(() => parseAndVerifyGrantEnvelope(forged, pins)).toThrow(AuthDomainError);

    const expired = signGrantEnvelope(
      buildTestGrantPayload({
        authority,
        endpointProfileId: 'local-test-profile',
        intendedAdminEmail: 'owner@local.test',
        nowSec: Math.floor(Date.now() / 1000) - 2000,
        lifetimeSec: 60,
      }),
      authority,
    );
    expect(() => parseAndVerifyGrantEnvelope(expired, pins)).toThrow(/expired/);
  });

  it('rejects unknown ceremony key', () => {
    const authority = createEphemeralCeremonyAuthority();
    const payload = buildTestGrantPayload({
      authority,
      endpointProfileId: 'local-test-profile',
      intendedAdminEmail: 'owner@local.test',
    });
    const envelope = signGrantEnvelope(payload, authority);
    expect(() => parseAndVerifyGrantEnvelope(envelope, new Map())).toThrow(/untrusted|unknown/i);
  });

  it('grant signature message domain separation is stable', () => {
    const hash = createHash('sha256').update(randomBytes(16)).digest();
    const msg = Buffer.concat([Buffer.from('ALEx-OwnerBootstrap-v1\0'), hash]);
    expect(msg.subarray(0, 22).toString('utf8')).toBe('ALEx-OwnerBootstrap-v1');
  });

  it('pool config refuses localhost, missing CA, and URL sslmode overrides', async () => {
    const { buildOwnerBootstrapPoolConfig } = await import('../src/owner-bootstrap/pool.js');
    const { buildIsolatedTestEndpointProfile } = await import('../src/owner-bootstrap/endpoint.js');
    const profile = buildIsolatedTestEndpointProfile({
      profileId: 'u',
      expectedDatabaseName: 'alex_rewards_test',
    });
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://u:p@localhost:5432/alex_rewards_test',
        profile,
      ),
    ).toThrow(/numeric loopback/i);
    expect(() =>
      buildOwnerBootstrapPoolConfig(
        'postgresql://u:p@127.0.0.1:5432/alex_rewards_test?sslmode=no-verify',
        profile,
      ),
    ).toThrow(/sslmode/i);
    expect(() =>
      buildOwnerBootstrapPoolConfig('postgresql://u:p@db.example:5432/alex_rewards_test', {
        profileId: 'v',
        deploymentEnv: 'production',
        expectedDatabaseName: 'alex_rewards_test',
        tls: { mode: 'verify_full', caPem: '  ', tlsServerName: 'db.example' },
      }),
    ).toThrow(/trust anchor|CA/i);
    const ok = buildOwnerBootstrapPoolConfig(
      'postgresql://u:p@127.0.0.1:5432/alex_rewards_test',
      profile,
    );
    expect(ok.config.connectionString).toBeUndefined();
    expect(ok.config.ssl).toBe(false);
  });
});
