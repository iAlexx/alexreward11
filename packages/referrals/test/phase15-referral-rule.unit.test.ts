import { describe, expect, it } from 'vitest';

import {
  ReferralDomainError,
  mapReferralRuleRow,
  resolveActiveReferralRuleVersion,
} from '../src/index.js';

describe('Phase 15 referral rule resolver (unit)', () => {
  it('mapReferralRuleRow rejects invalid status / ranges', () => {
    expect(() =>
      mapReferralRuleRow({
        id: '00000000-0000-4000-8000-000000000001',
        rule_version: 1,
        activation_account_age_seconds: 0,
        activation_valid_ad_count: 0,
        base_rate_bps: 123,
        status: 'BOGUS',
        effective_from: new Date(),
        effective_to: null,
        reason: null,
        source_reference: null,
      }),
    ).toThrow(ReferralDomainError);

    try {
      mapReferralRuleRow({
        id: '00000000-0000-4000-8000-000000000001',
        rule_version: 1,
        activation_account_age_seconds: -1,
        activation_valid_ad_count: 0,
        base_rate_bps: 123,
        status: 'ACTIVE',
        effective_from: new Date(),
        effective_to: null,
        reason: null,
        source_reference: null,
      });
      expect.fail('expected throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'REFERRAL_RULE_INVALID' });
    }
  });

  it('documents fail-closed codes for zero / ambiguous ACTIVE matches', () => {
    expect(new ReferralDomainError('REFERRAL_RULE_NOT_CONFIGURED', 'none').code).toBe(
      'REFERRAL_RULE_NOT_CONFIGURED',
    );
    expect(new ReferralDomainError('REFERRAL_RULE_AMBIGUOUS', 'many').code).toBe(
      'REFERRAL_RULE_AMBIGUOUS',
    );
    expect(typeof resolveActiveReferralRuleVersion).toBe('function');
  });
});
