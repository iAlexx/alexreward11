import { WithdrawalDomainError } from './errors.js';

export type DeploymentEnvironment = 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';

/** Locked V1.2 initial atomic values for 6-decimal USDT (local/test fixtures only). */
export const LOCKED_INITIAL_WITHDRAWAL = {
  minWithdrawalAtomic: 200_000n,
  fixedFeeAtomic: 10_000n,
  maxSingleWithdrawalAtomic: 5_000_000n,
  maxUserHourlyAtomic: 5_000_000n,
  maxUserDailyAtomic: 10_000_000n,
  maxHotWalletHourlyAtomic: 25_000_000n,
  maxHotWalletDailyAtomic: 100_000_000n,
  walletChangeCooldownSeconds: 86_400,
} as const;

export interface WithdrawalEngineConfig {
  readonly deploymentEnvironment: DeploymentEnvironment;
  /** Explicit quote TTL seconds — never invent production TTL silently. */
  readonly quoteTtlSeconds: number;
  readonly riskPolicyVersion: number;
  /**
   * Fake payout chain is LOCAL/DEV/TEST only.
   * Staging/production must keep this false and fail closed if fake dispatch is attempted.
   */
  readonly fakeChainEnabled: boolean;
  readonly acceptedNetworkCode: string;
  readonly usdtSymbol: string;
}

export function assertWithdrawalEngineConfig(config: WithdrawalEngineConfig): void {
  if (!Number.isInteger(config.quoteTtlSeconds) || config.quoteTtlSeconds <= 0) {
    throw new WithdrawalDomainError('CONFIG', 'quoteTtlSeconds must be a positive integer');
  }
  if (!Number.isInteger(config.riskPolicyVersion) || config.riskPolicyVersion <= 0) {
    throw new WithdrawalDomainError('CONFIG', 'riskPolicyVersion must be a positive integer');
  }
  if (config.acceptedNetworkCode.trim() === '') {
    throw new WithdrawalDomainError('CONFIG', 'acceptedNetworkCode is required');
  }
  const stagingOrProd =
    config.deploymentEnvironment === 'STAGING' || config.deploymentEnvironment === 'PRODUCTION';
  if (stagingOrProd && config.fakeChainEnabled) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Fake payout chain cannot be enabled in staging/production',
    );
  }
}

export function localWithdrawalEngineFixtureConfig(
  overrides: Partial<WithdrawalEngineConfig> = {},
): WithdrawalEngineConfig {
  const config: WithdrawalEngineConfig = {
    deploymentEnvironment: 'LOCAL',
    quoteTtlSeconds: 300,
    riskPolicyVersion: 1,
    fakeChainEnabled: true,
    acceptedNetworkCode: 'TON_TESTNET',
    usdtSymbol: 'USDT',
    ...overrides,
  };
  assertWithdrawalEngineConfig(config);
  return config;
}
