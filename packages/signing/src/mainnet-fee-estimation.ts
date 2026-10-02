/**
 * Phase 21 — read-only Mainnet jetton transfer fee estimation interface.
 *
 * Never broadcasts. Never mutates chain state. Live RPC optional behind explicit flag.
 * Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED until Owner activates.
 * LIVE_READ_ONLY is only returned when an injected read-only provider succeeds with
 * Mainnet network identity — never by relabeling mock estimates.
 */
import { PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC } from './gram-native-currency.js';
import {
  PHASE21_ATTACHED_GRAM_POLICY_STATUS,
  type AttachedGramLifecycleStatus,
} from './jetton-transfer-policy.js';

export interface MainnetFeeEstimationInput {
  readonly networkCode: 'TON_MAINNET';
  readonly networkGlobalId: -239;
  readonly jettonMasterIdentity: string;
  readonly netAmountAtomic: bigint;
  /** Optional; defaults to Owner-approved 1 nanogram. */
  readonly forwardTonAtomic?: bigint;
}

export interface MainnetFeeEstimationResult {
  readonly mode: 'MOCK' | 'LIVE_READ_ONLY' | 'UNAVAILABLE';
  readonly forwardTonAtomic: bigint;
  readonly attachedTonAtomicEstimated: bigint | null;
  readonly attachedGramLifecycle: AttachedGramLifecycleStatus;
  readonly estimatedTotalNativeAtomic: bigint | null;
  readonly broadcast: false;
  readonly notes: readonly string[];
  readonly providerKind?: string;
  /** Sanitized hostname only — never credentials or full URL. */
  readonly providerHost?: string;
  /** e.g. '-239' proving Mainnet. */
  readonly networkIdentity?: string;
  readonly observedAt?: string;
  readonly estimateMethod?: string;
  readonly walletVersion?: string;
  readonly jettonMaster?: string;
}

export interface MainnetFeeEstimator {
  estimate(input: MainnetFeeEstimationInput): Promise<MainnetFeeEstimationResult>;
}

/**
 * Injectable read-only fee provider. Implementations must never broadcast.
 * networkIdentity must prove Mainnet (e.g. '-239').
 */
export interface ReadOnlyMainnetFeeProvider {
  estimate(input: MainnetFeeEstimationInput): Promise<{
    attachedTonAtomicEstimated: bigint | null;
    estimatedFeeNativeAtomic?: bigint | null;
    providerKind: string;
    /** Hostname only, no credentials. */
    providerHost: string;
    /** Must be '-239' or equivalent Mainnet proof. */
    networkIdentity: string;
    estimateMethod: string;
  }>;
}

function isMainnetNetworkIdentity(identity: string): boolean {
  const trimmed = identity.trim();
  return trimmed === '-239' || trimmed === 'ton:mainnet' || trimmed.toUpperCase() === 'MAINNET';
}

/** Deterministic mock estimator for unit tests / offline readiness. */
export class MockMainnetFeeEstimator implements MainnetFeeEstimator {
  constructor(private readonly estimatedAttachedAtomic: bigint | null = null) {}

  async estimate(input: MainnetFeeEstimationInput): Promise<MainnetFeeEstimationResult> {
    if (input.networkCode !== 'TON_MAINNET' || input.networkGlobalId !== -239) {
      throw new Error('MockMainnetFeeEstimator only supports TON_MAINNET / -239');
    }
    const forward = input.forwardTonAtomic ?? PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC;
    const attached = this.estimatedAttachedAtomic;
    return {
      mode: 'MOCK',
      forwardTonAtomic: forward,
      attachedTonAtomicEstimated: attached,
      attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
      estimatedTotalNativeAtomic: attached === null ? null : attached + forward,
      broadcast: false,
      notes: [
        'Read-only mock estimate; never broadcasts',
        'Attached GRAM lifecycle remains ESTIMATED / OWNER_DECISION_REQUIRED',
        'SPIKE 0.05 attached must not be treated as Mainnet Owner-approved',
      ],
    };
  }
}

