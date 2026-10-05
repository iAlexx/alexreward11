import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';
import type { TonConnectAccount, TonProofObject } from '@alex-rewards/ton';
import {
  WalletDomainError,
  publicWalletFailureMessage,
  type DeploymentEnvironment,
  type WalletOwnershipConfig,
} from '@alex-rewards/wallets';

const WALLET_DEPLOYMENT_ENVIRONMENT: Readonly<
  Record<ApiConfig['DEPLOYMENT_ENV'], DeploymentEnvironment>
> = {
  local: 'LOCAL',
  test: 'LOCAL',
  staging: 'STAGING',
  production: 'PRODUCTION',
};

/**
 * Wallet ownership policy for this deployment.
 *
 * The accepted network is the configured payout network: a wallet may only be bound on the
 * chain withdrawals actually pay out on. The 24h post-change withdrawal cooldown is a fixed
 * V1.2 rule, not a tunable, so it is stated here rather than read from the environment.
 */
export function walletOwnershipConfigFromApi(config: ApiConfig): WalletOwnershipConfig {
  const throttleWindowSeconds = config.WALLET_PROOF_RATE_LIMIT_WINDOW_SECONDS;
  const throttleLimit = config.WALLET_PROOF_RATE_LIMIT_MAX;
  return {
    expectedTonProofDomain: config.WALLET_TON_PROOF_DOMAIN,
    challengeTtlSeconds: config.WALLET_CHALLENGE_TTL_SECONDS,
    maxProofAgeSeconds: config.WALLET_PROOF_MAX_AGE_SECONDS,
    maxFutureSkewSeconds: config.WALLET_PROOF_MAX_FUTURE_SKEW_SECONDS,
    withdrawalCooldownHours: 24,
    deploymentEnvironment: WALLET_DEPLOYMENT_ENVIRONMENT[config.DEPLOYMENT_ENV],
    acceptedNetworkCode: config.WITHDRAWAL_NETWORK_CODE,
    challengeThrottle: {
      keyPrefix: 'throttle:wallet:challenge',
      limit: throttleLimit,
      windowSeconds: throttleWindowSeconds,
    },
    verifyThrottle: {
      keyPrefix: 'throttle:wallet:verify',
      limit: throttleLimit,
      windowSeconds: throttleWindowSeconds,
    },
    invalidProofThrottle: {
      keyPrefix: 'throttle:wallet:invalid-proof',
      limit: throttleLimit,
      windowSeconds: throttleWindowSeconds,
    },
  };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ error: 'VALIDATION', message: `Invalid ${field}` });
  }
  return value as Record<string, unknown>;
}

function requireBoundedString(
  source: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value = source[field];
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new BadRequestException({ error: 'VALIDATION', message: `Invalid ${field}` });
  }
  return value;
}

function optionalBoundedString(
  source: Record<string, unknown>,
  field: string,
  maxLength: number,
): string | undefined {
  const value = source[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new BadRequestException({ error: 'VALIDATION', message: `Invalid ${field}` });
  }
  return value;
}

/**
 * Parse a TON Connect bind request.
 *
 * Shape validation only. Every security decision — domain, payload, timestamp, network and
 * signature — belongs to `@alex-rewards/wallets` and `@alex-rewards/ton`; nothing accepted
 * here is trusted because the client sent it.
 */
export function parseTonProofBindBody(body: unknown): {
  readonly account: TonConnectAccount;
  readonly proof: TonProofObject;
  readonly walletName: string | null;
} {
  const source = asObject(body, 'request body');
  const accountSource = asObject(source['account'], 'account');
  const proofSource = asObject(source['proof'], 'proof');
  const domainSource = asObject(proofSource['domain'], 'proof.domain');

  const publicKey = optionalBoundedString(accountSource, 'publicKey', 512);
  const walletStateInit = optionalBoundedString(accountSource, 'walletStateInit', 20_000);
  const account: TonConnectAccount = {
    address: requireBoundedString(accountSource, 'address', 128),
    network: requireBoundedString(accountSource, 'network', 32),
    ...(publicKey === undefined ? {} : { publicKey }),
    ...(walletStateInit === undefined ? {} : { walletStateInit }),
  };

  const timestamp = proofSource['timestamp'];
  if (typeof timestamp !== 'number' || !Number.isInteger(timestamp) || timestamp <= 0) {
    throw new BadRequestException({ error: 'VALIDATION', message: 'Invalid proof.timestamp' });
  }
  const lengthBytes = domainSource['lengthBytes'];
  if (typeof lengthBytes !== 'number' || !Number.isInteger(lengthBytes) || lengthBytes <= 0) {
    throw new BadRequestException({
      error: 'VALIDATION',
      message: 'Invalid proof.domain.lengthBytes',
    });
  }

  const stateInit = optionalBoundedString(proofSource, 'stateInit', 20_000);
  const proof: TonProofObject = {
    timestamp,
    domain: { lengthBytes, value: requireBoundedString(domainSource, 'value', 253) },
    payload: requireBoundedString(proofSource, 'payload', 1024),
    signature: requireBoundedString(proofSource, 'signature', 1024),
    ...(stateInit === undefined ? {} : { stateInit }),
  };

  const walletName = optionalBoundedString(source, 'walletName', 64) ?? null;
  return { account, proof, walletName };
}

/** Map a wallet-domain failure onto HTTP without leaking why a proof was rejected. */
export function mapWalletError(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof WalletDomainError) {
    const body = { error: error.code, message: publicWalletFailureMessage(error.code) };
    switch (error.code) {
      case 'UNAUTHORIZED':
        return new UnauthorizedException(body);
      case 'RATE_LIMITED':
        return new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
      case 'REPLAY':
      case 'CHALLENGE_CONSUMED':
        return new ConflictException(body);
      case 'VALIDATION':
      case 'CHALLENGE_NOT_FOUND':
      case 'CHALLENGE_EXPIRED':
      case 'CHALLENGE_INVALIDATED':
      case 'INVALID_PROOF':
      case 'INVALID_DOMAIN':
      case 'INVALID_NETWORK':
      case 'INVALID_WALLET':
      case 'INVALID_ADDRESS':
      case 'PRIMARY_REQUIRED':
        return new BadRequestException(body);
      case 'CONFIG':
      case 'INTERNAL':
      default:
        return new HttpException(
          { error: 'INTERNAL', message: 'Request failed' },
          HttpStatus.INTERNAL_SERVER_ERROR,
        );
    }
  }
  return new HttpException(
    { error: 'INTERNAL', message: 'Request failed' },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}
