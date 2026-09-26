/**
 * Phase 10 controlled success-path multi-payout batch planner / safety gates.
 * Does not create withdrawals by itself — callers supply domain ports.
 * Never bypasses volume limits, pause, or dual-provider confirmation requirements.
 */

export const PHASE10_SUCCESS_BATCH_GROSS_ATOMIC = '200000' as const;
export const PHASE10_SUCCESS_BATCH_FEE_ATOMIC = '10000' as const;
export const PHASE10_SUCCESS_BATCH_NET_ATOMIC = '190000' as const;
export const PHASE10_SUCCESS_BATCH_MAX_ADDITIONAL_UTC_DAY = 49 as const;
export const PHASE10_SUCCESS_BATCH_MAX_PER_HOUR = 25 as const;

export type Phase10BatchStopReason =
  | 'completed_target'
  | 'user_daily_cap'
  | 'user_hourly_cap'
  | 'hot_daily_cap'
  | 'hot_hourly_cap'
  | 'insufficient_available'
  | 'insufficient_hot_jw'
  | 'insufficient_ton_gas'
  | 'accounting_mismatch'
  | 'provider_disagree'
  | 'provider_429_exhausted'
  | 'ambiguous_broadcast'
  | 'reconcile_required'
  | 'signer_locked'
  | 'pause_reenabled'
  | 'duplicate_runner'
  | 'lease_conflict'
  | 'settlement_failed'
  | 'campaign_attach_failed'
  | 'max_authorized'
  | 'unsafe_precondition';

export interface Phase10BatchCapacitySnapshot {
  readonly userAvailableAtomic: string;
  readonly hotJwOnChainAtomic: string;
  readonly hotLedgerAtomic: string;
  readonly tonBalanceNano: string;
  readonly userHourlyConsumedAtomic: string;
  readonly userHourlyMaxAtomic: string;
  readonly userDailyConsumedAtomic: string;
  readonly userDailyMaxAtomic: string;
  readonly hotHourlyConsumedAtomic: string;
  readonly hotHourlyMaxAtomic: string;
  readonly hotDailyConsumedAtomic: string;
  readonly hotDailyMaxAtomic: string;
  readonly confirmedUsdtInCampaign: number;
  readonly authorizedMaxAdditional: number;
}

export interface Phase10BatchPlan {
  readonly grossAtomic: typeof PHASE10_SUCCESS_BATCH_GROSS_ATOMIC;
  readonly feeAtomic: typeof PHASE10_SUCCESS_BATCH_FEE_ATOMIC;
  readonly netAtomic: typeof PHASE10_SUCCESS_BATCH_NET_ATOMIC;
  readonly maxAdditionalAuthorized: number;
  readonly maxByUserDaily: number;
  readonly maxByUserHourly: number;
  readonly maxByHotDaily: number;
  readonly maxByHotHourly: number;
  readonly maxByAvailable: number;
  readonly maxByHotJw: number;
  readonly executableNow: number;
  readonly bindingConstraint: string;
}

function floorDiv(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  const q = numerator / denominator;
  return q > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(q);
}

function remCap(maxAtomic: string, consumedAtomic: string, unit: bigint): number {
  const rem = BigInt(maxAtomic) - BigInt(consumedAtomic);
  return floorDiv(rem, unit);
}

/**
 * Compute how many additional min-size success payouts may start now.
 * Never exceeds authorizedMaxAdditional (Owner cap for this window).
 */
export function planPhase10SuccessBatch(
  capacity: Phase10BatchCapacitySnapshot,
  options: { readonly minTonNanoPerPayout?: bigint } = {},
): Phase10BatchPlan {
  const gross = BigInt(PHASE10_SUCCESS_BATCH_GROSS_ATOMIC);
  const net = BigInt(PHASE10_SUCCESS_BATCH_NET_ATOMIC);
  const minTon = options.minTonNanoPerPayout ?? 50_000_000n; // 0.05 TON conservative

  const maxByUserDaily = remCap(
    capacity.userDailyMaxAtomic,
    capacity.userDailyConsumedAtomic,
    gross,
  );
  const maxByUserHourly = remCap(
    capacity.userHourlyMaxAtomic,
    capacity.userHourlyConsumedAtomic,
    gross,
  );
  const maxByHotDaily = remCap(capacity.hotDailyMaxAtomic, capacity.hotDailyConsumedAtomic, gross);
  const maxByHotHourly = remCap(
    capacity.hotHourlyMaxAtomic,
    capacity.hotHourlyConsumedAtomic,
    gross,
  );
  const maxByAvailable = floorDiv(BigInt(capacity.userAvailableAtomic), gross);
  const maxByHotJw = floorDiv(BigInt(capacity.hotJwOnChainAtomic), net);
  const maxByTon = floorDiv(BigInt(capacity.tonBalanceNano), minTon);

  const authorized = Math.min(
    capacity.authorizedMaxAdditional,
    PHASE10_SUCCESS_BATCH_MAX_ADDITIONAL_UTC_DAY,
  );

  const candidates: Array<{ readonly name: string; readonly n: number }> = [
    { name: 'authorized_max', n: authorized },
    { name: 'user_daily', n: maxByUserDaily },
    { name: 'user_hourly', n: maxByUserHourly },
    { name: 'hot_daily', n: maxByHotDaily },
    { name: 'hot_hourly', n: maxByHotHourly },
    { name: 'available', n: maxByAvailable },
    { name: 'hot_jw', n: maxByHotJw },
    { name: 'ton_gas', n: maxByTon },
  ];
  let binding = candidates[0]!;
  for (const c of candidates) {
    if (c.n < binding.n) binding = c;
  }

  return {
    grossAtomic: PHASE10_SUCCESS_BATCH_GROSS_ATOMIC,
    feeAtomic: PHASE10_SUCCESS_BATCH_FEE_ATOMIC,
    netAtomic: PHASE10_SUCCESS_BATCH_NET_ATOMIC,
    maxAdditionalAuthorized: authorized,
    maxByUserDaily,
    maxByUserHourly,
    maxByHotDaily,
    maxByHotHourly,
    maxByAvailable,
    maxByHotJw,
    executableNow: Math.max(0, binding.n),
    bindingConstraint: binding.name,
  };
}