/**
 * Optional live estimator — only runs when PHASE21_FEE_ESTIMATION_LIVE=1.
 * Still never broadcasts; returns ESTIMATED attached status.
 * Without an injected live provider, LIVE=1 yields UNAVAILABLE (never relabels mock).
 */
export class LiveOptionalMainnetFeeEstimator implements MainnetFeeEstimator {
  constructor(
    private readonly mockFallback: MainnetFeeEstimator = new MockMainnetFeeEstimator(),
    private readonly liveProvider: ReadOnlyMainnetFeeProvider | null = null,
  ) {}

  async estimate(input: MainnetFeeEstimationInput): Promise<MainnetFeeEstimationResult> {
    if (input.networkCode !== 'TON_MAINNET' || input.networkGlobalId !== -239) {
      throw new Error('LiveOptionalMainnetFeeEstimator only supports TON_MAINNET / -239');
    }
    const forward = input.forwardTonAtomic ?? PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC;
    const live = process.env.PHASE21_FEE_ESTIMATION_LIVE === '1';
    if (!live) {
      const mocked = await this.mockFallback.estimate(input);
      return { ...mocked, mode: 'MOCK', broadcast: false };
    }

    if (this.liveProvider === null) {
      return {
        mode: 'UNAVAILABLE',
        forwardTonAtomic: forward,
        attachedTonAtomicEstimated: null,
        attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
        estimatedTotalNativeAtomic: null,
        broadcast: false,
        notes: [
          'PHASE21_FEE_ESTIMATION_LIVE=1 set but no ReadOnlyMainnetFeeProvider injected',
          'Refusing to relabel mock estimates as LIVE_READ_ONLY',
          'Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED',
        ],
      };
    }

    try {
      const liveResult = await this.liveProvider.estimate(input);
      if (!isMainnetNetworkIdentity(liveResult.networkIdentity)) {
        return {
          mode: 'UNAVAILABLE',
          forwardTonAtomic: forward,
          attachedTonAtomicEstimated: null,
          attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
          estimatedTotalNativeAtomic: null,
          broadcast: false,
          providerKind: liveResult.providerKind,
          providerHost: liveResult.providerHost,
          networkIdentity: liveResult.networkIdentity,
          observedAt: new Date().toISOString(),
          estimateMethod: liveResult.estimateMethod,
          jettonMaster: input.jettonMasterIdentity,
          notes: [
            'Live fee provider returned non-Mainnet network identity; fail closed',
            'Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED',
          ],
        };
      }
      const attached = liveResult.attachedTonAtomicEstimated;
      const estimatedFee = liveResult.estimatedFeeNativeAtomic;
      const total =
        attached === null
          ? null
          : attached + forward + (estimatedFee === null || estimatedFee === undefined ? 0n : estimatedFee);
      return {
        mode: 'LIVE_READ_ONLY',
        forwardTonAtomic: forward,
        attachedTonAtomicEstimated: attached,
        attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
        estimatedTotalNativeAtomic: total,
        broadcast: false,
        providerKind: liveResult.providerKind,
        providerHost: liveResult.providerHost,
        networkIdentity: liveResult.networkIdentity,
        observedAt: new Date().toISOString(),
        estimateMethod: liveResult.estimateMethod,
        walletVersion: 'v5R1',
        jettonMaster: input.jettonMasterIdentity,
        notes: [
          'Read-only live Mainnet fee estimate; never broadcasts',
          'Attached GRAM lifecycle remains ESTIMATED / OWNER_DECISION_REQUIRED',
          'Never auto Owner-approves attached GRAM',
        ],
      };
    } catch (error: unknown) {
      return {
        mode: 'UNAVAILABLE',
        forwardTonAtomic: forward,
        attachedTonAtomicEstimated: null,
        attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
        estimatedTotalNativeAtomic: null,
        broadcast: false,
        observedAt: new Date().toISOString(),
        jettonMaster: input.jettonMasterIdentity,
        notes: [
          'Live fee provider failed; returning UNAVAILABLE (not MOCK relabeled)',
          error instanceof Error ? error.message : String(error),
          'Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED',
        ],
      };
    }
  }
}

export {
  ToncenterMainnetFeeProvider,
  type ToncenterMainnetFeeProviderConfig,
} from '@alex-rewards/ton';
