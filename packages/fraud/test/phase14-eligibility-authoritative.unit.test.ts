import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FraudDomainError,
  parseRiskSignalParams,
  validateRiskRuleConfig,
  type RiskRuleVersion,
} from '../src/index.js';
import { collectConfiguredRiskSignals } from '../src/risk-signal-collector.js';

const TEST_THRESHOLDS = { lowMax: 20, mediumMax: 50, highMax: 75 } as const;
const TEST_ACTIONS = {
  LOW: 'ALLOW',
  MEDIUM: 'EXTEND_PENDING',
  HIGH: 'MANUAL_REVIEW',
  CRITICAL: 'WITHDRAWAL_BLOCKED',
} as const;

describe('Phase 14 Step 11 signal_params parser (unit)', () => {
  it('accepts empty object and valid history params', () => {
    expect(parseRiskSignalParams({})).toEqual({});
    expect(
      parseRiskSignalParams({
        AD_REVERSED_REWARD_HISTORY: { minCount: 2, windowDays: 30 },
        REFERRAL_REJECTED_EDGE_HISTORY: { minCount: 1, windowDays: 7 },
      }),
    ).toEqual({
      AD_REVERSED_REWARD_HISTORY: { minCount: 2, windowDays: 30 },
      REFERRAL_REJECTED_EDGE_HISTORY: { minCount: 1, windowDays: 7 },
    });
  });

  it('rejects unknown keys, non-positive ints, and incomplete entries', () => {
    const cases: unknown[] = [
      null,
      [],
      { UNKNOWN_SIGNAL: { minCount: 1, windowDays: 1 } },
      { AD_REVERSED_REWARD_HISTORY: { minCount: 0, windowDays: 1 } },
      { AD_REVERSED_REWARD_HISTORY: { minCount: 1, windowDays: 0 } },
      { AD_REVERSED_REWARD_HISTORY: { minCount: 1.5, windowDays: 1 } },
      { AD_REVERSED_REWARD_HISTORY: { minCount: 1 } },
      { AD_REVERSED_REWARD_HISTORY: { windowDays: 1 } },
      { AD_REVERSED_REWARD_HISTORY: { minCount: 1, windowDays: 1, extra: 1 } },
    ];
    for (const raw of cases) {
      expect(() => parseRiskSignalParams(raw)).toThrowError(
        expect.objectContaining({ code: 'RISK_RULE_CONFIG_INVALID' }),
      );
    }
  });

  it('requires matching signal_params when history weights are configured', () => {
    expect(() =>
      validateRiskRuleConfig({
        thresholds: TEST_THRESHOLDS,
        signalWeights: { AD_REVERSED_REWARD_HISTORY: 20 },
        actions: TEST_ACTIONS,
        signalParams: {},
      }),
    ).toThrowError(expect.objectContaining({ code: 'RISK_RULE_CONFIG_INVALID' }));

    const ok = validateRiskRuleConfig({
      thresholds: TEST_THRESHOLDS,
      signalWeights: { AD_REVERSED_REWARD_HISTORY: 20 },
      actions: TEST_ACTIONS,
      signalParams: {
        AD_REVERSED_REWARD_HISTORY: { minCount: 2, windowDays: 14 },
      },
    });
    expect(ok.signalParams.AD_REVERSED_REWARD_HISTORY).toEqual({
      minCount: 2,
      windowDays: 14,
    });
  });
});

describe('Phase 14 Step 11 history collector fail-closed (unit)', () => {
  it('fails closed when history weight is present without signalParams', async () => {
    const rule: RiskRuleVersion = {
      id: '00000000-0000-4000-8000-000000000111',
      ruleVersion: 11,
      thresholds: TEST_THRESHOLDS,
      signalWeights: { AD_REVERSED_REWARD_HISTORY: 25 },
      signalParams: {},
      actions: TEST_ACTIONS,
      status: 'ACTIVE',
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
      effectiveTo: null,
      reason: 'phase14-step11-missing-params',
      auditReference: null,
    };
    const fakeClient = {
      query: async () => ({
        rows: [
          {
            user_exists: true,
            open_high_count: 0,
            open_critical_count: 0,
            confirmed_count: 0,
            related_payout_account_count: 0,
            shared_device_count: 0,
            related_network_account_count: 0,
            observation_count_considered: 0,
            network_country_changed: false,
          },
        ],
      }),
    };
    try {
      await collectConfiguredRiskSignals(fakeClient as never, {
        userId: '00000000-0000-4000-8000-000000000001',
        rule,
      });
      expect.unreachable('expected missing params failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FraudDomainError);
      expect((error as FraudDomainError).code).toBe('RISK_RULE_CONFIG_INVALID');
    }
  });
});

describe('Phase 14 Step 11 evaluateAndPersistEligibility input authority (unit)', () => {
  it('rejects caller gate/outcome/policy authority fields on the input type surface', () => {
    const path = fileURLToPath(
      new URL('../src/evaluate-and-persist-eligibility.ts', import.meta.url),
    );
    const source = readFileSync(path, 'utf8');
    const inputBlock = source.match(
      /export interface EvaluateAndPersistEligibilityInput \{[\s\S]*?\n\}/,
    )?.[0];
    expect(inputBlock).toBeDefined();
    for (const forbidden of [
      'gateFacts',
      'outcome',
      'policyVersion',
      'evaluation',
      'decision',
      'riskSnapshotId',
      'reasonCodes',
      'safeInputs',
    ]) {
      expect(inputBlock, forbidden).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    expect(source).toMatch(/resolveActiveEligibilityPolicyVersionForEvaluation\(client\)/);
    expect(source).toMatch(/evaluateConfiguredEligibility\(/);
    expect(source).toMatch(/persistEligibilityDecision\(/);
    expect(source).toMatch(/ELIGIBILITY_GATE_SOURCE_UNAVAILABLE/);
    expect(source).not.toMatch(/\bledger_entries\b/);
    expect(source).not.toMatch(/INSERT INTO ledger/);
  });
});
