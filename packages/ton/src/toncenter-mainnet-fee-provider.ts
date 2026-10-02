/**
 * Concrete ReadOnlyMainnetFeeProvider for Toncenter Mainnet (Phase 21 Step 3C).
 * Builds an unsigned Jetton transfer body and calls estimateFee — never signs / never sendBoc.
 *
 * Field separation (no double-counting):
 * - estimatedNetworkFeeAtomic: provider estimateFee total (network fee)
 * - candidateAttachedGramAtomic: candidate for body / gas attachment (NOT Owner-approved)
 * - forwardGramAtomic: Owner-approved 1 nanogram forward
 * - estimatedTotalNativeExposureAtomic: candidateAttached + forward
 *   (gas attachment exposure; network fee reported separately — not added here)
 */
import {
  PHASE21_FEE_ESTIMATE_CANDIDATE_ATTACHED_GRAM_ATOMIC,
  buildUnsignedJettonTransferBodyBase64,
} from './jetton-transfer-body.js';
import { TON_MAINNET_NETWORK_GLOBAL_ID } from './chain-provider.js';
import { ToncenterMainnetReadonlyClient } from './toncenter-mainnet-readonly.js';

export interface ToncenterMainnetFeeProviderConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly expectedNetworkGlobalId?: number | null;
  /** Optional address used for estimateFee; Owner-supplied when live (Hot Wallet). */
  readonly estimateAddress?: string | null;
  /**
   * Candidate attached GRAM for unsigned body construction only.
   * Default PHASE21_FEE_ESTIMATE_CANDIDATE_ATTACHED_GRAM_ATOMIC (50_000_000n).
   * NOT Owner-approved Mainnet attached policy.
   */
  readonly candidateAttachedTonAtomic?: bigint | null;
}

export interface ToncenterMainnetFeeEstimateResult {
  readonly estimatedNetworkFeeAtomic: bigint | null;
  readonly candidateAttachedGramAtomic: bigint | null;
  readonly forwardGramAtomic: bigint;
  readonly estimatedTotalNativeExposureAtomic: bigint | null;
  readonly emulationMethod: string;
  readonly mode: 'LIVE_READ_ONLY';
  readonly attachedGramLifecycle: 'ESTIMATED';
  readonly broadcast: false;
  /** @deprecated Prefer candidateAttachedGramAtomic — kept for ReadOnlyMainnetFeeProvider duck-type. */
  readonly attachedTonAtomicEstimated: bigint | null;
  /** @deprecated Prefer estimatedNetworkFeeAtomic. */
  readonly estimatedFeeNativeAtomic: bigint | null;
  readonly providerKind: string;
  readonly providerHost: string;
  readonly networkIdentity: string;
  readonly estimateMethod: string;
}

/** Owner-approved forward (1 nanogram). */
const FORWARD_GRAM_ATOMIC = 1n;

export class ToncenterMainnetFeeProvider {
  private readonly client: ToncenterMainnetReadonlyClient;
  private readonly estimateAddress: string | null;
  private readonly candidateAttached: bigint;

  constructor(config: ToncenterMainnetFeeProviderConfig) {
    this.client = new ToncenterMainnetReadonlyClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? null,
      ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
      expectedNetworkGlobalId:
        config.expectedNetworkGlobalId ?? TON_MAINNET_NETWORK_GLOBAL_ID,
    });
    this.estimateAddress = config.estimateAddress?.trim() || null;
    this.candidateAttached =
      config.candidateAttachedTonAtomic ?? PHASE21_FEE_ESTIMATE_CANDIDATE_ATTACHED_GRAM_ATOMIC;
  }

  async estimate(input: {
    readonly networkCode: 'TON_MAINNET';
    readonly networkGlobalId: -239;
    readonly jettonMasterIdentity: string;
    readonly netAmountAtomic: bigint;
    readonly forwardTonAtomic?: bigint;
    readonly destinationAddress?: string;
    readonly responseDestination?: string;
    readonly queryId?: bigint;
    readonly candidateAttachedTonAtomic?: bigint;
  }): Promise<ToncenterMainnetFeeEstimateResult> {
    const forward = input.forwardTonAtomic ?? FORWARD_GRAM_ATOMIC;
    const candidate =
      input.candidateAttachedTonAtomic ?? this.candidateAttached;

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

    const destination =
      input.destinationAddress?.trim() || this.estimateAddress;
    const responseDestination =
      input.responseDestination?.trim() || this.estimateAddress;
    const queryId = input.queryId ?? 0n;

    // Unsigned body only — never sign, never sendBoc.
    // jettonMasterIdentity is required for provenance; body encodes amount/forward/dest.
    void input.jettonMasterIdentity;
    const bodyBase64 = buildUnsignedJettonTransferBodyBase64({
      queryId,
      netAmountAtomic: input.netAmountAtomic,
      destinationAddress: destination,
      responseDestinationAddress: responseDestination,
      forwardTonAtomic: forward,
    });

    const fee = await this.client.estimateFeeNanotons({
      address: this.estimateAddress,
      bodyBase64,
    });
    if (!fee.ok || fee.feeNanotons === null) {
      throw new Error(`Toncenter estimateFee UNAVAILABLE: ${fee.message}`);
    }

    const exposure = candidate + forward;

    return {
      estimatedNetworkFeeAtomic: fee.feeNanotons,
      candidateAttachedGramAtomic: candidate,
      forwardGramAtomic: forward,
      estimatedTotalNativeExposureAtomic: exposure,
      emulationMethod: 'toncenter_estimateFee_unsigned_jetton_body',
      mode: 'LIVE_READ_ONLY',
      attachedGramLifecycle: 'ESTIMATED',
      broadcast: false,
      attachedTonAtomicEstimated: candidate,
      estimatedFeeNativeAtomic: fee.feeNanotons,
      providerKind: 'toncenter',
      providerHost: this.client.providerHost,
      networkIdentity: '-239',
      estimateMethod: fee.estimateMethod,
    };
  }
}
