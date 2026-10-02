/**
 * Concrete ReadOnlyMainnetFeeProvider for Toncenter Mainnet (Phase 21).
 * Never broadcasts. Forward remains 1 nanogram at estimator layer; attached ESTIMATED.
 */
import { TON_MAINNET_NETWORK_GLOBAL_ID } from './chain-provider.js';
import { ToncenterMainnetReadonlyClient } from './toncenter-mainnet-readonly.js';

export interface ToncenterMainnetFeeProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly expectedNetworkGlobalId?: number | null;
  /** Optional address used for estimateFee; Owner-supplied when live. */
  readonly estimateAddress?: string | null;
}

/**
 * Duck-types signing ReadOnlyMainnetFeeProvider.estimate().
 * Throws or returns null fees ? caller maps to UNAVAILABLE.
 */
export class ToncenterMainnetFeeProvider {
  private readonly client: ToncenterMainnetReadonlyClient;
  private readonly estimateAddress: string | null;

  constructor(config: ToncenterMainnetFeeProviderConfig) {
    this.client = new ToncenterMainnetReadonlyClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? null,
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
      expectedNetworkGlobalId:
        config.expectedNetworkGlobalId ?? TON_MAINNET_NETWORK_GLOBAL_ID,
    });
    this.estimateAddress = config.estimateAddress?.trim() || null;
  }

  async estimate(input: {
    readonly networkCode: 'TON_MAINNET';
    readonly networkGlobalId: -239;
    readonly jettonMasterIdentity: string;
    readonly netAmountAtomic: bigint;
    readonly forwardTonAtomic?: bigint;
  }): Promise<{
    attachedTonAtomicEstimated: bigint | null;
    estimatedFeeNativeAtomic?: bigint | null;
    providerKind: string;
    providerHost: string;
    networkIdentity: string;
    estimateMethod: string;
  }> {
    void input.netAmountAtomic;
    void input.forwardTonAtomic;
    void input.jettonMasterIdentity;

    const identity = await this.client.probeNetworkIdentity();
    if (!identity.ok || identity.networkGlobalId !== TON_MAINNET_NETWORK_GLOBAL_ID) {
      throw new Error(
        `ToncenterMainnetFeeProvider identity incomplete: ${identity.message}`,
      );
    }

    if (this.estimateAddress === null) {
      throw new Error(
        'ToncenterMainnetFeeProvider: estimateAddress not configured; fee UNAVAILABLE',
      );
    }

    const fee = await this.client.estimateFeeNanotons({ address: this.estimateAddress });
    if (!fee.ok || fee.feeNanotons === null) {
      throw new Error(
        `Toncenter estimateFee UNAVAILABLE: ${fee.message}`,
      );
    }

    // Attached remains ESTIMATED at estimator layer; we only return native fee estimate.
    return {
      attachedTonAtomicEstimated: fee.feeNanotons,
      estimatedFeeNativeAtomic: fee.feeNanotons,
      providerKind: 'toncenter',
      providerHost: this.client.providerHost,
      networkIdentity: '-239',
      estimateMethod: fee.estimateMethod,
    };
  }
}
