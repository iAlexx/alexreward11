import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ELIGIBILITY_GATE_CODES,
  evaluateEligibilityGates,
  type EligibilityGateCode,
  type EligibilityGateFact,
} from '../src/index.js';

const POLICY = { policyVersion: 7 } as const;

function passFact(
  code: EligibilityGateCode,
  reasonCode = `${code}_OK`,
): EligibilityGateFact {
  return { code, eligible: true, reasonCode, safeDetails: { gate: code } };
}

function failFact(
  code: EligibilityGateCode,
  reasonCode: string,
): EligibilityGateFact {
  return { code, eligible: false, reasonCode, safeDetails: { gate: code } };
}

const ALL_PASS_FACTS: EligibilityGateFact[] = ELIGIBILITY_GATE_CODES.map((code) =>
  passFact(code),
);

const SINGLE_FAILURE_CASES: ReadonlyArray<{
  code: EligibilityGateCode;
  outcome: string;
  reason: string;
}> = [
  {
    code: 'ACCOUNT_STATE',
    outcome: 'INELIGIBLE_ACCOUNT_STATE',
    reason: 'ACCOUNT_STATE_NOT_ELIGIBLE',
  },
  {
    code: 'RISK_POLICY',
    outcome: 'INELIGIBLE_RISK_POLICY',
    reason: 'RISK_POLICY_BLOCKED',
  },
  {
    code: 'PROVIDER_LIMIT',
    outcome: 'INELIGIBLE_PROVIDER_LIMIT',
    reason: 'PROVIDER_LIMIT_REACHED',
  },
  {
    code: 'COUNTRY_POLICY',
    outcome: 'INELIGIBLE_COUNTRY',
    reason: 'COUNTRY_POLICY_BLOCKED',
  },
  {
    code: 'MEMBERSHIP',
    outcome: 'INELIGIBLE_MEMBERSHIP',
    reason: 'MEMBERSHIP_NOT_ELIGIBLE',
  },
  {
    code: 'FEATURE_FLAG',
    outcome: 'INELIGIBLE_FEATURE_DISABLED',
    reason: 'FEATURE_FLAG_DISABLED',
  },
];

