import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateTrustSignals,
  parseTrustPolicyConfig,
  type TrustPolicyConfig,
  type TrustSignalFact,
} from '../src/index.js';

/** Explicit TEST-ONLY Trust policy — not a production seed. */
const TEST_POLICY: TrustPolicyConfig = parseTrustPolicyConfig({
  signals: {
    ACCOUNT_AGE: { weight: 25, minDays: 7 },
    VERIFIED_PRIMARY_WALLET_AGE: { weight: 25, minDays: 3 },
    REWARDED_AD_HISTORY: { weight: 25, minCount: 1 },
    CONFIRMED_PAYOUT_HISTORY: { weight: 25, minCount: 1 },
  },
  stateThresholds: {
    basicMin: 25,
    establishedMin: 50,
    trustedMin: 75,
  },
});

function fact(
  code: string,
  satisfied: boolean,
  reasonCode = satisfied ? `${code}_MET` : `${code}_NOT_MET`,
): TrustSignalFact {
  return { code, satisfied, reasonCode };
}

describe('Phase 14 parseTrustPolicyConfig (unit)', () => {
  it('accepts valid config and deep-freezes output', () => {
    const parsed = parseTrustPolicyConfig({
      signals: { ACCOUNT_AGE: { weight: 10, minDays: 1 } },
      stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
    });
    expect(parsed.signals.ACCOUNT_AGE).toEqual({ weight: 10, minDays: 1 });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.signals)).toBe(true);
    expect(Object.isFrozen(parsed.stateThresholds)).toBe(true);
    expect(() => {
      (parsed.stateThresholds as { basicMin: number }).basicMin = 99;
    }).toThrow();
  });

  it('rejects missing/empty/unknown roots and Founder fields', () => {
    expect(() => parseTrustPolicyConfig(null)).toThrowError(
      expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }),
    );
    expect(() => parseTrustPolicyConfig({})).toThrowError(
      expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }),
    );
    expect(() =>
      parseTrustPolicyConfig({
        signals: { ACCOUNT_AGE: { weight: 10, minDays: 1 } },
        stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
        founderBypass: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }));
    expect(() =>
      parseTrustPolicyConfig({
        signals: {},
        stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }));
  });

  it('rejects bad weights, mins, and unordered thresholds', () => {
    expect(() =>
      parseTrustPolicyConfig({
        signals: { ACCOUNT_AGE: { weight: 101, minDays: 1 } },
        stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }));
    expect(() =>
      parseTrustPolicyConfig({
        signals: { ACCOUNT_AGE: { weight: 10, minDays: 0 } },
        stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }));
    expect(() =>
      parseTrustPolicyConfig({
        signals: { REWARDED_AD_HISTORY: { weight: 10, minCount: -1 } },
        stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }));
    expect(() =>
      parseTrustPolicyConfig({
        signals: { ACCOUNT_AGE: { weight: 10, minDays: 1 } },
        stateThresholds: { basicMin: 50, establishedMin: 40, trustedMin: 80 },
      }),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }));
  });
});

