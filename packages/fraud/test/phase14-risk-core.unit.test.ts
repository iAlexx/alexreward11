import { describe, expect, it } from 'vitest';

import {
  canonicalizeForDigest,
  computeRiskInputsDigest,
  FraudDomainError,
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

describe('Phase 14 input digest (unit)', () => {
  it('same canonical safe inputs => same digest regardless of key order', () => {
    const a = computeRiskInputsDigest(1, { b: 2, a: 1, nested: { z: true, y: 3 } });
    const b = computeRiskInputsDigest(1, { a: 1, nested: { y: 3, z: true }, b: 2 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('semantically different safe inputs => different digest', () => {
    const a = computeRiskInputsDigest(1, { scoreHint: 10 });
    const b = computeRiskInputsDigest(1, { scoreHint: 11 });
    expect(a).not.toBe(b);
  });

  it('canonicalize sorts object keys', () => {
    expect(canonicalizeForDigest({ b: 1, a: 2 })).toBe(canonicalizeForDigest({ a: 2, b: 1 }));
  });
});

describe('Phase 14 fraud package authority surface (unit)', () => {
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