describe('Phase 14 Eligibility gate evaluator (unit)', () => {
  it('all six gates eligible => ELIGIBLE with canonical gateState regardless of input order', () => {
    const reversed = [...ALL_PASS_FACTS].reverse();
    const shuffled = [
      ALL_PASS_FACTS[4]!,
      ALL_PASS_FACTS[1]!,
      ALL_PASS_FACTS[5]!,
      ALL_PASS_FACTS[0]!,
      ALL_PASS_FACTS[3]!,
      ALL_PASS_FACTS[2]!,
    ];

    const a = evaluateEligibilityGates(POLICY, ALL_PASS_FACTS);
    const b = evaluateEligibilityGates(POLICY, reversed);
    const c = evaluateEligibilityGates(POLICY, shuffled);

    for (const result of [a, b, c]) {
      expect(result.outcome).toBe('ELIGIBLE');
      expect(result.reasonCodes).toEqual(['ELIGIBLE_ALL_EVALUATED_GATES_PASSED']);
      expect(result.policyVersion).toBe(7);
      expect(result.gateState.map((g) => g.code)).toEqual([...ELIGIBILITY_GATE_CODES].sort());
    }
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('maps each single blocked gate to its structural outcome', () => {
    for (const { code, outcome, reason } of SINGLE_FAILURE_CASES) {
      const facts = ELIGIBILITY_GATE_CODES.map((gateCode) =>
        gateCode === code ? failFact(code, reason) : passFact(gateCode),
      );
      const result = evaluateEligibilityGates(POLICY, facts);
      expect(result.outcome).toBe(outcome);
      expect(result.reasonCodes).toEqual([reason]);
      expect(result.policyVersion).toBe(7);
      const failed = result.gateState.find((g) => g.code === code);
      expect(failed?.eligible).toBe(false);
      expect(failed?.reasonCode).toBe(reason);
    }
  });

  it('fails closed on multiple distinct blocked outcomes without inventing precedence', () => {
    const err1 = (() => {
      try {
        evaluateEligibilityGates(POLICY, [
          failFact('ACCOUNT_STATE', 'ACCOUNT_STATE_NOT_ELIGIBLE'),
          failFact('RISK_POLICY', 'RISK_POLICY_BLOCKED'),
        ]);
        return null;
      } catch (e) {
        return e as { code: string; details?: Record<string, unknown> };
      }
    })();
    expect(err1?.code).toBe('ELIGIBILITY_EVALUATION_AMBIGUOUS');
    expect(err1?.details?.blockedOutcomes).toEqual([
      'INELIGIBLE_ACCOUNT_STATE',
      'INELIGIBLE_RISK_POLICY',
    ]);
    expect(err1?.details?.failedGateCodes).toEqual(['ACCOUNT_STATE', 'RISK_POLICY']);

    const err2 = (() => {
      try {
        evaluateEligibilityGates(POLICY, [
          failFact('MEMBERSHIP', 'MEMBERSHIP_X'),
          failFact('PROVIDER_LIMIT', 'PROVIDER_Y'),
          failFact('COUNTRY_POLICY', 'COUNTRY_Z'),
        ]);
        return null;
      } catch (e) {
        return e as { code: string; details?: Record<string, unknown> };
      }
    })();
    expect(err2?.code).toBe('ELIGIBILITY_EVALUATION_AMBIGUOUS');
    expect(err2?.details?.blockedOutcomes).toEqual([
      'INELIGIBLE_COUNTRY',
      'INELIGIBLE_MEMBERSHIP',
      'INELIGIBLE_PROVIDER_LIMIT',
    ]);
    expect(err2?.details?.failedGateCodes).toEqual([
      'COUNTRY_POLICY',
      'MEMBERSHIP',
      'PROVIDER_LIMIT',
    ]);
  });

  it('input order independence for mixed pass/fail same outcome class', () => {
    // Only one failure class — order of other pass gates must not matter.
    const base: EligibilityGateFact[] = [
      passFact('ACCOUNT_STATE'),
      failFact('RISK_POLICY', 'RISK_POLICY_BLOCKED'),
      passFact('FEATURE_FLAG'),
      passFact('MEMBERSHIP'),
    ];
    const reverse = [...base].reverse();
    const shuffle = [base[2]!, base[0]!, base[3]!, base[1]!];
    const a = evaluateEligibilityGates(POLICY, base);
    const b = evaluateEligibilityGates(POLICY, reverse);
    const c = evaluateEligibilityGates(POLICY, shuffle);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.outcome).toBe('INELIGIBLE_RISK_POLICY');
    expect(a.reasonCodes).toEqual(['RISK_POLICY_BLOCKED']);
  });

  it('duplicate gate code fails closed (no last-write-wins)', () => {
    expect(() =>
      evaluateEligibilityGates(POLICY, [
        passFact('ACCOUNT_STATE'),
        failFact('ACCOUNT_STATE', 'ACCOUNT_STATE_DUP'),
      ]),
    ).toThrowError(
      expect.objectContaining({ code: 'ELIGIBILITY_GATE_DUPLICATE' }),
    );
  });

  it('rejects malformed facts fail-closed', () => {
    expect(() =>
      evaluateEligibilityGates(POLICY, [
        { code: 'NOT_A_GATE' as never, eligible: true, reasonCode: 'OK' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ELIGIBILITY_GATE_INVALID' }));

    expect(() =>
      evaluateEligibilityGates(POLICY, [
        { code: 'ACCOUNT_STATE', eligible: 'yes' as never, reasonCode: 'OK' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ELIGIBILITY_GATE_INVALID' }));

    expect(() =>
      evaluateEligibilityGates(POLICY, [
        { code: 'ACCOUNT_STATE', eligible: true, reasonCode: 'bad-code' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'ELIGIBILITY_GATE_INVALID' }));

    expect(() =>
      evaluateEligibilityGates(POLICY, [
        {
          code: 'ACCOUNT_STATE',
          eligible: true,
          reasonCode: 'OK',
          safeDetails: { access_token: 'nope' },
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'RISK_SNAPSHOT_INVALID' }));

    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() =>
      evaluateEligibilityGates(POLICY, [
        {
          code: 'ACCOUNT_STATE',
          eligible: true,
          reasonCode: 'OK',
          safeDetails: cyclic,
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'RISK_SNAPSHOT_INVALID' }));
  });

  it('EligibilityGateFact type/source has no caller outcome or precedence authority', () => {
    const path = fileURLToPath(new URL('../src/eligibility-evaluator.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const iface = source.slice(
      source.indexOf('export interface EligibilityGateFact'),
      source.indexOf('export interface EligibilityGateStateEntry'),
    );
    expect(iface).not.toMatch(/\boutcome\b/);
    expect(iface).not.toMatch(/blockedOutcome/);
    expect(iface).not.toMatch(/priority/);
    expect(iface).not.toMatch(/precedence/);
    expect(iface).not.toMatch(/\bweight\b/);
    expect(iface).not.toMatch(/\bscore\b/);
    expect(iface).not.toMatch(/bypass/);
    expect(iface).not.toMatch(/override/);
  });

  it('evaluator source is pure — no DB / collectors / trust / membership / money', () => {
    const path = fileURLToPath(new URL('../src/eligibility-evaluator.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toMatch(/PoolClient/);
    expect(source).not.toMatch(/client\.query/);
    expect(source).not.toMatch(/\busers\b/);
    expect(source).not.toMatch(/risk_profiles/);
    expect(source).not.toMatch(/trust_snapshots/);
    expect(source).not.toMatch(/user_memberships/);
    expect(source).not.toMatch(/provider_limit_rules/);
    expect(source).not.toMatch(/provider_country_rules/);
    expect(source).not.toMatch(/feature_flags/);
    expect(source).not.toMatch(/network_signals/);
    expect(source).not.toMatch(/persistEligibilityDecision/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/evaluateAndPersistEligibility/);
    expect(source).not.toMatch(/TRUST_STATE/);
    expect(source).not.toMatch(/ledger/);
  });

  it('exports evaluateEligibilityGates without authoritative caller-fact persist path', async () => {
    const mod = await import('../src/index.js');
    expect(Object.keys(mod)).toContain('evaluateEligibilityGates');
    expect(Object.keys(mod)).toContain('ELIGIBILITY_GATE_CODES');
    expect(Object.keys(mod)).not.toContain('evaluateAndPersistEligibility');
  });

  it('binds supplied policyVersion and never invents policy 1', () => {
    const result = evaluateEligibilityGates({ policyVersion: 42 }, [
      passFact('FEATURE_FLAG'),
    ]);
    expect(result.policyVersion).toBe(42);
    expect(result.outcome).toBe('ELIGIBLE');
  });
});