describe('Phase 14 evaluateTrustSignals scoring (unit)', () => {
  it('zero satisfied signals => score 0 / NEW / NO_SATISFIED_SIGNALS', () => {
    const result = evaluateTrustSignals(TEST_POLICY, [
      fact('ACCOUNT_AGE', false),
      fact('VERIFIED_PRIMARY_WALLET_AGE', false),
      fact('REWARDED_AD_HISTORY', false),
      fact('CONFIRMED_PAYOUT_HISTORY', false),
    ]);
    expect(result.score).toBe(0);
    expect(result.trustState).toBe('NEW');
    expect(result.satisfiedSignals).toEqual([]);
    expect(result.reasonCodes).toEqual(['NO_SATISFIED_SIGNALS']);
  });

  it('empty facts => score 0 and NO_SATISFIED_SIGNALS', () => {
    const result = evaluateTrustSignals(TEST_POLICY, []);
    expect(result.score).toBe(0);
    expect(result.trustState).toBe('NEW');
    expect(result.reasonCodes).toEqual(['NO_SATISFIED_SIGNALS']);
  });

  it('one satisfied signal => exact configured weight', () => {
    const result = evaluateTrustSignals(TEST_POLICY, [fact('ACCOUNT_AGE', true)]);
    expect(result.score).toBe(25);
    expect(result.trustState).toBe('BASIC');
    expect(result.contributions).toEqual([
      {
        code: 'ACCOUNT_AGE',
        satisfied: true,
        configuredWeight: 25,
        contribution: 25,
      },
    ]);
  });

  it('several satisfied signals => additive integer score', () => {
    const result = evaluateTrustSignals(TEST_POLICY, [
      fact('CONFIRMED_PAYOUT_HISTORY', true),
      fact('ACCOUNT_AGE', true),
    ]);
    expect(result.score).toBe(50);
    expect(result.trustState).toBe('ESTABLISHED');
  });

  it('score above 100 clamps to 100', () => {
    const heavy = parseTrustPolicyConfig({
      signals: {
        ACCOUNT_AGE: { weight: 60, minDays: 1 },
        REWARDED_AD_HISTORY: { weight: 50, minCount: 1 },
      },
      stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
    });
    const result = evaluateTrustSignals(heavy, [
      fact('ACCOUNT_AGE', true),
      fact('REWARDED_AD_HISTORY', true),
    ]);
    expect(result.score).toBe(100);
    expect(result.trustState).toBe('TRUSTED');
  });

  it('unsatisfied signal contributes 0', () => {
    const result = evaluateTrustSignals(TEST_POLICY, [
      fact('ACCOUNT_AGE', true),
      fact('REWARDED_AD_HISTORY', false),
    ]);
    expect(result.score).toBe(25);
    expect(
      result.contributions.find((c) => c.code === 'REWARDED_AD_HISTORY')?.contribution,
    ).toBe(0);
  });

  it('rejects duplicate and unconfigured signals', () => {
    expect(() =>
      evaluateTrustSignals(TEST_POLICY, [
        fact('ACCOUNT_AGE', true),
        fact('ACCOUNT_AGE', true),
      ]),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_SNAPSHOT_INVALID' }));

    const single = parseTrustPolicyConfig({
      signals: { ACCOUNT_AGE: { weight: 10, minDays: 1 } },
      stateThresholds: { basicMin: 10, establishedMin: 40, trustedMin: 80 },
    });
    expect(() =>
      evaluateTrustSignals(single, [fact('REWARDED_AD_HISTORY', true)]),
    ).toThrowError(expect.objectContaining({ code: 'TRUST_POLICY_CONFIG_INVALID' }));
  });
});

describe('Phase 14 evaluateTrustSignals state boundaries (unit)', () => {
  it('maps score boundaries from stateThresholds 25/50/75', () => {
    const cases: Array<{ weight: number; state: string }> = [
      { weight: 0, state: 'NEW' },
      { weight: 24, state: 'NEW' },
      { weight: 25, state: 'BASIC' },
      { weight: 49, state: 'BASIC' },
      { weight: 50, state: 'ESTABLISHED' },
      { weight: 74, state: 'ESTABLISHED' },
      { weight: 75, state: 'TRUSTED' },
      { weight: 100, state: 'TRUSTED' },
    ];
    for (const c of cases) {
      const policy = parseTrustPolicyConfig({
        signals: { ACCOUNT_AGE: { weight: c.weight, minDays: 1 } },
        stateThresholds: { basicMin: 25, establishedMin: 50, trustedMin: 75 },
      });
      const result = evaluateTrustSignals(policy, [
        fact('ACCOUNT_AGE', c.weight > 0),
      ]);
      if (c.weight === 0) {
        expect(result.score).toBe(0);
        expect(result.trustState).toBe('NEW');
      } else {
        expect(result.score).toBe(c.weight);
        expect(result.trustState).toBe(c.state);
      }
    }
  });

  it('is deterministic for identical inputs', () => {
    const facts = [
      fact('REWARDED_AD_HISTORY', true),
      fact('ACCOUNT_AGE', true),
      fact('CONFIRMED_PAYOUT_HISTORY', false),
    ];
    const a = evaluateTrustSignals(TEST_POLICY, facts);
    const b = evaluateTrustSignals(TEST_POLICY, [...facts].reverse());
    expect(a).toEqual(b);
    expect(a.contributions.map((c) => c.code)).toEqual([
      'ACCOUNT_AGE',
      'CONFIRMED_PAYOUT_HISTORY',
      'REWARDED_AD_HISTORY',
    ]);
  });
});

describe('Phase 14 Trust evaluator source guards (unit)', () => {
  it('Trust evaluation modules never treat TRUSTED as a Risk override', () => {
    const files = [
      'trust-rule.ts',
      'trust-snapshot.ts',
      'trust-evaluator.ts',
      'trust-signal-collector.ts',
      'evaluate-and-persist-trust.ts',
    ];
    for (const file of files) {
      const path = fileURLToPath(new URL(`../src/${file}`, import.meta.url));
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/override.*risk/i);
      expect(source).not.toMatch(/ignore.*CRITICAL/i);
      expect(source).not.toMatch(/riskAllowedActions/);
      expect(source).not.toMatch(/auto.?payout/i);
      expect(source).not.toMatch(/user_memberships/);
      expect(source).not.toMatch(/founder_number/i);
      expect(source).not.toMatch(/FROM\s+risk_/i);
      expect(source).not.toMatch(/UPDATE\s+risk_/i);
      expect(source).not.toMatch(/ledger_entries/);
      expect(source).not.toMatch(/WITHDRAWAL_BLOCKED/);
    }
  });

  it('exports evaluateAndPersistTrust and related helpers', async () => {
    const mod = await import('../src/index.js');
    expect(Object.keys(mod)).toContain('evaluateAndPersistTrust');
    expect(Object.keys(mod)).toContain('parseTrustPolicyConfig');
    expect(Object.keys(mod)).toContain('collectConfiguredTrustSignals');
    expect(Object.keys(mod)).toContain('evaluateTrustSignals');
  });
});
