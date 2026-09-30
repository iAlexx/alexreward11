import { describe, expect, it } from 'vitest';

import {
  mapDeploymentEnvToFeatureEnvironment,
  parsePublicPayoutLogsEnabledFlag,
} from '../src/public-payout-feature.js';
import {
  buildExplorerUrl,
  formatAtomicAmount,
  formatConfirmedUtcDate,
} from '../src/public-payout-format.js';
import { renderPublicPayoutMessage } from '../src/public-payout-render.js';
import { sanitizePublicPayoutUsernameSnapshot } from '../src/public-payout-username.js';
import { WithdrawalDomainError } from '../src/errors.js';

describe('Phase17 public payout helpers', () => {
  it('parsePublicPayoutLogsEnabledFlag fails closed', () => {
    expect(parsePublicPayoutLogsEnabledFlag(undefined)).toBe(false);
    expect(parsePublicPayoutLogsEnabledFlag(null)).toBe(false);
    expect(parsePublicPayoutLogsEnabledFlag('')).toBe(false);
    expect(parsePublicPayoutLogsEnabledFlag('false')).toBe(false);
    expect(parsePublicPayoutLogsEnabledFlag('true')).toBe(true);
    expect(parsePublicPayoutLogsEnabledFlag(true)).toBe(true);
  });

  it('mapDeploymentEnvToFeatureEnvironment maps known envs', () => {
    expect(mapDeploymentEnvToFeatureEnvironment('local')).toBe('LOCAL');
    expect(mapDeploymentEnvToFeatureEnvironment('test')).toBe('LOCAL');
    expect(mapDeploymentEnvToFeatureEnvironment('staging')).toBe('STAGING');
    expect(mapDeploymentEnvToFeatureEnvironment('production')).toBe('PRODUCTION');
    expect(() => mapDeploymentEnvToFeatureEnvironment('dev')).toThrow(WithdrawalDomainError);
  });

  it('sanitizePublicPayoutUsernameSnapshot strips @ and rejects invalid', () => {
    expect(sanitizePublicPayoutUsernameSnapshot('@Valid_User1')).toBe('Valid_User1');
    expect(sanitizePublicPayoutUsernameSnapshot('ab')).toBeNull();
    expect(sanitizePublicPayoutUsernameSnapshot('1badstart')).toBeNull();
    expect(sanitizePublicPayoutUsernameSnapshot('has space')).toBeNull();
    expect(sanitizePublicPayoutUsernameSnapshot(null)).toBeNull();
  });

  it('formatAtomicAmount uses bigint only', () => {
    expect(formatAtomicAmount('1900000', 6)).toBe('1.900000');
    expect(formatAtomicAmount('1', 6)).toBe('0.000001');
    expect(formatAtomicAmount('1000000', 0)).toBe('1000000');
  });

  it('buildExplorerUrl requires https and joins safely', () => {
    expect(buildExplorerUrl('https://tonviewer.com/', 'abc123')).toBe(
      'https://tonviewer.com/abc123',
    );
    expect(buildExplorerUrl('https://tonviewer.com', 'abc123')).toBe(
      'https://tonviewer.com/abc123',
    );
    expect(() => buildExplorerUrl('http://tonviewer.com/', 'abc')).toThrow(/https/i);
  });

  it('formatConfirmedUtcDate returns YYYY-MM-DD UTC', () => {
    expect(formatConfirmedUtcDate(new Date('2026-09-30T23:15:00.000Z'))).toBe('2026-09-30');
  });

  it('renderPublicPayoutMessage hides or shows username', () => {
    const hidden = renderPublicPayoutMessage({
      identityMode: 'HIDE_IDENTITY',
      usernameSnapshot: null,
      amountFormatted: '1.900000',
      assetSymbol: 'USDT',
      networkLabel: 'TON',
      publicId: 'WD-000001',
      confirmedDateUtc: '2026-09-30',
    });
    expect(hidden).toContain('User: Anonymous User');
    expect(hidden).not.toContain('@');

    const shown = renderPublicPayoutMessage({
      identityMode: 'SHOW_USERNAME',
      usernameSnapshot: 'Alice',
      amountFormatted: '1.900000',
      assetSymbol: 'USDT',
      networkLabel: 'TON',
      publicId: 'WD-000001',
      confirmedDateUtc: '2026-09-30',
    });
    expect(shown).toContain('User: @Alice');
    expect(shown).not.toContain('http');
  });
});
