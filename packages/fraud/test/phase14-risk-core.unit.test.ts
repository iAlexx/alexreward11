import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeForDigest,
  computeRiskInputsDigest,
  FraudDomainError,
  isSensitivePersistedKey,
  parseRiskActions,
  parseRiskSignalWeights,
  parseRiskThresholds,
  validateRiskRuleConfig,
} from '../src/index.js';

describe('Phase 14 risk rule config validation (unit)', () => {
  it('accepts a valid TEST fixture config', () => {
    const config = validateRiskRuleConfig({
      thresholds: { lowMax: 20, mediumMax: 50, highMax: 75 },
      signalWeights: { ACCOUNT_AGE: 10 },
      actions: {
        LOW: 'MANUAL_REVIEW',
        MEDIUM: 'EXTEND_PENDING',
        HIGH: 'HELD',
        CRITICAL: 'WITHDRAWAL_BLOCKED',
      },
    });
    expect(config.thresholds.highMax).toBe(75);
    expect(config.signalWeights.ACCOUNT_AGE).toBe(10);
    expect(config.actions.CRITICAL).toBe('WITHDRAWAL_BLOCKED');
  });

  it('rejects malformed thresholds', () => {
    expect(() => parseRiskThresholds({ lowMax: 20, mediumMax: 10, highMax: 75 })).toThrow(
      FraudDomainError,
    );
    expect(() => parseRiskThresholds({ lowMax: 20.5, mediumMax: 50, highMax: 75 })).toThrow(
      FraudDomainError,
    );
    expect(() =>
      parseRiskThresholds({ lowMax: 20, mediumMax: 50, highMax: 75, extra: 1 }),
    ).toThrow(FraudDomainError);
  });

  it('rejects malformed signal weights', () => {
    expect(() => parseRiskSignalWeights({ 'bad-key': 1 })).toThrow(FraudDomainError);
    expect(() => parseRiskSignalWeights({ ACCOUNT_AGE: 1.5 })).toThrow(FraudDomainError);
    expect(() => parseRiskSignalWeights({ ACCOUNT_AGE: 101 })).toThrow(FraudDomainError);
  });

  it('rejects malformed actions', () => {
    expect(() =>
      parseRiskActions({
        LOW: 'MANUAL_REVIEW',
        MEDIUM: 'MANUAL_REVIEW',
        HIGH: 'HELD',
        CRITICAL: 'BAN_FOREVER',
      }),
    ).toThrow(FraudDomainError);
    expect(() =>
      parseRiskActions({
        LOW: 'MANUAL_REVIEW',
        MEDIUM: 'MANUAL_REVIEW',
        HIGH: 'HELD',
      }),
    ).toThrow(FraudDomainError);
  });
});

