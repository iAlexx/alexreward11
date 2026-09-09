import {
  tonConnectNetworkFromGlobalChainIdentifier,
  type TonConnectNetworkId,
  TonDomainError,
} from '@alex-rewards/ton';
import type { PoolClient } from 'pg';

import type { DeploymentEnvironment } from './config.js';
import { WalletDomainError } from './errors.js';

export interface AcceptedNetwork {
  readonly id: string;
  readonly code: string;
  readonly chain: string;
  readonly environment: string;
  readonly globalChainIdentifier: string;
  readonly status: string;
  readonly tonConnectNetworkId: TonConnectNetworkId;
}

function environmentAllowed(
  deploymentEnvironment: DeploymentEnvironment,
  networkEnvironment: string,
): boolean {
  if (deploymentEnvironment === 'LOCAL' || deploymentEnvironment === 'DEV') {
    return networkEnvironment === 'TESTNET' || networkEnvironment === 'MAINNET';
  }
  if (deploymentEnvironment === 'STAGING') {
    return networkEnvironment === 'TESTNET';
  }
  return networkEnvironment === 'MAINNET';
}

/**
 * Resolve the single accepted TON network for this deployment from `networks`.
 * Client never decides which chain is trusted.
 */
export async function resolveAcceptedTonNetwork(
  client: PoolClient,
  input: {
    readonly acceptedNetworkCode: string;
    readonly deploymentEnvironment: DeploymentEnvironment;
  },
): Promise<AcceptedNetwork> {
  const result = await client.query<{
    id: string;
    code: string;
    chain: string;
    environment: string;
    global_chain_identifier: string | null;
    status: string;
  }>(
    `SELECT id, code, chain, environment::text AS environment,
            global_chain_identifier, status::text AS status
     FROM networks
     WHERE code = $1
     FOR SHARE`,
    [input.acceptedNetworkCode],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted');
  }
  if (row.chain !== 'TON') {
    throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
      details: { reason: 'CHAIN_NOT_TON' },
    });
  }
  if (row.status !== 'ACTIVE') {
    throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
      details: { reason: 'NETWORK_DISABLED' },
    });
  }
  if (!environmentAllowed(input.deploymentEnvironment, row.environment)) {
    throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
      details: { reason: 'ENVIRONMENT_MISMATCH' },
    });
  }
  if (row.global_chain_identifier === null || row.global_chain_identifier.trim() === '') {
    throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
      details: { reason: 'MISSING_CHAIN_IDENTIFIER' },
    });
  }

  let tonConnectNetworkId: TonConnectNetworkId;
  try {
    tonConnectNetworkId = tonConnectNetworkFromGlobalChainIdentifier(row.global_chain_identifier);
  } catch (error) {
    if (error instanceof TonDomainError) {
      throw new WalletDomainError(
        'INVALID_NETWORK',
        'Network is not accepted',
        error.details === undefined ? { cause: error } : { cause: error, details: error.details },
      );
    }
    throw error;
  }

  return {
    id: row.id,
    code: row.code,
    chain: row.chain,
    environment: row.environment,
    globalChainIdentifier: row.global_chain_identifier,
    status: row.status,
    tonConnectNetworkId,
  };
}
