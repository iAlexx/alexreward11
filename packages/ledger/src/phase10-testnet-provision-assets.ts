/**
 * Explicit Phase 10 Testnet provision asset allowlist.
 *
 * USDT: preserve historical Testnet provision behavior (fixture placeholder master).
 * aalex: isolated Testnet Jetton only — exact master + decimals required.
 *
 * Mainnet / production provisioning remain forbidden by env + network gates.
 */

export const PHASE10_TESTNET_PROVISION_USDT_SYMBOL = 'USDT' as const;
export const PHASE10_TESTNET_PROVISION_AALEX_SYMBOL = 'aalex' as const;

export type Phase10TestnetProvisionAssetSymbol =
  | typeof PHASE10_TESTNET_PROVISION_USDT_SYMBOL
  | typeof PHASE10_TESTNET_PROVISION_AALEX_SYMBOL;

/** Exact isolated Testnet aalex Jetton master (raw 0:… form). */
export const PHASE10_TESTNET_AALEX_CONTRACT_IDENTITY =
  '0:e6e40e4e445c86c07df96a3129b67a74a411abbf1cd476607860978b7d5f1831' as const;

export const PHASE10_TESTNET_AALEX_DECIMALS = 9 as const;

/**
 * Absolute ceiling for aalex provision amounts (10 aalex).
 * Configured PHASE10_TESTNET_PROVISION_MAX_ATOMIC must be ≤ this when aalex is selected.
 */
export const PHASE10_TESTNET_AALEX_PROVISION_ABSOLUTE_CEILING_ATOMIC = 10_000_000_000n;

/** Operational database name that must never be targeted by aalex provision. */
export const PHASE10_OPERATIONAL_DATABASE_NAME = 'alex_rewards' as const;

export function isPhase10TestnetProvisionAssetSymbol(
  symbol: string,
): symbol is Phase10TestnetProvisionAssetSymbol {
  return (
    symbol === PHASE10_TESTNET_PROVISION_USDT_SYMBOL ||
    symbol === PHASE10_TESTNET_PROVISION_AALEX_SYMBOL
  );
}

export function aalexRequiresIsolatedDatabaseIdentity(): true {
  return true;
}
