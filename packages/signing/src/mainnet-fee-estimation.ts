/**
 * Phase 21 — read-only Mainnet jetton transfer fee estimation interface.
 *
 * Never broadcasts. Never mutates chain state. Live RPC optional behind explicit flag.
 * Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED until Owner activates.
 * LIVE_READ_ONLY is only returned when an injected read-only provider succeeds with
 * Mainnet network identity — never by relabeling mock estimates.
 *
 * Field separation (Step 3C):
 * - estimatedNetworkFeeAtomic: provider network fee (separate)
 * - candidateAttachedGramAtomic: candidate gas attachment (NOT Owner-approved)
 * - forwardGramAtomic: Owner-approved 1 nanogram
 * - estimatedTotalNativeExposureAtomic: candidateAttached + forward
 *   (network fee NOT double-counted into exposure)
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
  /** Optional destination for unsigned Jetton body construction. */
  readonly destinationAddress?: string;
  /** Optional response destination (usually Hot Wallet). */
  readonly responseDestination?: string;
  readonly queryId?: bigint;
  /**
   * Candidate attached for body construction / exposure only.
   * NOT Owner-approved Mainnet attached policy.
   */
  readonly candidateAttachedTonAtomic?: bigint;
}

export interface MainnetFeeEstimationResult {
  readonly mode: 'MOCK' | 'LIVE_READ_ONLY' | 'UNAVAILABLE';
  readonly estimatedNetworkFeeAtomic: bigint | null;
  readonly candidateAttachedGramAtomic: bigint | null;
  readonly forwardGramAtomic: bigint;
  /**
   * Gas attachment exposure = candidateAttached + forward.
   * Network fee is reported separately and is NOT added here.
   */
  readonly estimatedTotalNativeExposureAtomic: bigint | null;
  readonly emulationMethod: string;
  readonly attachedGramLifecycle: AttachedGramLifecycleStatus;
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
  /** @deprecated Prefer forwardGramAtomic. */
  readonly forwardTonAtomic: bigint;
  /** @deprecated Prefer candidateAttachedGramAtomic. */
  readonly attachedTonAtomicEstimated: bigint | null;
  /** @deprecated Prefer estimatedTotalNativeExposureAtomic. */
  readonly estimatedTotalNativeAtomic: bigint | null;
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
    estimatedNetworkFeeAtomic?: bigint | null;
    candidateAttachedGramAtomic?: bigint | null;
    forwardGramAtomic?: bigint;
    estimatedTotalNativeExposureAtomic?: bigint | null;
    emulationMethod?: string;
    /** @deprecated Prefer candidateAttachedGramAtomic. */
    attachedTonAtomicEstimated: bigint | null;
    /** @deprecated Prefer estimatedNetworkFeeAtomic. */
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

function unavailableResult(
  forward: bigint,
  notes: readonly string[],
  extra: Partial<MainnetFeeEstimationResult> = {},
): MainnetFeeEstimationResult {
  return {
    mode: 'UNAVAILABLE',
    estimatedNetworkFeeAtomic: null,
    candidateAttachedGramAtomic: null,
    forwardGramAtomic: forward,
    estimatedTotalNativeExposureAtomic: null,
    emulationMethod: 'unavailable',
    attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
    broadcast: false,
    notes,
    forwardTonAtomic: forward,
    attachedTonAtomicEstimated: null,
    estimatedTotalNativeAtomic: null,
    ...extra,
  };
}

/** Deterministic mock estimator for unit tests / offline readiness. */
export class MockMainnetFeeEstimator implements MainnetFeeEstimator {
  constructor(private readonly estimatedAttachedAtomic: bigint | null = null) {}

