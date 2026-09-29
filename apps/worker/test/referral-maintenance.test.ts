import { describe, expect, it } from 'vitest';

import {
  createReferralMaintenancePoller,
  mapDeploymentEnvToRewardEnvironment,
  startReferralMaintenanceLoop,
} from '../src/referral-maintenance.js';

describe('referral maintenance env mapping', () => {
  it('maps local/staging/production exhaustively', () => {
    expect(mapDeploymentEnvToRewardEnvironment('local')).toBe('LOCAL');
    expect(mapDeploymentEnvToRewardEnvironment('staging')).toBe('STAGING');
    expect(mapDeploymentEnvToRewardEnvironment('production')).toBe('PRODUCTION');
  });

  it('fails closed for unknown / test (no LOCAL default)', () => {
    expect(() => mapDeploymentEnvToRewardEnvironment('test')).toThrow(
      /REFERRAL_MAINTENANCE_ENV_UNMAPPED/,
    );
    expect(() => mapDeploymentEnvToRewardEnvironment('dev')).toThrow(
      /REFERRAL_MAINTENANCE_ENV_UNMAPPED/,
    );
  });

  it('in-flight guard skips overlapping polls', async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const poll = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      runs += 1;
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
    };
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const timer = startReferralMaintenanceLoop({
      enabled: true,
      intervalMs: 10,
      poll,
      onError: () => undefined,
      schedule: (cb, ms) => {
        const id = setInterval(cb, ms);
        timers.push(id);
        return id;
      },
    });
    expect(timer).toBeDefined();
    await new Promise((r) => setTimeout(r, 80));
    for (const id of timers) clearInterval(id);
    expect(maxActive).toBe(1);
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  it('poller order is activation → issuance → maturity', async () => {
    const order: string[] = [];
    const poll = createReferralMaintenancePoller({
      processActivation: async () => {
        order.push('activation');
      },
      processIssuance: async () => {
        order.push('issuance');
      },
      processMaturity: async () => {
        order.push('maturity');
      },
    });
    await poll();
    expect(order).toEqual(['activation', 'issuance', 'maturity']);
  });
});
