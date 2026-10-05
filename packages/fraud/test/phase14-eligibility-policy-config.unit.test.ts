import { describe, expect, it } from 'vitest';

import {
  evaluateConfiguredEligibility,
  evaluateEligibilityGates,
  parseEligibilityPolicyConfig,
  type EligibilityGateFact,
  type EligibilityPolicyConfig,
} from '../src/index.js';
import { TEST_ELIGIBILITY_POLICY_CONFIG } from './harness.js';

const TEST_WITHDRAWAL_CONFIG: EligibilityPolicyConfig = parseEligibilityPolicyConfig(
  TEST_ELIGIBILITY_POLICY_CONFIG,
);

function fact(
  code: EligibilityGateFact['code'],
  eligible: boolean,
  reasonCode: string,
): EligibilityGateFact {
  return { code, eligible, reasonCode };
}

describe('Phase 14 Eligibility policy config parser (unit)', () => {
  it('parses valid TEST fixture deterministically and immutably', () => {
    const a = parseEligibilityPolicyConfig(TEST_ELIGIBILITY_POLICY_CONFIG);
    const b = parseEligibilityPolicyConfig(
      JSON.parse(JSON.stringify(TEST_ELIGIBILITY_POLICY_CONFIG)),
    );
    expect(a).toEqual(b);
    expect(a.actions.WITHDRAWAL_REQUEST?.requiredGates).toEqual([
      'ACCOUNT_STATE',
      'RISK_POLICY',
      'FEATURE_FLAG',
    ]);
    expect(a.actions.WITHDRAWAL_REQUEST?.precedence).toEqual([
      'RISK_POLICY',
      'ACCOUNT_STATE',
      'FEATURE_FLAG',
    ]);
    expect(a.actions.WITHDRAWAL_REQUEST?.riskAllowedActions).toEqual([
      'ALLOW',
      'EXTEND_PENDING',
      'MANUAL_REVIEW',
      'HELD',
    ]);
    expect(a.actions.AD_SESSION_START?.riskAllowedActions).toBeUndefined();
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.actions)).toBe(true);
    expect(Object.isFrozen(a.actions.WITHDRAWAL_REQUEST)).toBe(true);
    expect(Object.isFrozen(a.actions.WITHDRAWAL_REQUEST!.requiredGates)).toBe(true);
  });

  it('rejects malformed configs fail-closed', () => {
    const cases: unknown[] = [
      {},
      { rules: {} },
      { actions: {}, extra: 1 },
      { actions: {} },
      { actions: { NOT_AN_ACTION: { requiredGates: ['ACCOUNT_STATE'], precedence: ['ACCOUNT_STATE'] } } },
      {
        actions: {
          WITHDRAWAL_REQUEST: 'nope',
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            precedence: ['ACCOUNT_STATE'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: [],
            precedence: [],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'ACCOUNT_STATE'],
            precedence: ['ACCOUNT_STATE'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['NOT_A_GATE'],
            precedence: ['NOT_A_GATE'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE'],
            precedence: [],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY'],
            precedence: ['ACCOUNT_STATE', 'ACCOUNT_STATE'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY'],
            precedence: ['ACCOUNT_STATE'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE'],
            precedence: ['ACCOUNT_STATE', 'RISK_POLICY'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE'],
            precedence: ['ACCOUNT_STATE'],
            founderBypass: true,
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY'],
            precedence: ['RISK_POLICY', 'ACCOUNT_STATE'],
          },
        },
      },
      {
        actions: {
          AD_SESSION_START: {
            requiredGates: ['ACCOUNT_STATE'],
            precedence: ['ACCOUNT_STATE'],
            riskAllowedActions: ['ALLOW'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY'],
            precedence: ['RISK_POLICY', 'ACCOUNT_STATE'],
            riskAllowedActions: [],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY'],
            precedence: ['RISK_POLICY', 'ACCOUNT_STATE'],
            riskAllowedActions: ['ALLOW', 'ALLOW'],
          },
        },
      },
      {
        actions: {
          WITHDRAWAL_REQUEST: {
            requiredGates: ['ACCOUNT_STATE', 'RISK_POLICY'],
            precedence: ['RISK_POLICY', 'ACCOUNT_STATE'],
            riskAllowedActions: ['NOT_A_RISK_ACTION'],
          },
        },
      },
    ];

    for (const raw of cases) {
      expect(() => parseEligibilityPolicyConfig(raw)).toThrowError(
        expect.objectContaining({ code: 'ELIGIBILITY_POLICY_CONFIG_INVALID' }),
      );
    }

    expect(() => parseEligibilityPolicyConfig(null)).toThrowError(
      expect.objectContaining({ code: 'ELIGIBILITY_POLICY_CONFIG_INVALID' }),
    );
  });
});

describe('Phase 14 configured Eligibility evaluator (unit)', () => {
  const policy = {
    policyVersion: 9,
    policyConfig: TEST_WITHDRAWAL_CONFIG,
  };

  it('requires exact gate completeness for configured action', () => {
    try {
      evaluateConfiguredEligibility(policy, 'WITHDRAWAL_REQUEST', [
        fact('ACCOUNT_STATE', true, 'ACCOUNT_OK'),
        fact('FEATURE_FLAG', true, 'FEATURE_OK'),
      ]);
      expect.unreachable('expected mismatch');
    } catch (e) {
      expect(e).toMatchObject({
        code: 'ELIGIBILITY_GATE_SET_MISMATCH',
        details: {
          requiredGateCodes: ['ACCOUNT_STATE', 'FEATURE_FLAG', 'RISK_POLICY'],
          providedGateCodes: ['ACCOUNT_STATE', 'FEATURE_FLAG'],
          missingGateCodes: ['RISK_POLICY'],
          extraGateCodes: [],
        },
      });
    }

    try {
      evaluateConfiguredEligibility(policy, 'WITHDRAWAL_REQUEST', [
        fact('ACCOUNT_STATE', true, 'ACCOUNT_OK'),
        fact('RISK_POLICY', true, 'RISK_OK'),
        fact('FEATURE_FLAG', true, 'FEATURE_OK'),
        fact('MEMBERSHIP', true, 'MEMBERSHIP_OK'),
      ]);
      expect.unreachable('expected mismatch');
    } catch (e) {
      expect(e).toMatchObject({
        code: 'ELIGIBILITY_GATE_SET_MISMATCH',
        details: {
          extraGateCodes: ['MEMBERSHIP'],
          missingGateCodes: [],
        },
      });
    }

    const ok = evaluateConfiguredEligibility(policy, 'WITHDRAWAL_REQUEST', [
      fact('FEATURE_FLAG', true, 'FEATURE_OK'),
      fact('RISK_POLICY', true, 'RISK_OK'),
      fact('ACCOUNT_STATE', true, 'ACCOUNT_OK'),
    ]);
    expect(ok.outcome).toBe('ELIGIBLE');
    expect(ok.reasonCodes).toEqual(['ELIGIBLE_ALL_EVALUATED_GATES_PASSED']);
    expect(ok.primaryBlockedGateCode).toBeNull();
    expect(ok.actionType).toBe('WITHDRAWAL_REQUEST');
  });

  it('uses versioned precedence for multi-failure primary outcome; preserves all reasons', () => {
    const factsForward: EligibilityGateFact[] = [
      fact('ACCOUNT_STATE', false, 'ACCOUNT_STATE_NOT_ELIGIBLE'),
      fact('RISK_POLICY', false, 'RISK_POLICY_BLOCKED'),
      fact('FEATURE_FLAG', true, 'FEATURE_OK'),
    ];
    const factsReverse = [...factsForward].reverse();

    const a = evaluateConfiguredEligibility(policy, 'WITHDRAWAL_REQUEST', factsForward);
    const b = evaluateConfiguredEligibility(policy, 'WITHDRAWAL_REQUEST', factsReverse);

    expect(a).toEqual(b);
    expect(a.primaryBlockedGateCode).toBe('RISK_POLICY');
    expect(a.outcome).toBe('INELIGIBLE_RISK_POLICY');
    expect(a.reasonCodes).toEqual(['ACCOUNT_STATE_NOT_ELIGIBLE', 'RISK_POLICY_BLOCKED']);
    expect(a.policyVersion).toBe(9);
  });

  it('unconfigured action fails closed', () => {
    expect(() =>
      evaluateConfiguredEligibility(policy, 'MEMBERSHIP_CLAIM', [
        fact('ACCOUNT_STATE', true, 'OK'),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'ELIGIBILITY_ACTION_POLICY_NOT_CONFIGURED' }),
    );
  });

  it('single failure maps structurally with primaryBlockedGateCode', () => {
    const result = evaluateConfiguredEligibility(policy, 'WITHDRAWAL_REQUEST', [
      fact('ACCOUNT_STATE', false, 'ACCOUNT_STATE_NOT_ELIGIBLE'),
      fact('RISK_POLICY', true, 'RISK_OK'),
      fact('FEATURE_FLAG', true, 'FEATURE_OK'),
    ]);
    expect(result.outcome).toBe('INELIGIBLE_ACCOUNT_STATE');
    expect(result.primaryBlockedGateCode).toBe('ACCOUNT_STATE');
    expect(result.reasonCodes).toEqual(['ACCOUNT_STATE_NOT_ELIGIBLE']);
  });

  it('Step 8 pure evaluator still fails closed on multi-outcome ambiguity', () => {
    expect(() =>
      evaluateEligibilityGates(
        { policyVersion: 9 },
        [
          fact('ACCOUNT_STATE', false, 'ACCOUNT_STATE_NOT_ELIGIBLE'),
          fact('RISK_POLICY', false, 'RISK_POLICY_BLOCKED'),
        ],
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'ELIGIBILITY_EVALUATION_AMBIGUOUS' }),
    );
  });
});
