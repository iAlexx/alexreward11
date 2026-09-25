/**
 * Proposed isolated Testnet aalex fee/limit rules for a future 1 aalex withdrawal.
 *
 * NOT activated on any database by default. LOCAL/TEST seed helper only.
 * Control Center has no Owner fee/limit mutation API yet; production rule creation
 * remains an audited Admin action (OWNER_DECISION / future Control Center).
 *
 * Scale: 9 decimals. 1 aalex = 1_000_000_000 atomic.
 * Fee/limit ratios mirror locked V1.2 USDT economics at aalex unit scale.
 */
export const PROPOSED_ISOLATED_AALEX_WITHDRAWAL = {
  symbol: 'aalex' as const,
  decimals: 9,
  contractIdentity: '0:e6e40e4e445c86c07df96a3129b67a74a411abbf1cd476607860978b7d5f1831',
  /** Exactly 1 aalex — minimum single withdrawal for the isolated test target. */
  minWithdrawalAtomic: 1_000_000_000n,
  /** 0.01 aalex fixed fee → net for 1 aalex = 990_000_000 > 0. */
  fixedFeeAtomic: 10_000_000n,
  maxSingleWithdrawalAtomic: 5_000_000_000n,
  maxUserHourlyAtomic: 5_000_000_000n,
  maxUserDailyAtomic: 10_000_000_000n,
  maxHotWalletHourlyAtomic: 25_000_000_000n,
  maxHotWalletDailyAtomic: 100_000_000_000n,
  walletChangeCooldownSeconds: 86_400,
  /**
   * Explicit NULL: schema requires NULL or > 0; NULL matches locked USDT fixture
   * (no auto-payout ceiling column). Manual Owner review remains the intended
   * isolated Testnet policy until auto-payout enforcement is implemented.
   */
  maxAutoPayoutAtomic: null as bigint | null,
  oneAalexGrossAtomic: 1_000_000_000n,
} as const;

export interface OneAalexQuoteValidation {
  readonly valid: boolean;
  readonly reason?: string;
  readonly grossAtomic: string;
  readonly feeAtomic: string;
  readonly netAtomic: string;
}

/** Pure check: 1 aalex gross under proposed rules yields positive net. */
export function validateOneAalexUnderProposedRules(): OneAalexQuoteValidation {
  const gross = PROPOSED_ISOLATED_AALEX_WITHDRAWAL.oneAalexGrossAtomic;
  const fee = PROPOSED_ISOLATED_AALEX_WITHDRAWAL.fixedFeeAtomic;
  const min = PROPOSED_ISOLATED_AALEX_WITHDRAWAL.minWithdrawalAtomic;
  const max = PROPOSED_ISOLATED_AALEX_WITHDRAWAL.maxSingleWithdrawalAtomic;
  if (gross < min || gross > max) {
    return {
      valid: false,
      reason: 'GROSS_OUTSIDE_LIMITS',
      grossAtomic: gross.toString(10),
      feeAtomic: fee.toString(10),
      netAtomic: '0',
    };
  }
  if (fee < 0n || fee >= gross) {
    return {
      valid: false,
      reason: 'FEE_INVALID',
      grossAtomic: gross.toString(10),
      feeAtomic: fee.toString(10),
      netAtomic: '0',
    };
  }
  const net = gross - fee;
  if (net <= 0n) {
    return {
      valid: false,
      reason: 'NET_NOT_POSITIVE',
      grossAtomic: gross.toString(10),
      feeAtomic: fee.toString(10),
      netAtomic: net.toString(10),
    };
  }
  return {
    valid: true,
    grossAtomic: gross.toString(10),
    feeAtomic: fee.toString(10),
    netAtomic: net.toString(10),
  };
}
