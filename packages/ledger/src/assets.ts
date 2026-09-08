import type { PoolClient } from 'pg';

import { LedgerDomainError } from './errors.js';
import type { LedgerAccountType } from './types.js';

export interface AssetRecord {
  readonly id: string;
  readonly symbol: string;
  readonly isNative: boolean;
  readonly status: string;
  readonly networkId: string;
  readonly contractIdentity: string | null;
}

export async function loadAsset(client: PoolClient, assetId: string): Promise<AssetRecord> {
  const result = await client.query<{
    id: string;
    symbol: string;
    is_native: boolean;
    status: string;
    network_id: string;
    contract_identity: string | null;
  }>(
    `SELECT id, symbol, is_native, status, network_id, contract_identity
     FROM assets WHERE id = $1`,
    [assetId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new LedgerDomainError('VALIDATION', 'Unknown assetId', { details: { assetId } });
  }
  return {
    id: row.id,
    symbol: row.symbol,
    isNative: row.is_native,
    status: row.status,
    networkId: row.network_id,
    contractIdentity: row.contract_identity,
  };
}

export async function assertAssetActive(client: PoolClient, assetId: string): Promise<AssetRecord> {
  const asset = await loadAsset(client, assetId);
  if (asset.status !== 'ACTIVE') {
    throw new LedgerDomainError('ASSET_INACTIVE', 'Asset is not ACTIVE', {
      details: { assetId, status: asset.status },
    });
  }
  return asset;
}

/**
 * Centralized account-type ↔ asset compatibility.
 * Loads authoritative asset metadata; does not trust caller-provided strings alone.
 */
export async function assertAccountTypeAssetCompatibility(
  client: PoolClient,
  accountType: LedgerAccountType,
  assetId: string,
): Promise<AssetRecord> {
  const asset = await assertAssetActive(client, assetId);

  switch (accountType) {
    case 'HOT_WALLET_USDT_ASSET': {
      if (asset.symbol !== 'USDT' || asset.isNative) {
        throw new LedgerDomainError(
          'ASSET_INCOMPATIBLE',
          'HOT_WALLET_USDT_ASSET requires an ACTIVE non-native USDT asset',
          {
            details: {
              assetId,
              symbol: asset.symbol,
              isNative: asset.isNative,
            },
          },
        );
      }
      break;
    }
    case 'HOT_WALLET_TON_ASSET':
    case 'TON_NETWORK_FEE_EXPENSE': {
      if (asset.symbol !== 'TON' || !asset.isNative) {
        throw new LedgerDomainError(
          'ASSET_INCOMPATIBLE',
          `${accountType} requires an ACTIVE native TON asset`,
          {
            details: {
              assetId,
              symbol: asset.symbol,
              isNative: asset.isNative,
            },
          },
        );
      }
      break;
    }
    default:
      break;
  }

  return asset;
}
