import { afterEach, describe, expect, it } from 'vitest';

import {
  LiveOptionalMainnetFeeEstimator,
  MockMainnetFeeEstimator,
  PHASE21_ATTACHED_GRAM_POLICY_STATUS,
  PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC,
  type ReadOnlyMainnetFeeProvider,
} from '../src/index.js';

describe('mainnet fee estimation', () => {
  const prev = process.env.PHASE21_FEE_ESTIMATION_LIVE;

  afterEach(() => {
    if (prev === undefined) delete process.env.PHASE21_FEE_ESTIMATION_LIVE;
    else process.env.PHASE21_FEE_ESTIMATION_LIVE = prev;
  });

  it('mock estimator never broadcasts and keeps attached ESTIMATED', async () => {
    const estimator = new MockMainnetFeeEstimator(60_000_000n);
    const result = await estimator.estimate({
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      jettonMasterIdentity: 'EQ_PHASE21_TEST_ONLY_MAINNET_USDT_MASTER',
      netAmountAtomic: 200_000n,
    });
    expect(result.broadcast).toBe(false);
    expect(result.mode).toBe('MOCK');
    expect(result.forwardGramAtomic).toBe(PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC);
    expect(result.candidateAttachedGramAtomic).toBe(60_000_000n);
    expect(result.estimatedNetworkFeeAtomic).toBeNull();
    expect(result.attachedGramLifecycle).toBe(PHASE21_ATTACHED_GRAM_POLICY_STATUS);
    expect(result.attachedGramLifecycle).toBe('ESTIMATED');
    expect(result.estimatedTotalNativeExposureAtomic).toBe(60_000_001n);
    // fee not double-counted into exposure
    expect(result.estimatedTotalNativeExposureAtomic).toBe(
      (result.candidateAttachedGramAtomic ?? 0n) + result.forwardGramAtomic,
    );
  });

  it('rejects non-Mainnet input', async () => {
    const estimator = new MockMainnetFeeEstimator();
    await expect(
      estimator.estimate({
        networkCode: 'TON_MAINNET',
        networkGlobalId: -3 as unknown as -239,
        jettonMasterIdentity: 'x',
        netAmountAtomic: 1n,
      }),
    ).rejects.toThrow(/only supports TON_MAINNET/);
  });

  it('live optional stays non-broadcast and defaults to MOCK without flag', async () => {
    delete process.env.PHASE21_FEE_ESTIMATION_LIVE;
    const estimator = new LiveOptionalMainnetFeeEstimator(new MockMainnetFeeEstimator(null));
    const result = await estimator.estimate({
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      jettonMasterIdentity: 'EQ_PHASE21_TEST_ONLY_MAINNET_USDT_MASTER',
      netAmountAtomic: 1n,
    });
    expect(result.mode).toBe('MOCK');
    expect(result.broadcast).toBe(false);
    expect(result.attachedGramLifecycle).toBe('ESTIMATED');
  });

  it('LIVE=1 without provider returns UNAVAILABLE (never relabels mock)', async () => {
    process.env.PHASE21_FEE_ESTIMATION_LIVE = '1';
    const estimator = new LiveOptionalMainnetFeeEstimator();
    const result = await estimator.estimate({
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      jettonMasterIdentity: 'EQ_PHASE21_TEST_ONLY_MAINNET_USDT_MASTER',
      netAmountAtomic: 1n,
    });
    expect(result.mode).toBe('UNAVAILABLE');
    expect(result.broadcast).toBe(false);
    expect(result.attachedGramLifecycle).toBe('ESTIMATED');
    expect(result.candidateAttachedGramAtomic).toBeNull();
  });

  it('LIVE=1 with failing provider returns UNAVAILABLE', async () => {
    process.env.PHASE21_FEE_ESTIMATION_LIVE = '1';
    const failing: ReadOnlyMainnetFeeProvider = {
      async estimate() {
        throw new Error('rpc down');
      },
    };
    const estimator = new LiveOptionalMainnetFeeEstimator(new MockMainnetFeeEstimator(), failing);
    const result = await estimator.estimate({
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      jettonMasterIdentity: 'EQ_PHASE21_TEST_ONLY_MAINNET_USDT_MASTER',
      netAmountAtomic: 1n,
    });
    expect(result.mode).toBe('UNAVAILABLE');
    expect(result.broadcast).toBe(false);
  });

  it('LIVE=1 with injected Mainnet provider returns LIVE_READ_ONLY without double-counting fee', async () => {
    process.env.PHASE21_FEE_ESTIMATION_LIVE = '1';
    const provider: ReadOnlyMainnetFeeProvider = {
      async estimate() {
        return {
          estimatedNetworkFeeAtomic: 1_000n,
          candidateAttachedGramAtomic: 50_000_000n,
          forwardGramAtomic: 1n,
          estimatedTotalNativeExposureAtomic: 50_000_001n,
          emulationMethod: 'toncenter_estimateFee_unsigned_jetton_body',
          attachedTonAtomicEstimated: 50_000_000n,
          estimatedFeeNativeAtomic: 1_000n,
          providerKind: 'toncenter',
          providerHost: 'toncenter.example',
          networkIdentity: '-239',
          estimateMethod: 'estimateFee',
        };
      },
    };
    const estimator = new LiveOptionalMainnetFeeEstimator(new MockMainnetFeeEstimator(), provider);
    const result = await estimator.estimate({
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      jettonMasterIdentity: 'EQ_PHASE21_TEST_ONLY_MAINNET_USDT_MASTER',
      netAmountAtomic: 1n,
    });
    expect(result.mode).toBe('LIVE_READ_ONLY');
    expect(result.broadcast).toBe(false);
    expect(result.attachedGramLifecycle).toBe('ESTIMATED');
    expect(result.providerKind).toBe('toncenter');
    expect(result.providerHost).toBe('toncenter.example');
    expect(result.networkIdentity).toBe('-239');
    expect(result.estimateMethod).toBe('estimateFee');
    expect(result.walletVersion).toBe('v5R1');
    expect(result.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.candidateAttachedGramAtomic).toBe(50_000_000n);
    expect(result.estimatedNetworkFeeAtomic).toBe(1_000n);
    expect(result.estimatedTotalNativeExposureAtomic).toBe(50_000_001n);
    expect(result.estimatedTotalNativeExposureAtomic).not.toBe(50_001_001n);
  });
});