  async estimate(input: MainnetFeeEstimationInput): Promise<MainnetFeeEstimationResult> {
    if (input.networkCode !== 'TON_MAINNET' || input.networkGlobalId !== -239) {
      throw new Error('MockMainnetFeeEstimator only supports TON_MAINNET / -239');
    }
    const forward = input.forwardTonAtomic ?? PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC;
    const attached = input.candidateAttachedTonAtomic ?? this.estimatedAttachedAtomic;
    const exposure = attached === null ? null : attached + forward;
    return {
      mode: 'MOCK',
      estimatedNetworkFeeAtomic: null,
      candidateAttachedGramAtomic: attached,
      forwardGramAtomic: forward,
      estimatedTotalNativeExposureAtomic: exposure,
      emulationMethod: 'mock',
      attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
      broadcast: false,
      forwardTonAtomic: forward,
      attachedTonAtomicEstimated: attached,
      estimatedTotalNativeAtomic: exposure,
      notes: [
        'Read-only mock estimate; never broadcasts',
        'Attached GRAM lifecycle remains ESTIMATED / OWNER_DECISION_REQUIRED',
        'SPIKE 0.05 attached must not be treated as Mainnet Owner-approved',
        'estimatedTotalNativeExposureAtomic = candidateAttached + forward (fee separate/null in MOCK)',
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
      return unavailableResult(forward, [
        'PHASE21_FEE_ESTIMATION_LIVE=1 set but no ReadOnlyMainnetFeeProvider injected',
        'Refusing to relabel mock estimates as LIVE_READ_ONLY',
        'Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED',
      ]);
    }

    try {
      const liveResult = await this.liveProvider.estimate(input);
      if (!isMainnetNetworkIdentity(liveResult.networkIdentity)) {
        return unavailableResult(
          forward,
          [
            'Live fee provider returned non-Mainnet network identity; fail closed',
            'Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED',
          ],
          {
            providerKind: liveResult.providerKind,
            providerHost: liveResult.providerHost,
            networkIdentity: liveResult.networkIdentity,
            observedAt: new Date().toISOString(),
            estimateMethod: liveResult.estimateMethod,
            jettonMaster: input.jettonMasterIdentity,
          },
        );
      }

      const networkFee =
        liveResult.estimatedNetworkFeeAtomic ?? liveResult.estimatedFeeNativeAtomic ?? null;
      const candidate =
        liveResult.candidateAttachedGramAtomic ?? liveResult.attachedTonAtomicEstimated;
      const forwardOut = liveResult.forwardGramAtomic ?? forward;
      const exposure =
        liveResult.estimatedTotalNativeExposureAtomic ??
        (candidate === null ? null : candidate + forwardOut);
      const emulation =
        liveResult.emulationMethod ?? liveResult.estimateMethod ?? 'live_provider';

      return {
        mode: 'LIVE_READ_ONLY',
        estimatedNetworkFeeAtomic: networkFee,
        candidateAttachedGramAtomic: candidate,
        forwardGramAtomic: forwardOut,
        estimatedTotalNativeExposureAtomic: exposure,
        emulationMethod: emulation,
        attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
        broadcast: false,
        providerKind: liveResult.providerKind,
        providerHost: liveResult.providerHost,
        networkIdentity: liveResult.networkIdentity,
        observedAt: new Date().toISOString(),
        estimateMethod: liveResult.estimateMethod,
        walletVersion: 'v5R1',
        jettonMaster: input.jettonMasterIdentity,
        forwardTonAtomic: forwardOut,
        attachedTonAtomicEstimated: candidate,
        estimatedTotalNativeAtomic: exposure,
        notes: [
          'Read-only live Mainnet fee estimate; never broadcasts',
          'Attached GRAM lifecycle remains ESTIMATED / OWNER_DECISION_REQUIRED',
          'Never auto Owner-approves attached GRAM',
          'estimatedTotalNativeExposureAtomic = candidateAttached + forward; network fee separate',
        ],
      };
    } catch (error: unknown) {
      return unavailableResult(
        forward,
        [
          'Live fee provider failed; returning UNAVAILABLE (not MOCK relabeled)',
          error instanceof Error ? error.message : String(error),
          'Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED',
        ],
        {
          observedAt: new Date().toISOString(),
          jettonMaster: input.jettonMasterIdentity,
        },
      );
    }
  }
}

export {
  ToncenterMainnetFeeProvider,
  type ToncenterMainnetFeeProviderConfig,
} from '@alex-rewards/ton';
