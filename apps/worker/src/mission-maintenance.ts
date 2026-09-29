/**
 * Mission maintenance loop (progress producers → claim reward → maturity).
 * In-flight guarded; DEPLOYMENT_ENV mapped exhaustively (unknown = fail closed).
 */
import type { Pool } from 'pg';

import {
  processDailyLoginMissionContributionsBatch,
  processStreakMissionContributionsBatch,
  processValidAdMissionContributionsBatch,
} from '@alex-rewards/tasks';
import {
  processDueMissionRewardMaturityBatch,
  processPendingMissionRewardClaimsBatch,
  type EnvironmentName,
} from '@alex-rewards/rewards';

import { mapDeploymentEnvToRewardEnvironment, type DeploymentEnvName } from './referral-maintenance.js';

const DEFAULT_BATCH_LIMIT = 50;

export function createMissionMaintenancePoller(
  handlers: {
    readonly processDailyLogin: () => Promise<unknown>;
    readonly processValidAd: () => Promise<unknown>;
    readonly processStreak: () => Promise<unknown>;
    readonly processPendingClaims: () => Promise<unknown>;
    readonly processMaturity: () => Promise<unknown>;
  },
): () => Promise<void> {
  return async () => {
    await handlers.processDailyLogin();
    await handlers.processValidAd();
    await handlers.processStreak();
    await handlers.processPendingClaims();
    await handlers.processMaturity();
  };
}

export function startMissionMaintenanceLoop(input: {
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly poll: () => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly schedule?: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
}): ReturnType<typeof setInterval> | undefined {
  if (!input.enabled) return undefined;
  let inFlight = false;
  const schedule = input.schedule ?? setInterval;
  return schedule(() => {
    if (inFlight) return;
    inFlight = true;
    void input
      .poll()
      .catch((error: unknown) => {
        input.onError(error);
      })
      .finally(() => {
        inFlight = false;
      });
  }, input.intervalMs);
}

export function createMissionMaintenanceCycle(input: {
  readonly pool: Pool;
  readonly deploymentEnv: DeploymentEnvName;
  readonly limit?: number;
}): () => Promise<{
  readonly environment: EnvironmentName;
  readonly dailyLoginExamined: number;
  readonly validAdExamined: number;
  readonly streakExamined: number;
  readonly pendingClaimsScanned: number;
  readonly maturityScanned: number;
}> {
  const limit = input.limit ?? DEFAULT_BATCH_LIMIT;
  return async () => {
    const environment = mapDeploymentEnvToRewardEnvironment(input.deploymentEnv);
    const dailyLogin = await processDailyLoginMissionContributionsBatch(input.pool, { limit });
    const validAd = await processValidAdMissionContributionsBatch(input.pool, { limit });
    const streak = await processStreakMissionContributionsBatch(input.pool, { limit });
    const pendingClaims = await processPendingMissionRewardClaimsBatch(input.pool, {
      environment,
      limit,
    });
    const maturity = await processDueMissionRewardMaturityBatch(input.pool, { limit });
    return {
      environment,
      dailyLoginExamined: dailyLogin.examined,
      validAdExamined: validAd.examined,
      streakExamined: streak.examined,
      pendingClaimsScanned: pendingClaims.scanned,
      maturityScanned: maturity.scanned,
    };
  };
}
