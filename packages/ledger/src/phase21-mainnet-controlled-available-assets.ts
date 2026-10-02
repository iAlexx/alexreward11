/**
 * Phase 21 controlled Mainnet Available provision — asset/network constants.
 * Forever separate from Phase 10 Testnet provision.
 */
export const PHASE21_CONTROLLED_PROVISION_NETWORK_CODE = 'TON_MAINNET' as const;
export const PHASE21_CONTROLLED_PROVISION_ASSET_SYMBOL = 'USDT' as const;
export const PHASE21_CONTROLLED_PROVISION_CHAIN = 'TON' as const;
export const PHASE21_CONTROLLED_PROVISION_ENVIRONMENT = 'MAINNET' as const;
export const PHASE21_CONTROLLED_PROVISION_GLOBAL_CHAIN_ID = 'ton:mainnet' as const;

/** Aggregate campaign ceiling: 10_000_000 atomic USDT (10 USDT at 6 decimals). */
export const PHASE21_CONTROLLED_AVAILABLE_CAMPAIGN_CEILING_ATOMIC = 10_000_000n;

/** Micro-launch band documentation: 50 x 0.20 gross = 10.00 USDT; net 9.50 with 0.01 fee. */
export const PHASE21_MICRO_LAUNCH_GROSS_USDT = '10.00' as const;
export const PHASE21_MICRO_LAUNCH_NET_USDT = '9.50' as const;
export const PHASE21_MICRO_LAUNCH_FEE_USDT = '0.01' as const;
export const PHASE21_MICRO_LAUNCH_WITHDRAWAL_COUNT = 50 as const;
export const PHASE21_MICRO_LAUNCH_GROSS_PER_WITHDRAWAL_USDT = '0.20' as const;

/**
 * Operational Postgres database name.
 * Used only to refuse accidental ops-DB use from **test/local** provision tooling.
 * Production operational ceremony intentionally targets the Owner-configured authoritative
 * ledger name (may equal this value) — do not forbid it on the production ceremony path.
 */
export const PHASE21_OPERATIONAL_DATABASE_NAME = 'alex_rewards' as const;
