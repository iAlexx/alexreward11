import { describe, expect, it } from 'vitest';

import {
  FraudDomainError,
  evaluateRiskSignals,
  type RiskRuleVersion,
  type RiskSignalFact,
} from '../src/index.js';

/** Explicit TEST-ONLY fixture thresholds (spec initial bands as test data only). */
const TEST_THRESHOLDS = { lowMax: 20, mediumMax: 50, highMax: 75 } as const;

const TEST_ACTIONS = {
  LOW: 'ALLOW',
  MEDIUM: 'EXTEND_PENDING',
  HIGH: 'MANUAL_REVIEW',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

const TEST_WEIGHTS = {
  ACCOUNT_AGE: 10,
  WALLET_REUSE: 25,
  AD_TIMING: 40,
  PRIOR_FLAGS: 30,
  HEAVY_A: 60,
  HEAVY_B: 50,
} as const;

function testRule(overrides?: Partial<RiskRuleVersion>): RiskRuleVersion {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    ruleVersion: 1,
    thresholds: TEST_THRESHOLDS,
    signalWeights: TEST_WEIGHTS,
    actions: TEST_ACTIONS,
    status: 'ACTIVE',
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    effectiveTo: null,
    reason: 'phase14-step2-test-only',
    auditReference: null,
    ...overrides,
  };
}

function fact(
  code: string,
  active: boolean,
  reasonCode = `${code}_ACTIVE`,
): RiskSignalFact {
  return { code, active, reasonCode };
}

describe('Phase 14 evaluateRiskSignals scoring (unit)', () => {
  it('zero active signals => score 0 / LOW / ALLOW', () => {
    const result = evaluateRiskSignals(testRule(), [
      fact('ACCOUNT_AGE', false, 'ACCOUNT_AGE_OK'),
      fact('WALLET_REUSE', false, 'WALLET_OK'),
    ]);
    expect(result.score).toBe(0);
    expect(result.riskTier).toBe('LOW');
    expect(result.action).toBe('ALLOW');
    expect(result.activeSignals).toEqual([]);
    expect(result.neverAutoBan).toBe(true);
  });

  it('one active signal => exact configured weight', () => {
    const result = evaluateRiskSignals(testRule(), [fact('ACCOUNT_AGE', true)]);
    expect(result.score).toBe(10);
    expect(result.contributions).toEqual([
      { code: 'ACCOUNT_AGE', active: true, configuredWeight: 10, contribution: 10 },
    ]);
  });

  it('several active signals => additive integer score', () => {
    const result = evaluateRiskSignals(testRule(), [
      fact('WALLET_REUSE', true),
      fact('ACCOUNT_AGE', true),
    ]);
    expect(result.score).toBe(35);
    expect(result.riskTier).toBe('MEDIUM');
  });

  it('score above 100 clamps to 100', () => {
    const result = evaluateRiskSignals(testRule(), [
      fact('HEAVY_A', true),
      fact('HEAVY_B', true),
    ]);
    expect(result.score).toBe(100);
    expect(result.riskTier).toBe('CRITICAL');
  });

  it('inactive signal contributes 0', () => {
    const result = evaluateRiskSignals(testRule(), [
      fact('AD_TIMING', false, 'AD_TIMING_OK'),
      fact('ACCOUNT_AGE', true),
    ]);
    expect(result.score).toBe(10);
    expect(result.contributions.find((c) => c.code === 'AD_TIMING')?.contribution).toBe(0);
  });
});

describe('Phase 14 evaluateRiskSignals tiers/actions (unit)', () => {
  it('maps score boundaries from resolved rule thresholds 20/50/75', () => {
    const cases: Array<{ weight: number; tier: string; action: string }> = [
      { weight: 0, tier: 'LOW', action: 'ALLOW' },
      { weight: 20, tier: 'LOW', action: 'ALLOW' },
      { weight: 21, tier: 'MEDIUM', action: 'EXTEND_PENDING' },
      { weight: 50, tier: 'MEDIUM', action: 'EXTEND_PENDING' },
      { weight: 51, tier: 'HIGH', action: 'MANUAL_REVIEW' },
      { weight: 75, tier: 'HIGH', action: 'MANUAL_REVIEW' },
      { weight: 76, tier: 'CRITICAL', action: 'WITHDRAWAL_BLOCKED' },
      { weight: 100, tier: 'CRITICAL', action: 'WITHDRAWAL_BLOCKED' },
    ];
    for (const item of cases) {
      const rule = testRule({
        signalWeights: { SIGNAL_X: item.weight },
      });
      const result = evaluateRiskSignals(rule, [fact('SIGNAL_X', true)]);
      expect(result.score, `score ${item.weight}`).toBe(item.weight);
      expect(result.riskTier, `tier ${item.weight}`).toBe(item.tier);
      expect(result.action, `action ${item.weight}`).toBe(item.action);
    }
  });

  it('does not execute actions — returns configured action only', () => {
    const result = evaluateRiskSignals(testRule(), [fact('HEAVY_A', true), fact('HEAVY_B', true)]);
    expect(result.action).toBe('WITHDRAWAL_BLOCKED');
    expect(result.neverAutoBan).toBe(true);
  });
});

