import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  FraudDomainError,
  persistTrustSnapshot,
  resolveActiveTrustRuleVersion,
} from '../src/index.js';

describe('Phase 14 Trust core surface (unit)', () => {
  it('exports Trust rule resolver + snapshot primitive without scoring policy', async () => {
    const mod = await import('../src/index.js');
    const names = Object.keys(mod);
    expect(names).toContain('resolveActiveTrustRuleVersion');
    expect(names).toContain('loadTrustRuleVersionByNumber');
    expect(names).toContain('persistTrustSnapshot');
    expect(names).not.toContain('evaluateTrust');
    expect(names).not.toContain('calculateTrustScore');
    expect(names).not.toContain('setUserTrustState');
    expect(names).not.toContain('grantTrustedFromFounder');
    expect(names).not.toContain('grantTrustedFromMembership');
  });

  it('Trust modules contain no Founder/membership => TRUSTED or Risk override logic', () => {
    const trustRulePath = fileURLToPath(new URL('../src/trust-rule.ts', import.meta.url));
    const trustSnapPath = fileURLToPath(new URL('../src/trust-snapshot.ts', import.meta.url));
    const ruleSrc = readFileSync(trustRulePath, 'utf8');
    const snapSrc = readFileSync(trustSnapPath, 'utf8');
    for (const src of [ruleSrc, snapSrc]) {
      expect(src).not.toMatch(/user_memberships/);
      expect(src).not.toMatch(/membership_plan/);
      expect(src).not.toMatch(/founder_number/i);
      expect(src).not.toMatch(/UPDATE\s+users\b/i);
      expect(src).not.toMatch(/FROM\s+users\b/i);
      expect(src).not.toMatch(/ignore.*CRITICAL/i);
      expect(src).not.toMatch(/override.*risk/i);
      expect(src).not.toMatch(/auto.?payout/i);
      expect(src).not.toMatch(/risk_profiles/);
      expect(src).not.toMatch(/risk_snapshots/);
    }
  });

  it('Trust snapshot primitive rejects invalid score/state without DB', async () => {
    const fakeClient = {
      query: async () => {
        throw new Error('must fail validation before DB');
      },
    };
    await expect(
      persistTrustSnapshot(fakeClient as never, {
        userId: '00000000-0000-4000-8000-000000000001',
        trustState: 'TRUSTED',
        trustScore: 101,
        ruleVersion: 1,
        reasonCodes: ['TEST'],
        signals: {},
      }),
    ).rejects.toMatchObject({ code: 'TRUST_SNAPSHOT_INVALID' });

    await expect(
      persistTrustSnapshot(fakeClient as never, {
        userId: '00000000-0000-4000-8000-000000000001',
        trustState: 'CRITICAL' as never,
        trustScore: 10,
        ruleVersion: 1,
        reasonCodes: ['TEST'],
        signals: {},
      }),
    ).rejects.toMatchObject({ code: 'TRUST_SNAPSHOT_INVALID' });

    await expect(
      persistTrustSnapshot(fakeClient as never, {
        userId: '00000000-0000-4000-8000-000000000001',
        trustState: 'NEW',
        trustScore: 1.5 as never,
        ruleVersion: 1,
        reasonCodes: ['TEST'],
        signals: {},
      }),
    ).rejects.toMatchObject({ code: 'TRUST_SNAPSHOT_INVALID' });
  });

  it('resolveActiveTrustRuleVersion has no latest-version fallback in source', () => {
    const path = fileURLToPath(new URL('../src/trust-rule.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).toMatch(/TRUST_RULE_NOT_CONFIGURED/);
    expect(source).toMatch(/result\.rows\.length > 1/);
    expect(source).not.toMatch(/ORDER BY rule_version DESC/);
    expect(source).not.toMatch(/LIMIT 1/);
    expect(source).not.toMatch(/risk_rule_versions/);
    expect(source).not.toMatch(/FROM\s+users\b/i);
    expect(typeof resolveActiveTrustRuleVersion).toBe('function');
    expect(FraudDomainError.name).toBe('FraudDomainError');
  });
});
