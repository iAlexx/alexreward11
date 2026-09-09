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

/** Validated API/env subset used to build engine config (no Record casts). */
export interface ValidatedWithdrawalApiConfig {
  readonly DEPLOYMENT_ENV: 'local' | 'test' | 'staging' | 'production';
  readonly WITHDRAWAL_QUOTE_TTL_SECONDS: number;
  readonly WITHDRAWAL_RISK_POLICY_VERSION: number;
  readonly WITHDRAWAL_NETWORK_CODE: string;
  readonly WITHDRAWAL_ASSET_SYMBOL: string;
  readonly WITHDRAWAL_FAKE_CHAIN_ENABLED: boolean;
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
  if (config.usdtSymbol.trim() === '') {
    throw new WithdrawalDomainError('CONFIG', 'usdtSymbol is required');
  }
  const stagingOrProd =
    config.deploymentEnvironment === 'STAGING' || config.deploymentEnvironment === 'PRODUCTION';
  if (stagingOrProd && config.fakeChainEnabled) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Fake payout chain cannot be enabled in staging/production',
    );
  }
  if (stagingOrProd && config.acceptedNetworkCode === 'TON_TESTNET') {
    throw new WithdrawalDomainError(
      'CONFIG',
      'TON_TESTNET is forbidden for staging/production withdrawal config',
    );
  }
}

/**
 * Build engine config from validated ApiConfig fields only.
 * Local/test may use documented fixture defaults via config loader merge.
 * Staging/production must supply reviewed explicit values (fail closed upstream).
 */
export function withdrawalEngineConfigFromValidatedApi(
  api: ValidatedWithdrawalApiConfig,
): WithdrawalEngineConfig {
  const deploymentEnvironment: DeploymentEnvironment = (() => {
    switch (api.DEPLOYMENT_ENV) {
      case 'local':
        return 'LOCAL';
      case 'test':
        return 'DEV';
      case 'staging':
        return 'STAGING';
      case 'production':
        return 'PRODUCTION';
      default: {
        const exhaustive: never = api.DEPLOYMENT_ENV;
        return exhaustive;
      }
    }
  })();

  const config: WithdrawalEngineConfig = {
    deploymentEnvironment,
    quoteTtlSeconds: api.WITHDRAWAL_QUOTE_TTL_SECONDS,
    riskPolicyVersion: api.WITHDRAWAL_RISK_POLICY_VERSION,
    fakeChainEnabled: api.WITHDRAWAL_FAKE_CHAIN_ENABLED,
    acceptedNetworkCode: api.WITHDRAWAL_NETWORK_CODE,
    usdtSymbol: api.WITHDRAWAL_ASSET_SYMBOL,
  };
  assertWithdrawalEngineConfig(config);
  return config;
}

/** LOCAL/TEST fixture helper for domain tests — never call for staging/production API. */
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
