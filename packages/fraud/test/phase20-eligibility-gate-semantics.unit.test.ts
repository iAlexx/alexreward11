import { describe, expect, it } from 'vitest';

import {
  classifyAccountStateForAction,
  resolveEligibilityFeatureFlagBinding,
} from '../src/eligibility-gate-semantics.js';

describe('eligibility ACCOUNT_STATE action-aware semantics', () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const future = new Date('2026-10-02T12:00:00.000Z');

  it('inactive account is refused for AD_SESSION_START and WITHDRAWAL_REQUEST', () => {
    for (const actionType of ['AD_SESSION_START', 'WITHDRAWAL_REQUEST'] as const) {
      const c = classifyAccountStateForAction(actionType, {
        status: 'SUSPENDED',
        withdrawalStatus: 'ALLOWED',
        withdrawalCooldownUntil: null,
        now,
      });
      expect(c.eligible).toBe(false);
      expect(c.stateClass).toBe('NON_ACTIVE');
      expect(c.reasonCode).toBe('ACCOUNT_STATE_NOT_ACTIVE');
    }
  });

  it('wallet-change cooldown refuses WITHDRAWAL_REQUEST only', () => {
    const snap = {
      status: 'ACTIVE',
      withdrawalStatus: 'ALLOWED',
      withdrawalCooldownUntil: future,
      now,
    } as const;
    const wd = classifyAccountStateForAction('WITHDRAWAL_REQUEST', snap);
    expect(wd.eligible).toBe(false);
    expect(wd.stateClass).toBe('COOLDOWN');
    expect(wd.withdrawalScopedChecksApplied).toBe(true);

    for (const actionType of [
      'AD_SESSION_START',
      'MISSION_CLAIM',
      'TASK_CLAIM',
      'REFERRAL_ACTIVATION',
      'MEMBERSHIP_CLAIM',
    ] as const) {
      const other = classifyAccountStateForAction(actionType, snap);
      expect(other.eligible).toBe(true);
      expect(other.stateClass).toBe('ACTIVE_ALLOWED');
      expect(other.withdrawalScopedChecksApplied).toBe(false);
      expect(other.cooldownActive).toBe(true);
    }
  });

  it('withdrawal_status BLOCKED refuses WITHDRAWAL_REQUEST only', () => {
    const snap = {
      status: 'ACTIVE',
      withdrawalStatus: 'BLOCKED',
      withdrawalCooldownUntil: null,
      now,
    } as const;
    expect(classifyAccountStateForAction('WITHDRAWAL_REQUEST', snap).eligible).toBe(false);
    expect(classifyAccountStateForAction('WITHDRAWAL_REQUEST', snap).stateClass).toBe('BLOCKED');
    expect(classifyAccountStateForAction('AD_SESSION_START', snap).eligible).toBe(true);
    expect(classifyAccountStateForAction('AD_SESSION_START', snap).reasonCode).toBe(
      'ACCOUNT_STATE_OK',
    );
  });

  it('ACTIVE normal user passes ACCOUNT_STATE for both paths', () => {
    const snap = {
      status: 'ACTIVE',
      withdrawalStatus: 'ALLOWED',
      withdrawalCooldownUntil: null,
      now,
    } as const;
    expect(classifyAccountStateForAction('WITHDRAWAL_REQUEST', snap).eligible).toBe(true);
    expect(classifyAccountStateForAction('AD_SESSION_START', snap).eligible).toBe(true);
  });

  it('Founder membership cannot alter ACCOUNT_STATE classifier inputs', () => {
    expect(classifyAccountStateForAction.length).toBe(2);
    expect(classifyAccountStateForAction.toString()).not.toMatch(/founder|membership/i);
  });
});

describe('eligibility FEATURE_FLAG action bindings', () => {
  it('WITHDRAWAL_REQUEST binds only WITHDRAWAL_REQUESTS_PAUSE', () => {
    expect(resolveEligibilityFeatureFlagBinding('WITHDRAWAL_REQUEST')).toEqual({
      kind: 'pause_flag',
      flagKey: 'WITHDRAWAL_REQUESTS_PAUSE',
    });
  });

  it('MISSION_CLAIM binds mission reward pause path', () => {
    expect(resolveEligibilityFeatureFlagBinding('MISSION_CLAIM')).toEqual({
      kind: 'mission_reward_pause',
    });
  });

  it('REFERRAL_ACTIVATION is unsupported (REFERRAL_REWARD_PAUSE is reward issuance, not activation)', () => {
    expect(resolveEligibilityFeatureFlagBinding('REFERRAL_ACTIVATION')).toEqual({
      kind: 'unsupported',
    });
    expect(JSON.stringify(resolveEligibilityFeatureFlagBinding('REFERRAL_ACTIVATION'))).not.toMatch(
      /REFERRAL_REWARD_PAUSE|WITHDRAWAL_REQUESTS_PAUSE/,
    );
  });

  it('AD_SESSION_START / TASK_CLAIM / MEMBERSHIP_CLAIM / REFERRAL_ACTIVATION are unsupported (no unrelated pause fallback)', () => {
    for (const actionType of [
      'AD_SESSION_START',
      'TASK_CLAIM',
      'MEMBERSHIP_CLAIM',
      'REFERRAL_ACTIVATION',
    ] as const) {
      expect(resolveEligibilityFeatureFlagBinding(actionType)).toEqual({
        kind: 'unsupported',
      });
    }
  });
});