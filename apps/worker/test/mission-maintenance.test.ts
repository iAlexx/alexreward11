/**
 * Worker mission maintenance loop unit coverage.
 */
import { describe, expect, it } from 'vitest';

import {
  createMissionMaintenancePoller,
  startMissionMaintenanceLoop,
} from '../src/mission-maintenance.js';
import { mapDeploymentEnvToRewardEnvironment } from '../src/referral-maintenance.js';

describe('mission maintenance loop', () => {
  it('maps deployment env exhaustively and fails closed on unknown', () => {
    expect(mapDeploymentEnvToRewardEnvironment('local')).toBe('LOCAL');
    expect(mapDeploymentEnvToRewardEnvironment('staging')).toBe('STAGING');
    expect(mapDeploymentEnvToRewardEnvironment('production')).toBe('PRODUCTION');
    expect(() => mapDeploymentEnvToRewardEnvironment('weird')).toThrow(
      /REFERRAL_MAINTENANCE_ENV_UNMAPPED/,
    );
    expect(() => mapDeploymentEnvToRewardEnvironment('test')).toThrow(
      /REFERRAL_MAINTENANCE_ENV_UNMAPPED/,
    );
  });

  it('runs progress producers before monetary claim/maturity', async () => {
    const order: string[] = [];
    const poll = createMissionMaintenancePoller({
      processDailyLogin: async () => {
        order.push('daily');
      },
      processValidAd: async () => {
        order.push('ad');
      },
      processStreak: async () => {
        order.push('streak');
      },
      processPendingClaims: async () => {
        order.push('claims');
      },
      processMaturity: async () => {
        order.push('maturity');
      },
    });
    await poll();
    expect(order).toEqual(['daily', 'ad', 'streak', 'claims', 'maturity']);
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
    const timers: Array<ReturnType<typeof setInterval>> = [];
    const timer = startMissionMaintenanceLoop({
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
});
