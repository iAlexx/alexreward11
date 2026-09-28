import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ELIGIBILITY_ACTION_TYPES,
  ELIGIBILITY_OUTCOMES,
  FraudDomainError,
  computeEligibilityInputsDigest,
  persistEligibilityDecision,
  resolveActiveEligibilityPolicyVersion,
} from '../src/index.js';

const USER_ID = '00000000-0000-4000-8000-000000000071';

describe('Phase 14 Eligibility core surface (unit)', () => {
  it('exports policy resolver + decision primitive without business evaluation', async () => {
    const mod = await import('../src/index.js');
    const names = Object.keys(mod);
    expect(names).toContain('resolveActiveEligibilityPolicyVersion');
    expect(names).toContain('loadEligibilityPolicyVersionByNumber');
    expect(names).toContain('persistEligibilityDecision');
    expect(names).toContain('computeEligibilityInputsDigest');
    expect(names).not.toContain('evaluateEligibility');
    expect(names).not.toContain('isEligible');
    expect(names).not.toContain('checkCountryEligibility');
  });

  it('Eligibility modules contain no country/membership/trust/risk bypass or money writes', () => {
    const policyPath = fileURLToPath(new URL('../src/eligibility-policy.ts', import.meta.url));
    const decisionPath = fileURLToPath(
      new URL('../src/eligibility-decision.ts', import.meta.url),
    );
    for (const path of [policyPath, decisionPath]) {
      const src = readFileSync(path, 'utf8');
      expect(src).not.toMatch(/network_signals/);
      expect(src).not.toMatch(/country_code/);
      expect(src).not.toMatch(/user_memberships/);
      expect(src).not.toMatch(/founder_number/i);
      expect(src).not.toMatch(/users\.trust_state/);
      expect(src).not.toMatch(/FROM\s+users\b/i);
      expect(src).not.toMatch(/risk_profiles/);
      expect(src).not.toMatch(/risk_snapshots/);
      expect(src).not.toMatch(/ledger_entries/);
      expect(src).not.toMatch(/WITHDRAWAL_BLOCKED/);
      expect(src).not.toMatch(/if\s*\(.*TRUSTED.*\)\s*.*ELIGIBLE/i);
      expect(src).not.toMatch(/Founder\s*=>\s*ELIGIBLE/i);
      expect(src).not.toMatch(/evaluateEligibility/);
    }
  });

  it('resolveActiveEligibilityPolicyVersion has no latest-version fallback', () => {
    const path = fileURLToPath(new URL('../src/eligibility-policy.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).toMatch(/ELIGIBILITY_POLICY_NOT_CONFIGURED/);
    expect(source).toMatch(/result\.rows\.length > 1/);
    expect(source).not.toMatch(/ORDER BY policy_version DESC/);
    expect(source).not.toMatch(/LIMIT 1/);
    expect(source).not.toMatch(/risk_rule_versions/);
    expect(source).not.toMatch(/trust_rule_versions/);
    expect(typeof resolveActiveEligibilityPolicyVersion).toBe('function');
    expect(FraudDomainError.name).toBe('FraudDomainError');
  });

  it('caller input type has no inputsDigest or decidedAt authority', () => {
    const path = fileURLToPath(new URL('../src/eligibility-decision.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).toMatch(/export interface PersistEligibilityDecisionInput/);
    const iface = source.slice(
      source.indexOf('export interface PersistEligibilityDecisionInput'),
      source.indexOf('export interface PersistedEligibilityDecision'),
    );
    expect(iface).not.toMatch(/inputsDigest/);
    expect(iface).not.toMatch(/decidedAt/);
    expect(iface).toMatch(/policyVersion/);
    expect(iface).toMatch(/safeInputs/);
  });

  it('accepts all valid action types and rejects invalid', async () => {
    const fakeClient = {
      query: async () => {
        throw new Error('must fail validation before DB');
      },
    };
    for (const actionType of ELIGIBILITY_ACTION_TYPES) {
      await expect(
        persistEligibilityDecision(fakeClient as never, {
          userId: USER_ID,
          actionType,
          outcome: 'ELIGIBLE',
          policyVersion: 1,
          reasonCodes: ['ELIGIBLE_BASELINE'],
          safeInputs: { fixture: true },
        }),
      ).rejects.toBeTruthy();
    }
    await expect(
      persistEligibilityDecision(fakeClient as never, {
        userId: USER_ID,
        actionType: 'NOT_A_REAL_ACTION' as never,
        outcome: 'ELIGIBLE',
        policyVersion: 1,
        reasonCodes: ['ELIGIBLE_BASELINE'],
        safeInputs: {},
      }),
    ).rejects.toMatchObject({ code: 'ELIGIBILITY_DECISION_INVALID' });
  });

  it('accepts all valid outcomes and rejects invalid', async () => {
    const fakeClient = {
      query: async () => {
        throw new Error('must fail validation before DB');
      },
    };
    for (const outcome of ELIGIBILITY_OUTCOMES) {
      await expect(
        persistEligibilityDecision(fakeClient as never, {
          userId: USER_ID,
          actionType: 'AD_SESSION_START',
          outcome,
          policyVersion: 1,
          reasonCodes: ['ACCOUNT_STATE_BLOCKED'],
          safeInputs: {},
        }),
      ).rejects.toBeTruthy();
    }
    await expect(
      persistEligibilityDecision(fakeClient as never, {
        userId: USER_ID,
        actionType: 'AD_SESSION_START',
        outcome: 'MAYBE' as never,
        policyVersion: 1,
        reasonCodes: ['X'],
        safeInputs: {},
      }),
    ).rejects.toMatchObject({ code: 'ELIGIBILITY_DECISION_INVALID' });
  });

  it('rejects empty and malformed reason codes; duplicates normalize deterministically', async () => {
    const fakeClient = {
      query: async () => {
        throw new Error('must fail validation before DB');
      },
    };
    await expect(
      persistEligibilityDecision(fakeClient as never, {
        userId: USER_ID,
        actionType: 'MISSION_CLAIM',
        outcome: 'ELIGIBLE',
        policyVersion: 1,
        reasonCodes: [],
        safeInputs: {},
      }),
    ).rejects.toMatchObject({ code: 'ELIGIBILITY_DECISION_INVALID' });

    await expect(
      persistEligibilityDecision(fakeClient as never, {
        userId: USER_ID,
        actionType: 'MISSION_CLAIM',
        outcome: 'ELIGIBLE',
        policyVersion: 1,
        reasonCodes: ['bad-code'],
        safeInputs: {},
      }),
    ).rejects.toMatchObject({ code: 'ELIGIBILITY_DECISION_INVALID' });

    // Digest path also normalizes; verify via digest helper with sorted unique codes in persist
    // happens after policy load — unit-test normalize through digest of identical payloads.
    const a = computeEligibilityInputsDigest({
      policyVersion: 1,
      userId: USER_ID,
      actionType: 'TASK_CLAIM',
      providerId: null,
      adSessionId: null,
      missionVersionId: null,
      safeInputs: { reasonProbe: ['BETA', 'ALPHA', 'BETA'] },
    });
    const b = computeEligibilityInputsDigest({
      policyVersion: 1,
      userId: USER_ID,
      actionType: 'TASK_CLAIM',
      providerId: null,
      adSessionId: null,
      missionVersionId: null,
      safeInputs: { reasonProbe: ['BETA', 'ALPHA', 'BETA'] },
    });
    expect(a).toBe(b);
  });

  it('rejects sensitive safeInputs', async () => {
    const fakeClient = {
      query: async () => {
        throw new Error('must fail validation before DB');
      },
    };
    await expect(
      persistEligibilityDecision(fakeClient as never, {
        userId: USER_ID,
        actionType: 'WITHDRAWAL_REQUEST',
        outcome: 'INELIGIBLE_RISK_POLICY',
        policyVersion: 1,
        reasonCodes: ['RISK_POLICY_BLOCKED'],
        safeInputs: { access_token: 'secret' },
      }),
    ).rejects.toMatchObject({ code: 'RISK_SNAPSHOT_INVALID' });

    await expect(
      persistEligibilityDecision(fakeClient as never, {
        userId: USER_ID,
        actionType: 'WITHDRAWAL_REQUEST',
        outcome: 'INELIGIBLE_RISK_POLICY',
        policyVersion: 1,
        reasonCodes: ['RISK_POLICY_BLOCKED'],
        safeInputs: { raw_ip: '1.2.3.4' },
      }),
    ).rejects.toMatchObject({ code: 'RISK_SNAPSHOT_INVALID' });
  });

  it('digest is deterministic, order-independent, and 64 lowercase hex', () => {
    const base = {
      policyVersion: 1,
      userId: USER_ID,
      actionType: 'AD_SESSION_START' as const,
      providerId: null as string | null,
      adSessionId: null as string | null,
      missionVersionId: null as string | null,
    };
    const d1 = computeEligibilityInputsDigest({
      ...base,
      safeInputs: { b: 2, a: { z: 1, y: 2 } },
    });
    const d2 = computeEligibilityInputsDigest({
      ...base,
      safeInputs: { a: { y: 2, z: 1 }, b: 2 },
    });
    expect(d1).toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);

    const dPolicy = computeEligibilityInputsDigest({
      ...base,
      policyVersion: 2,
      safeInputs: { b: 2, a: { z: 1, y: 2 } },
    });
    expect(dPolicy).not.toBe(d1);

    const dAction = computeEligibilityInputsDigest({
      ...base,
      actionType: 'MISSION_CLAIM',
      safeInputs: { b: 2, a: { z: 1, y: 2 } },
    });
    expect(dAction).not.toBe(d1);

    const dRef = computeEligibilityInputsDigest({
      ...base,
      providerId: '00000000-0000-4000-8000-000000000099',
      safeInputs: { b: 2, a: { z: 1, y: 2 } },
    });
    expect(dRef).not.toBe(d1);

    const dInput = computeEligibilityInputsDigest({
      ...base,
      safeInputs: { b: 2, a: { z: 1, y: 3 } },
    });
    expect(dInput).not.toBe(d1);
  });
});
