import type { PoolClient } from 'pg';

import { LedgerDomainError } from './errors.js';
import {
  PHASE10_TESTNET_AALEX_CONTRACT_IDENTITY,
  PHASE10_TESTNET_AALEX_DECIMALS,
  PHASE10_TESTNET_PROVISION_AALEX_SYMBOL,
} from './phase10-testnet-provision-assets.js';
import type { LedgerAccountType } from './types.js';

export interface AssetRecord {
  readonly id: string;
  readonly symbol: string;
  readonly isNative: boolean;
  readonly status: string;
  readonly networkId: string;
  readonly contractIdentity: string | null;
  readonly decimals: number;
}

export async function loadAsset(client: PoolClient, assetId: string): Promise<AssetRecord> {
  const result = await client.query<{
    id: string;
    symbol: string;
    is_native: boolean;
    status: string;
    network_id: string;
    contract_identity: string | null;
    decimals: number;
  }>(
    `SELECT id, symbol, is_native, status, network_id, contract_identity,
            decimals::int AS decimals
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
    decimals: row.decimals,
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

function assertAllowlistedJettonForHotWallet(asset: AssetRecord): void {
  if (asset.symbol === PHASE10_TESTNET_PROVISION_AALEX_SYMBOL) {
    if (asset.decimals !== PHASE10_TESTNET_AALEX_DECIMALS) {
      throw new LedgerDomainError(
        'ASSET_INCOMPATIBLE',
        'HOT_WALLET_JETTON_ASSET aalex requires exact decimals',
        {
          details: {
            assetId: asset.id,
            expected: PHASE10_TESTNET_AALEX_DECIMALS,
            actual: asset.decimals,
          },
        },
      );
    }
    const contract = (asset.contractIdentity ?? '').trim();
    if (contract !== PHASE10_TESTNET_AALEX_CONTRACT_IDENTITY) {
      throw new LedgerDomainError(
        'ASSET_INCOMPATIBLE',
        'HOT_WALLET_JETTON_ASSET aalex requires exact Jetton master',
        {
          details: {
            assetId: asset.id,
            expected: PHASE10_TESTNET_AALEX_CONTRACT_IDENTITY,
            actual: contract,
          },
        },
      );
    }
    return;
  }
  throw new LedgerDomainError(
    'ASSET_INCOMPATIBLE',
    'HOT_WALLET_JETTON_ASSET requires an allowlisted non-USDT Jetton asset',
    {
      details: {
        assetId: asset.id,
        symbol: asset.symbol,
        isNative: asset.isNative,
      },
    },
  );
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
    case 'HOT_WALLET_JETTON_ASSET': {
      if (asset.isNative || asset.symbol === 'USDT') {
        throw new LedgerDomainError(
          'ASSET_INCOMPATIBLE',
          'HOT_WALLET_JETTON_ASSET requires an ACTIVE non-native non-USDT Jetton',
          {
            details: {
              assetId,
              symbol: asset.symbol,
              isNative: asset.isNative,
            },
          },
        );
      }
      assertAllowlistedJettonForHotWallet(asset);
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

/**
 * Resolve the Hot Wallet inventory account type for a withdrawal/payout asset.
 * USDT keeps HOT_WALLET_USDT_ASSET; allowlisted Testnet Jettons use HOT_WALLET_JETTON_ASSET.
 */
export async function resolveHotWalletAssetAccountType(
  client: PoolClient,
  assetId: string,
): Promise<'HOT_WALLET_USDT_ASSET' | 'HOT_WALLET_JETTON_ASSET'> {
  const asset = await assertAssetActive(client, assetId);
  if (asset.symbol === 'USDT' && !asset.isNative) {
    return 'HOT_WALLET_USDT_ASSET';
  }
  if (!asset.isNative && asset.symbol !== 'USDT') {
    assertAllowlistedJettonForHotWallet(asset);
    return 'HOT_WALLET_JETTON_ASSET';
  }
  throw new LedgerDomainError(
    'ASSET_INCOMPATIBLE',
    'No Hot Wallet asset account type for this withdrawal asset',
    {
      details: {
        assetId,
        symbol: asset.symbol,
        isNative: asset.isNative,
      },
    },
  );
}
