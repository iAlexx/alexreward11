import { describe, expect, it } from 'vitest';

import {
  PHASE10_SUCCESS_BATCH_GROSS_ATOMIC,
  PHASE10_SUCCESS_BATCH_MAX_ADDITIONAL_UTC_DAY,
  PHASE10_SUCCESS_BATCH_MAX_PER_HOUR,
  assertPhase10BatchPreStart,
  classifyTerminalPayoutState,
  nextBatchStopAfterSuccess,
  planPhase10SuccessBatch,
  shouldStopForHourlyCap,
  type Phase10BatchCapacitySnapshot,
} from '../src/phase10-success-batch-runner.js';

function baseCapacity(
  overrides: Partial<Phase10BatchCapacitySnapshot> = {},
): Phase10BatchCapacitySnapshot {
  return {
    userAvailableAtomic: '24800000',
    hotJwOnChainAtomic: '24810000',
    hotLedgerAtomic: '24810000',
    tonBalanceNano: '7996652224',
    userHourlyConsumedAtomic: '0',
    userHourlyMaxAtomic: '5000000',
    userDailyConsumedAtomic: '200000',
    userDailyMaxAtomic: '10000000',
    hotHourlyConsumedAtomic: '0',
    hotHourlyMaxAtomic: '25000000',
    hotDailyConsumedAtomic: '200000',
    hotDailyMaxAtomic: '100000000',
    confirmedUsdtInCampaign: 1,
    authorizedMaxAdditional: 49,
    ...overrides,
  };
}

describe('phase10 success batch planner', () => {
  it('binds to user hourly (25) when daily remaining is 49', () => {
    const plan = planPhase10SuccessBatch(baseCapacity());
    expect(plan.grossAtomic).toBe(PHASE10_SUCCESS_BATCH_GROSS_ATOMIC);
    expect(plan.maxByUserDaily).toBe(49);
    expect(plan.maxByUserHourly).toBe(25);
    expect(plan.executableNow).toBe(25);
    expect(plan.bindingConstraint).toBe('user_hourly');
    expect(plan.maxAdditionalAuthorized).toBe(PHASE10_SUCCESS_BATCH_MAX_ADDITIONAL_UTC_DAY);
  });

  it('never exceeds authorized max even if capacity is higher', () => {
    const plan = planPhase10SuccessBatch(
      baseCapacity({
        authorizedMaxAdditional: 10,
        userDailyConsumedAtomic: '0',
        userAvailableAtomic: '100000000',
        hotJwOnChainAtomic: '100000000',
      }),
    );
    expect(plan.executableNow).toBe(10);
    expect(plan.bindingConstraint).toBe('authorized_max');
  });

  it('stops at hourly cap before daily when hourly is tighter', () => {
    const plan = planPhase10SuccessBatch(
      baseCapacity({
        userHourlyConsumedAtomic: '0',
        userHourlyMaxAtomic: '1000000', // 5 min payouts
        userDailyConsumedAtomic: '0',
      }),
    );
    expect(plan.maxByUserHourly).toBe(5);
    expect(plan.executableNow).toBe(5);
    expect(plan.bindingConstraint).toBe('user_hourly');
  });

  it('fails closed on insufficient available / hot jw', () => {
    expect(
      planPhase10SuccessBatch(baseCapacity({ userAvailableAtomic: '100000' })).executableNow,
    ).toBe(0);
    expect(planPhase10SuccessBatch(baseCapacity({ hotJwOnChainAtomic: '1000' })).executableNow).toBe(
      0,
    );
  });

  it('Hot USDT exact net boundary: 190000 → capacity 1; 189999 → capacity 0', () => {
    const atBoundary = planPhase10SuccessBatch(
      baseCapacity({
        hotJwOnChainAtomic: '190000',
        hotLedgerAtomic: '190000',
        userAvailableAtomic: '200000',
        authorizedMaxAdditional: 49,
        userHourlyMaxAtomic: '5000000',
        userDailyConsumedAtomic: '0',
        tonBalanceNano: '500000000',
      }),
    );
    expect(atBoundary.maxByHotJw).toBe(1);
    expect(atBoundary.executableNow).toBeGreaterThanOrEqual(1);

    const below = planPhase10SuccessBatch(
      baseCapacity({
        hotJwOnChainAtomic: '189999',
        hotLedgerAtomic: '189999',
        userAvailableAtomic: '200000',
        authorizedMaxAdditional: 49,
        userHourlyMaxAtomic: '5000000',
        userDailyConsumedAtomic: '0',
        tonBalanceNano: '500000000',
      }),
    );
    expect(below.maxByHotJw).toBe(0);
    expect(below.executableNow).toBe(0);
    expect(below.bindingConstraint).toBe('hot_jw');
  });

  it('native TON below planner min (50_000_000 nano) → ton_gas capacity 0', () => {
    const plan = planPhase10SuccessBatch(
      baseCapacity({
        tonBalanceNano: '49999999',
        hotJwOnChainAtomic: '100000000',
        userAvailableAtomic: '100000000',
        authorizedMaxAdditional: 49,
        userDailyConsumedAtomic: '0',
        userHourlyMaxAtomic: '5000000',
      }),
    );
    expect(plan.executableNow).toBe(0);
    expect(plan.bindingConstraint).toBe('ton_gas');
  });

  it('healthy matching ledger/JW inventory yields positive hot_jw capacity', () => {
    const plan = planPhase10SuccessBatch(
      baseCapacity({
        hotJwOnChainAtomic: '6000000',
        hotLedgerAtomic: '6000000',
        userAvailableAtomic: '5000000',
        tonBalanceNano: '7996652224',
        authorizedMaxAdditional: 49,
        userDailyConsumedAtomic: '0',
        userHourlyConsumedAtomic: '0',
        userHourlyMaxAtomic: '5000000',
      }),
    );
    expect(plan.maxByHotJw).toBe(31); // floor(6000000/190000)
    expect(plan.executableNow).toBeGreaterThan(0);
    expect(plan.bindingConstraint).not.toBe('hot_jw');
    expect(plan.bindingConstraint).not.toBe('ton_gas');
  });
});

