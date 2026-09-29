import { describe, expect, it } from 'vitest';

import { isPublicPayoutLogsEnabled } from '../src/public-payout-feature.js';
import { sanitizePublicPayoutUsernameSnapshot } from '../src/public-payout-username.js';

describe('Phase17 public payout helpers', () => {
  it('isPublicPayoutLogsEnabled fails closed', () => {
    expect(isPublicPayoutLogsEnabled(undefined)).toBe(false);
    expect(isPublicPayoutLogsEnabled(null)).toBe(false);
    expect(isPublicPayoutLogsEnabled('')).toBe(false);
    expect(isPublicPayoutLogsEnabled('false')).toBe(false);
    expect(isPublicPayoutLogsEnabled('true')).toBe(true);
    expect(isPublicPayoutLogsEnabled(true)).toBe(true);
  });

  it('sanitizePublicPayoutUsernameSnapshot strips @ and rejects invalid', () => {
    expect(sanitizePublicPayoutUsernameSnapshot('@Valid_User1')).toBe('Valid_User1');
    expect(sanitizePublicPayoutUsernameSnapshot('ab')).toBeNull();
    expect(sanitizePublicPayoutUsernameSnapshot('1badstart')).toBeNull();
    expect(sanitizePublicPayoutUsernameSnapshot('has space')).toBeNull();
    expect(sanitizePublicPayoutUsernameSnapshot(null)).toBeNull();
  });
});