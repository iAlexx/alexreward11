/**
 * Referral maintenance loop (activation → issuance → maturity).
 * In-flight guarded; DEPLOYMENT_ENV mapped exhaustively (unknown = fail closed).
 */
import type { Pool } from 'pg';

import {
  processPendingReferralActivationBatch,
} from '@alex-rewards/referrals';
import {
  processDueReferralMaturityBatch,
  processReferralIssuanceBatch,
} from '@alex-rewards/rewards';
import type { EnvironmentName } from '@alex-rewards/rewards';

const DEFAULT_BATCH_LIMIT = 50;

export type DeploymentEnvName = 'local' | 'test' | 'staging' | 'production' | string;

/**
 * Map worker DEPLOYMENT_ENV to reward EnvironmentName.
 * Unknown values fail closed (no LOCAL default).
 */
export function mapDeploymentEnvToRewardEnvironment(
  deploymentEnv: DeploymentEnvName,
): EnvironmentName {
  switch (deploymentEnv) {
    case 'local':
      return 'LOCAL';
    case 'staging':
      return 'STAGING';
    case 'production':
      return 'PRODUCTION';
    default:
      throw new Error(`REFERRAL_MAINTENANCE_ENV_UNMAPPED:${String(deploymentEnv)}`);
  }
}

export interface ReferralMaintenanceHandlers {
  readonly processActivation: () => Promise<unknown>;
  readonly processIssuance: () => Promise<unknown>;
  readonly processMaturity: () => Promise<unknown>;
}

export function createReferralMaintenancePoller(
  handlers: ReferralMaintenanceHandlers,
): () => Promise<void> {
  return async () => {
    await handlers.processActivation();
    await handlers.processIssuance();
    await handlers.processMaturity();
  };
}

export function startReferralMaintenanceLoop(input: {
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

export function createReferralMaintenanceCycle(input: {
  readonly pool: Pool;
  readonly deploymentEnv: DeploymentEnvName;
  readonly limit?: number;
}): () => Promise<{
  readonly environment: EnvironmentName;
  readonly activationScanned: number;
  readonly issuanceScanned: number;
  readonly maturityScanned: number;
}> {
  const limit = input.limit ?? DEFAULT_BATCH_LIMIT;
  return async () => {
    const environment = mapDeploymentEnvToRewardEnvironment(input.deploymentEnv);
    const activation = await processPendingReferralActivationBatch(input.pool, { limit });
    const issuance = await processReferralIssuanceBatch(input.pool, {
      environment,
      limit,
    });
    const maturity = await processDueReferralMaturityBatch(input.pool, { limit });
    return {
      environment,
      activationScanned: activation.scanned,
      issuanceScanned: issuance.scanned,
      maturityScanned: maturity.scanned,
    };
  };
}
