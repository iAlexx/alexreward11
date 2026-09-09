import { WalletDomainError } from './errors.js';

export type DeploymentEnvironment = 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';

export interface WalletThrottlePolicy {
  readonly keyPrefix: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface WalletOwnershipConfig {
  /**
   * Server-authoritative ton_proof domain. Never derived from Host/Origin/Telegram URL.
   * Required for all environments including LOCAL fixtures.
   */
  readonly expectedTonProofDomain: string;
  /** Challenge TTL in seconds. Must be explicitly set for STAGING/PRODUCTION. */
  readonly challengeTtlSeconds: number;
  readonly maxProofAgeSeconds: number;
  readonly maxFutureSkewSeconds: number;
  /** V1.2 default: 24 hours. Must not be shortened for Founder/premium. */
  readonly withdrawalCooldownHours: number;
  readonly deploymentEnvironment: DeploymentEnvironment;
  /**
   * Authoritative networks.code accepted by this deployment (e.g. TON_TESTNET for local).
   * Client cannot select a trusted network.
   */
  readonly acceptedNetworkCode: string;
  readonly accessTokenSecret?: string;
  readonly challengeThrottle?: WalletThrottlePolicy;
  readonly verifyThrottle?: WalletThrottlePolicy;
  readonly invalidProofThrottle?: WalletThrottlePolicy;
}

const UNSAFE_LOCAL_DOMAINS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

export function assertWalletOwnershipConfig(config: WalletOwnershipConfig): void {
  if (config.expectedTonProofDomain.trim() === '') {
    throw new WalletDomainError('CONFIG', 'expectedTonProofDomain is required');
  }
  if (!Number.isInteger(config.challengeTtlSeconds) || config.challengeTtlSeconds <= 0) {
    throw new WalletDomainError('CONFIG', 'challengeTtlSeconds must be a positive integer');
  }
  if (!Number.isInteger(config.maxProofAgeSeconds) || config.maxProofAgeSeconds <= 0) {
    throw new WalletDomainError('CONFIG', 'maxProofAgeSeconds must be a positive integer');
  }
  if (!Number.isInteger(config.maxFutureSkewSeconds) || config.maxFutureSkewSeconds < 0) {
    throw new WalletDomainError('CONFIG', 'maxFutureSkewSeconds must be a non-negative integer');
  }
  if (config.withdrawalCooldownHours !== 24) {
    throw new WalletDomainError('CONFIG', 'withdrawalCooldownHours must be 24 per V1.2');
  }
  if (config.acceptedNetworkCode.trim() === '') {
    throw new WalletDomainError('CONFIG', 'acceptedNetworkCode is required');
  }

  const domain = config.expectedTonProofDomain.trim().toLowerCase();
  const isStagingOrProd =
    config.deploymentEnvironment === 'STAGING' || config.deploymentEnvironment === 'PRODUCTION';
  if (isStagingOrProd) {
    if (UNSAFE_LOCAL_DOMAINS.has(domain) || domain.endsWith('.localhost')) {
      throw new WalletDomainError(
        'CONFIG',
        'Staging/production must not use localhost as ton_proof domain authority',
      );
    }
    if (config.challengeTtlSeconds > 900) {
      throw new WalletDomainError(
        'CONFIG',
        'Staging/production challenge TTL must be explicitly short (≤900s)',
      );
    }
  }
}

/** LOCAL/DEV test fixture defaults — never silently inherited by STAGING/PRODUCTION. */
export function localWalletOwnershipFixtureConfig(
  overrides: Partial<WalletOwnershipConfig> = {},
): WalletOwnershipConfig {
  const config: WalletOwnershipConfig = {
    expectedTonProofDomain: 'alex-rewards.local.test',
    challengeTtlSeconds: 300,
    maxProofAgeSeconds: 900,
    maxFutureSkewSeconds: 60,
    withdrawalCooldownHours: 24,
    deploymentEnvironment: 'LOCAL',
    acceptedNetworkCode: 'TON_TESTNET',
    ...overrides,
  };
  assertWalletOwnershipConfig(config);
  return config;
}
