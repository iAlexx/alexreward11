import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FraudDomainError,
  STEP3_COLLECTOR_SIGNAL_CODES,
  evaluateRiskSignals,
  type RiskRuleVersion,
  type RiskSignalFact,
} from '../src/index.js';
import { collectConfiguredRiskSignals } from '../src/risk-signal-collector.js';

/** Explicit TEST-ONLY fixture thresholds. */
const TEST_THRESHOLDS = { lowMax: 20, mediumMax: 50, highMax: 75 } as const;

const TEST_ACTIONS = {
  LOW: 'ALLOW',
  MEDIUM: 'EXTEND_PENDING',
  HIGH: 'MANUAL_REVIEW',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

function testRule(signalWeights: Record<string, number>): RiskRuleVersion {
  return {
    id: '00000000-0000-4000-8000-000000000099',
    ruleVersion: 1,
    thresholds: TEST_THRESHOLDS,
    signalWeights,
    actions: TEST_ACTIONS,
    status: 'ACTIVE',
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    effectiveTo: null,
    reason: 'phase14-step3-test-only',
    auditReference: null,
  };
}

describe('Phase 14 Step 3 collector registry (unit)', () => {
  it('exports exactly the seven supported threshold-free codes', () => {
    expect([...STEP3_COLLECTOR_SIGNAL_CODES]).toEqual([
      'OPEN_HIGH_FRAUD_FLAG',
      'OPEN_CRITICAL_FRAUD_FLAG',
      'CONFIRMED_FRAUD_FLAG',
      'SHARED_PAYOUT_WALLET',
      'SHARED_DEVICE_SIGNAL',
      'SHARED_NETWORK_SIGNAL',
      'NETWORK_COUNTRY_CHANGED',
    ]);
  });

  it('rejects unsupported configured signal codes before DB collection', async () => {
    const fakeClient = {
      query: async () => {
        throw new Error('collector must fail closed before querying for unsupported codes');
      },
    };
    try {
      await collectConfiguredRiskSignals(fakeClient as never, {
        userId: '00000000-0000-4000-8000-000000000001',
        rule: testRule({ ACCOUNT_AGE: 10 }),
      });
      expect.unreachable('expected unsupported collector failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FraudDomainError);
      expect((error as FraudDomainError).code).toBe('RISK_SIGNAL_COLLECTOR_UNSUPPORTED');
    }
  });

  it('pure evaluateRiskSignals still accepts explicit test facts', () => {
    const result = evaluateRiskSignals(testRule({ OPEN_HIGH_FRAUD_FLAG: 15 }), [
      {
        code: 'OPEN_HIGH_FRAUD_FLAG',
        active: true,
        reasonCode: 'OPEN_HIGH_FRAUD_FLAG',
      },
    ]);
    expect(result.score).toBe(15);
    expect(result.riskTier).toBe('LOW');
  });

  it('EvaluateAndPersistRiskInput has no caller signal/rule/time authority fields', () => {
    const path = fileURLToPath(new URL('../src/evaluate-and-persist.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const inputBlock = source.match(
      /export interface EvaluateAndPersistRiskInput \{[\s\S]*?\n\}/,
    )?.[0];
    expect(inputBlock).toBeDefined();
    for (const forbidden of [
      'signalFacts',
      'signals',
      'activeSignals',
      'score',
      'tier',
      'action',
      'weights',
      'evaluatedAt',
      'effectiveAt',
      'ruleAt',
      'calculatedAt',
    ]) {
      expect(inputBlock, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    expect(inputBlock).not.toMatch(/^\s*readonly rule:/m);
    expect(source).toMatch(/collectConfiguredRiskSignals\(client/);
    expect(source).toMatch(/const evaluatedAt = new Date\(\);/);
    expect(source).toMatch(/signalEvidence/);
  });

  it('collector module has no dynamic SQL / eval', () => {
    const path = fileURLToPath(new URL('../src/risk-signal-collector.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/\beval\s*\(/);
    expect(source).not.toMatch(/new Function/);
    expect(source).not.toMatch(/\$\{.*signal/);
  });

  it('RiskSignalFact fixtures remain valid for pure evaluator unit tests', () => {
    const sample: RiskSignalFact = {
      code: 'SHARED_PAYOUT_WALLET',
      active: false,
      reasonCode: 'NO_SHARED_PAYOUT_WALLET',
      safeDetails: { relatedAccountCount: 0 },
    };
    expect(sample.active).toBe(false);
  });
});