describe('phase10 batch pre-start safety', () => {
  it('requires safe defaults before opening window', () => {
    const ok = assertPhase10BatchPreStart({
      pauseEnabled: true,
      realChainEnabled: false,
      fakeChainEnabled: false,
      signerCustody: 'LOCKED',
      hotLedgerMatchesOnChain: true,
      runnerLockHeld: true,
      duplicateRunnerDetected: false,
    });
    expect(ok).toEqual({ ok: true });
  });

  it('refuses duplicate runner and accounting mismatch', () => {
    expect(
      assertPhase10BatchPreStart({
        pauseEnabled: true,
        realChainEnabled: false,
        fakeChainEnabled: false,
        signerCustody: 'LOCKED',
        hotLedgerMatchesOnChain: true,
        runnerLockHeld: false,
        duplicateRunnerDetected: true,
      }).ok,
    ).toBe(false);
    expect(
      assertPhase10BatchPreStart({
        pauseEnabled: true,
        realChainEnabled: false,
        fakeChainEnabled: false,
        signerCustody: 'LOCKED',
        hotLedgerMatchesOnChain: false,
        runnerLockHeld: true,
        duplicateRunnerDetected: false,
      }),
    ).toMatchObject({ ok: false, reason: 'accounting_mismatch' });
  });

  it('ledger/provider or TonAPI/TonCenter disagreement → accounting_mismatch before any payout', () => {
    // Authoritative pre-start gate: any disagreement among ledger / TonAPI / TonCenter
    // must set hotLedgerMatchesOnChain=false (computed by caller from dual RO probes).
    const ledger = 6_000_000n;
    const tonApi = 6_000_000n;
    const tonCenter = 5_810_000n;
    const observed = [ledger, tonApi, tonCenter];
    const match = observed.every((balance) => balance === observed[0]);
    expect(match).toBe(false);
    const gate = assertPhase10BatchPreStart({
      pauseEnabled: true,
      realChainEnabled: false,
      fakeChainEnabled: false,
      signerCustody: 'LOCKED',
      hotLedgerMatchesOnChain: match,
      runnerLockHeld: true,
      duplicateRunnerDetected: false,
    });
    expect(gate).toEqual({ ok: false, reason: 'accounting_mismatch' });
  });

  it('refuses if REAL already true or signer unlocked at pre-start', () => {
    expect(
      assertPhase10BatchPreStart({
        pauseEnabled: true,
        realChainEnabled: true,
        fakeChainEnabled: false,
        signerCustody: 'LOCKED',
        hotLedgerMatchesOnChain: true,
        runnerLockHeld: true,
        duplicateRunnerDetected: false,
      }).ok,
    ).toBe(false);
    expect(
      assertPhase10BatchPreStart({
        pauseEnabled: true,
        realChainEnabled: false,
        fakeChainEnabled: false,
        signerCustody: 'UNLOCKED',
        hotLedgerMatchesOnChain: true,
        runnerLockHeld: true,
        duplicateRunnerDetected: false,
      }).ok,
    ).toBe(false);
  });
});