describe('Phase 14 input digest + canonical JSON (unit)', () => {
  it('same canonical safe inputs => same digest regardless of key order', () => {
    const a = computeRiskInputsDigest(1, { b: 2, a: 1, nested: { z: true, y: 3 } });
    const b = computeRiskInputsDigest(1, { a: 1, nested: { y: 3, z: true }, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('array order is significant for digests', () => {
    const a = computeRiskInputsDigest(1, { ids: ['a', 'b'] });
    const b = computeRiskInputsDigest(1, { ids: ['b', 'a'] });
    expect(a).not.toBe(b);
  });

  it('ruleVersion difference changes digest', () => {
    const a = computeRiskInputsDigest(1, { x: 1 });
    const b = computeRiskInputsDigest(2, { x: 1 });
    expect(a).not.toBe(b);
  });

  it('semantically different safe inputs => different digest', () => {
    const a = computeRiskInputsDigest(1, { scoreHint: 10 });
    const b = computeRiskInputsDigest(1, { scoreHint: 11 });
    expect(a).not.toBe(b);
  });

  it('canonicalize sorts object keys', () => {
    expect(canonicalizeForDigest({ b: 1, a: 2 })).toBe(canonicalizeForDigest({ a: 2, b: 1 }));
  });

  it('rejects Date / Map / Set / bigint / undefined / non-finite / function', () => {
    expect(() => canonicalizeForDigest(new Date())).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest(new Map())).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest(new Set())).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest({ n: 1n })).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest({ u: undefined })).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest({ n: Number.NaN })).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest({ n: Number.POSITIVE_INFINITY })).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest({ n: Number.NEGATIVE_INFINITY })).toThrow(FraudDomainError);
    expect(() => canonicalizeForDigest({ f: () => 1 })).toThrow(FraudDomainError);
    expect(() => computeRiskInputsDigest(1, { when: new Date() })).toThrow(FraudDomainError);
  });

  it('accepts plain JSON including null-prototype objects', () => {
    const plain = Object.create(null) as Record<string, unknown>;
    plain.a = 1;
    expect(canonicalizeForDigest(plain)).toBe(canonicalizeForDigest({ a: 1 }));
  });

  it('preserves own __proto__ JSON key without digest collision', () => {
    const withProtoKey = JSON.parse('{"a":1,"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(withProtoKey, '__proto__')).toBe(true);

    const withoutProto = { a: 1 };
    expect(canonicalizeForDigest(withProtoKey)).not.toBe(canonicalizeForDigest(withoutProto));
    expect(computeRiskInputsDigest(1, withProtoKey)).not.toBe(computeRiskInputsDigest(1, withoutProto));

    const withOtherProto = JSON.parse('{"a":1,"__proto__":{"x":2}}') as Record<string, unknown>;
    expect(computeRiskInputsDigest(1, withProtoKey)).not.toBe(
      computeRiskInputsDigest(1, withOtherProto),
    );

    // Unusual valid JSON keys remain preserved / deterministic.
    const unusual = JSON.parse(
      '{"__proto__":{"ok":true},"constructor":"c","prototype":"p","z":1,"a":2}',
    ) as Record<string, unknown>;
    const unusualReordered = JSON.parse(
      '{"a":2,"prototype":"p","constructor":"c","z":1,"__proto__":{"ok":true}}',
    ) as Record<string, unknown>;
    expect(canonicalizeForDigest(unusual)).toBe(canonicalizeForDigest(unusualReordered));
    expect(canonicalizeForDigest(unusual)).toContain('"__proto__"');
    expect(canonicalizeForDigest(unusual)).toContain('"constructor"');
    expect(canonicalizeForDigest(unusual)).toContain('"prototype"');
  });

  it('rejects cyclic plain objects and arrays with typed RISK_SNAPSHOT_INVALID', () => {
    const selfCycle: Record<string, unknown> = {};
    selfCycle.self = selfCycle;
    expect(() => canonicalizeForDigest(selfCycle)).toThrow(FraudDomainError);
    try {
      canonicalizeForDigest(selfCycle);
      expect.unreachable('expected cycle rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(FraudDomainError);
      expect((error as FraudDomainError).code).toBe('RISK_SNAPSHOT_INVALID');
    }

    const nested: Record<string, unknown> = { child: {} };
    (nested.child as Record<string, unknown>).parent = nested;
    expect(() => canonicalizeForDigest(nested)).toThrow(FraudDomainError);
    try {
      computeRiskInputsDigest(1, nested);
      expect.unreachable('expected nested cycle rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(FraudDomainError);
      expect((error as FraudDomainError).code).toBe('RISK_SNAPSHOT_INVALID');
    }

    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalizeForDigest(arr)).toThrow(FraudDomainError);
    try {
      canonicalizeForDigest(arr);
      expect.unreachable('expected array cycle rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(FraudDomainError);
      expect((error as FraudDomainError).code).toBe('RISK_SNAPSHOT_INVALID');
    }
  });
});

describe('Phase 14 sensitive key normalization (unit)', () => {
  it('rejects private_key / seed / seed_phrase / access_token / authorization / cookie / IP / geo variants', () => {
    for (const key of [
      'private_key',
      'privateKey',
      'seed',
      'seed_phrase',
      'seedPhrase',
      'access_token',
      'authorization',
      'cookie',
      'set_cookie',
      'ipAddress',
      'raw_ip',
      'client_ip',
      'remoteIp',
      'exact_ip',
      'latitude',
      'longitude',
      'gps',
    ]) {
      expect(isSensitivePersistedKey(key), key).toBe(true);
      expect(() => computeRiskInputsDigest(1, { [key]: 'x' })).toThrow(FraudDomainError);
    }
  });

  it('allows privacy-safe ip_hash / ipHash', () => {
    expect(isSensitivePersistedKey('ip_hash')).toBe(false);
    expect(isSensitivePersistedKey('ipHash')).toBe(false);
    const digest = computeRiskInputsDigest(1, {
      ip_hash: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
      ipHash: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
    });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects sensitive keys in outputs path via digest/canonical shared validation', () => {
    expect(() =>
      canonicalizeForDigest({ outputs: { access_token: 'x' } }),
    ).toThrow(FraudDomainError);
  });
});

describe('Phase 14 digest authority surface (unit)', () => {
  it('PersistRiskSnapshotInput source has no caller inputsDigest field', () => {
    const path = fileURLToPath(new URL('../src/risk-snapshot.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/inputsDigest\?:/);
    expect(source).not.toMatch(/input\.inputsDigest/);
    expect(source).toMatch(/computeRiskInputsDigest\(input\.ruleVersion,\s*input\.safeInputs\)/);
  });

  it('does not export client score/trust/eligibility setters or ledger writers', async () => {
    const mod = await import('../src/index.js');
    const names = Object.keys(mod);
    expect(names).not.toContain('setClientRiskScore');
    expect(names).not.toContain('setTrustScore');
    expect(names).not.toContain('setEligibility');
    expect(names).not.toContain('postLedgerTransaction');
    expect(names).not.toContain('approveWithdrawal');
    expect(names).not.toContain('calculateRiskScore');
    expect(names).not.toContain('evaluateUserRisk');
  });
});
