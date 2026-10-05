import { describe, expect, it } from 'vitest';

import { parseReferralStartParam, REFERRAL_START_PREFIX } from '../src/index.js';

describe('parseReferralStartParam', () => {
  it('returns NONE for null/empty/unrelated payloads', () => {
    expect(parseReferralStartParam(null)).toEqual({ kind: 'NONE' });
    expect(parseReferralStartParam(undefined)).toEqual({ kind: 'NONE' });
    expect(parseReferralStartParam('')).toEqual({ kind: 'NONE' });
    expect(parseReferralStartParam('campaign_x')).toEqual({ kind: 'NONE' });
    expect(parseReferralStartParam('foo')).toEqual({ kind: 'NONE' });
    expect(parseReferralStartParam('abc')).toEqual({ kind: 'NONE' });
    expect(parseReferralStartParam('Ref_ABC')).toEqual({ kind: 'NONE' });
  });

  it('returns INVALID for empty code after exact ref_ prefix', () => {
    expect(parseReferralStartParam('ref_')).toEqual({
      kind: 'INVALID_REFERRAL_START_PARAM',
    });
    expect(REFERRAL_START_PREFIX).toBe('ref_');
  });

  it('returns exact opaque code with no case normalization', () => {
    expect(parseReferralStartParam('ref_ABC123')).toEqual({
      kind: 'REFERRAL_CODE',
      code: 'ABC123',
    });
    expect(parseReferralStartParam('ref_abc123')).toEqual({
      kind: 'REFERRAL_CODE',
      code: 'abc123',
    });
    expect(parseReferralStartParam('ref_TEST123')).toEqual({
      kind: 'REFERRAL_CODE',
      code: 'TEST123',
    });
  });
});