describe('Phase 14 evaluateRiskSignals determinism and fail-closed (unit)', () => {
  it('same rule + facts => identical result regardless of input order', () => {
    const factsA = [fact('WALLET_REUSE', true), fact('ACCOUNT_AGE', true), fact('AD_TIMING', false, 'AD_OK')];
    const factsB = [fact('AD_TIMING', false, 'AD_OK'), fact('ACCOUNT_AGE', true), fact('WALLET_REUSE', true)];
    const a = evaluateRiskSignals(testRule(), factsA);
    const b = evaluateRiskSignals(testRule(), factsB);
    expect(a).toEqual(b);
    expect(a.contributions.map((c) => c.code)).toEqual(['ACCOUNT_AGE', 'AD_TIMING', 'WALLET_REUSE']);
  });

  it('duplicate signal code fails closed', () => {
    try {
      evaluateRiskSignals(testRule(), [fact('ACCOUNT_AGE', true), fact('ACCOUNT_AGE', false)]);
      expect.unreachable('expected duplicate failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FraudDomainError);
      expect((error as FraudDomainError).code).toBe('RISK_SIGNAL_DUPLICATE');
    }
  });

  it('unconfigured signal fails closed (active or inactive)', () => {
    try {
      evaluateRiskSignals(testRule(), [fact('UNKNOWN_SIGNAL', true)]);
      expect.unreachable('expected unconfigured failure');
    } catch (error) {
      expect((error as FraudDomainError).code).toBe('RISK_SIGNAL_UNCONFIGURED');
    }
    try {
      evaluateRiskSignals(testRule(), [fact('UNKNOWN_SIGNAL', false)]);
      expect.unreachable('expected unconfigured inactive failure');
    } catch (error) {
      expect((error as FraudDomainError).code).toBe('RISK_SIGNAL_UNCONFIGURED');
    }
  });

  it('malformed signal code / reasonCode fails closed', () => {
    try {
      evaluateRiskSignals(testRule(), [{ code: 'bad-code', active: true, reasonCode: 'OK' }]);
      expect.unreachable('expected invalid signal code');
    } catch (error) {
      expect((error as FraudDomainError).code).toBe('RISK_SIGNAL_INVALID');
    }
    try {
      evaluateRiskSignals(testRule(), [
        { code: 'ACCOUNT_AGE', active: true, reasonCode: 'bad' },
      ]);
      expect.unreachable('expected invalid reasonCode');
    } catch (error) {
      expect((error as FraudDomainError).code).toBe('RISK_SIGNAL_INVALID');
    }
  });

  it('rejects sensitive safeDetails', () => {
    try {
      evaluateRiskSignals(testRule(), [
        {
          code: 'ACCOUNT_AGE',
          active: true,
          reasonCode: 'ACCOUNT_AGE_ACTIVE',
          safeDetails: { access_token: 'x' },
        },
      ]);
      expect.unreachable('expected sensitive details rejection');
    } catch (error) {
      expect((error as FraudDomainError).code).toBe('RISK_SNAPSHOT_INVALID');
    }
  });

  it('RiskSignalFact type surface has no weight/score/tier/action/contribution fields', () => {
    const sample: RiskSignalFact = {
      code: 'ACCOUNT_AGE',
      active: true,
      reasonCode: 'ACCOUNT_AGE_ACTIVE',
    };
    expect('weight' in sample).toBe(false);
    expect('score' in sample).toBe(false);
    expect('tier' in sample).toBe(false);
    expect('action' in sample).toBe(false);
    expect('contribution' in sample).toBe(false);
  });
});