describe('phase10 batch terminal classification', () => {
  it('continues only on CONFIRMED+settled with dual agree', () => {
    expect(
      classifyTerminalPayoutState({
        withdrawalState: 'CONFIRMED',
        broadcastResultState: 'BROADCASTED',
        settled: true,
        dualProviderAgree: true,
        provider429Exhausted: false,
      }),
    ).toEqual({ continueBatch: true, stopReason: null });
  });

  it('stops on ambiguous broadcast / reconcile / 429 / disagree', () => {
    expect(
      classifyTerminalPayoutState({
        withdrawalState: 'CONFIRMING',
        broadcastResultState: 'UNKNOWN',
        settled: false,
        dualProviderAgree: null,
        provider429Exhausted: false,
      }).stopReason,
    ).toBe('ambiguous_broadcast');
    expect(
      classifyTerminalPayoutState({
        withdrawalState: 'RECONCILE_REQUIRED',
        broadcastResultState: 'RECONCILE_REQUIRED',
        settled: false,
        dualProviderAgree: null,
        provider429Exhausted: false,
      }).stopReason,
    ).toBe('ambiguous_broadcast');
    expect(
      classifyTerminalPayoutState({
        withdrawalState: 'CONFIRMING',
        broadcastResultState: 'BROADCASTED',
        settled: false,
        dualProviderAgree: false,
        provider429Exhausted: false,
      }).stopReason,
    ).toBe('provider_disagree');
    expect(
      classifyTerminalPayoutState({
        withdrawalState: 'CONFIRMING',
        broadcastResultState: 'BROADCASTED',
        settled: false,
        dualProviderAgree: null,
        provider429Exhausted: true,
      }).stopReason,
    ).toBe('provider_429_exhausted');
  });

  it('stops if CONFIRMED without settlement', () => {
    expect(
      classifyTerminalPayoutState({
        withdrawalState: 'CONFIRMED',
        broadcastResultState: 'BROADCASTED',
        settled: false,
        dualProviderAgree: true,
        provider429Exhausted: false,
      }).stopReason,
    ).toBe('settlement_failed');
  });
});

describe('phase10 batch hourly pacing', () => {
  it('enforces max 25 per hour', () => {
    expect(PHASE10_SUCCESS_BATCH_MAX_PER_HOUR).toBe(25);
    expect(shouldStopForHourlyCap(24, 25)).toBe(false);
    expect(shouldStopForHourlyCap(25, 25)).toBe(true);
    expect(
      nextBatchStopAfterSuccess({
        completedInBatch: 25,
        executableNow: 49,
        completedInHour: 25,
        hourlyMaxPayouts: 25,
      }),
    ).toBe('user_hourly_cap');
    expect(
      nextBatchStopAfterSuccess({
        completedInBatch: 49,
        executableNow: 49,
        completedInHour: 24,
        hourlyMaxPayouts: 25,
      }),
    ).toBe('completed_target');
  });
});
