import { describe, expect, it } from 'vitest';

import {
  resolveMissionBonusDailyLimits,
  validatePinnedRewardRuleLifecycle,
} from '../src/issue-mission.js';

describe('Phase 16 mission remediation (unit)', () => {
  it('resolveMissionBonusDailyLimits enforces global + mission-scoped limits together', () => {
    const resolved = resolveMissionBonusDailyLimits(
      [
        {
          id: 'global',
          limit_atomic: '1000',
          scope_reference_id: null,
          country_group: null,
        },
        {
          id: 'mission',
          limit_atomic: '500',
          scope_reference_id: 'mv-1',
          country_group: null,
        },
      ],
      'mv-1',
    );
    expect(resolved).toEqual({
      kind: 'ok',
      limits: [
        { id: 'global', limit_atomic: '1000' },
        { id: 'mission', limit_atomic: '500' },
      ],
    });
  });

  it('resolveMissionBonusDailyLimits fails closed on duplicate scopes', () => {
    expect(
      resolveMissionBonusDailyLimits(
        [
          { id: 'g1', limit_atomic: '1', scope_reference_id: null, country_group: null },
          { id: 'g2', limit_atomic: '2', scope_reference_id: null, country_group: null },
        ],
        'mv-1',
      ).kind,
    ).toBe('ambiguous');
  });

  it('validatePinnedRewardRuleLifecycle allows SUPERSEDED rules inside valid_to window', () => {
    const claimedAt = new Date('2026-06-15T12:00:00.000Z');
    expect(
      validatePinnedRewardRuleLifecycle(
        {
          status: 'SUPERSEDED',
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          valid_to: new Date('2026-12-31T00:00:00.000Z'),
        },
        claimedAt,
      ),
    ).toBe('ok');
  });

  it('validatePinnedRewardRuleLifecycle rejects DRAFT pinned rules', () => {
    expect(
      validatePinnedRewardRuleLifecycle(
        {
          status: 'DRAFT',
          valid_from: new Date('2026-01-01T00:00:00.000Z'),
          valid_to: null,
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe('DRAFT');
  });
});
