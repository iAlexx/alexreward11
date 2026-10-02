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
    expect(result.forwardTonAtomic).toBe(PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC);
    expect(result.attachedTonAtomicEstimated).toBe(60_000_000n);
    expect(result.attachedGramLifecycle).toBe(PHASE21_ATTACHED_GRAM_POLICY_STATUS);
    expect(result.attachedGramLifecycle).toBe('ESTIMATED');
    expect(result.estimatedTotalNativeAtomic).toBe(60_000_001n);
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
    expect(result.attachedTonAtomicEstimated).toBeNull();
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

  it('LIVE=1 with injected Mainnet provider returns LIVE_READ_ONLY provenance', async () => {
    process.env.PHASE21_FEE_ESTIMATION_LIVE = '1';
    const provider: ReadOnlyMainnetFeeProvider = {
      async estimate() {
        return {
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
    expect(result.attachedTonAtomicEstimated).toBe(50_000_000n);
  });
});