export interface Phase10BatchPayoutOutcome {
  readonly withdrawalId: string;
  readonly publicId: string | null;
  readonly state: string;
  readonly attemptId: string | null;
  readonly queryId: string | null;
  readonly broadcastResultState: string | null;
  readonly settled: boolean;
  readonly campaignAttached: boolean;
}

export interface Phase10BatchSafetyPreconditions {
  readonly pauseEnabled: boolean;
  readonly realChainEnabled: boolean;
  readonly fakeChainEnabled: boolean;
  readonly signerCustody: 'LOCKED' | 'UNLOCKED' | string;
  readonly hotLedgerMatchesOnChain: boolean;
  readonly runnerLockHeld: boolean;
  readonly duplicateRunnerDetected: boolean;
}

export function assertPhase10BatchPreStart(
  pre: Phase10BatchSafetyPreconditions,
): { readonly ok: true } | { readonly ok: false; readonly reason: Phase10BatchStopReason } {
  if (pre.duplicateRunnerDetected) return { ok: false, reason: 'duplicate_runner' };
  if (!pre.runnerLockHeld) return { ok: false, reason: 'duplicate_runner' };
  if (pre.fakeChainEnabled) return { ok: false, reason: 'unsafe_precondition' };
  if (!pre.hotLedgerMatchesOnChain) return { ok: false, reason: 'accounting_mismatch' };
  // Pre-start: pause should be true and REAL false / signer LOCKED (safe defaults).
  if (!pre.pauseEnabled) return { ok: false, reason: 'unsafe_precondition' };
  if (pre.realChainEnabled) return { ok: false, reason: 'unsafe_precondition' };
  if (pre.signerCustody !== 'LOCKED') return { ok: false, reason: 'unsafe_precondition' };
  return { ok: true };
}

export function classifyTerminalPayoutState(input: {
  readonly withdrawalState: string;
  readonly broadcastResultState: string | null;
  readonly settled: boolean;
  readonly dualProviderAgree: boolean | null;
  readonly provider429Exhausted: boolean;
}): { readonly continueBatch: boolean; readonly stopReason: Phase10BatchStopReason | null } {
  if (input.provider429Exhausted) {
    return { continueBatch: false, stopReason: 'provider_429_exhausted' };
  }
  if (
    input.broadcastResultState === 'UNKNOWN' ||
    input.broadcastResultState === 'RECONCILE_REQUIRED' ||
    input.withdrawalState === 'RECONCILE_REQUIRED'
  ) {
    return { continueBatch: false, stopReason: 'ambiguous_broadcast' };
  }
  if (input.dualProviderAgree === false) {
    return { continueBatch: false, stopReason: 'provider_disagree' };
  }
  if (input.withdrawalState === 'CONFIRMED' && input.settled) {
    return { continueBatch: true, stopReason: null };
  }
  if (input.withdrawalState === 'CONFIRMED' && !input.settled) {
    return { continueBatch: false, stopReason: 'settlement_failed' };
  }
  return { continueBatch: false, stopReason: 'reconcile_required' };
}

/**
 * Hourly pacing: after `completedInHour` successes, if next would exceed hourly cap, stop.
 */
export function shouldStopForHourlyCap(completedInHour: number, hourlyMaxPayouts: number): boolean {
  return completedInHour >= hourlyMaxPayouts;
}

export function nextBatchStopAfterSuccess(input: {
  readonly completedInBatch: number;
  readonly executableNow: number;
  readonly completedInHour: number;
  readonly hourlyMaxPayouts: number;
}): Phase10BatchStopReason | null {
  if (input.completedInBatch >= input.executableNow) return 'completed_target';
  if (shouldStopForHourlyCap(input.completedInHour, input.hourlyMaxPayouts)) {
    return 'user_hourly_cap';
  }
  return null;
}
