/**
 * Phase 21 — read-only Mainnet jetton transfer fee estimation interface.
 *
 * Never broadcasts. Never mutates chain state. Live RPC optional behind explicit flag.
 * Attached GRAM remains ESTIMATED / OWNER_DECISION_REQUIRED until Owner activates.
 */
import { PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC } from './gram-native-currency.js';
import { PHASE21_ATTACHED_GRAM_POLICY_STATUS, type AttachedGramLifecycleStatus } from './jetton-transfer-policy.js';

export interface MainnetFeeEstimationInput {
  readonly networkCode: 'TON_MAINNET';
  readonly networkGlobalId: -239;
  readonly jettonMasterIdentity: string;
  readonly netAmountAtomic: bigint;
  /** Optional; defaults to Owner-approved 1 nanogram. */
  readonly forwardTonAtomic?: bigint;
}

export interface MainnetFeeEstimationResult {
  readonly mode: 'MOCK' | 'LIVE_READ_ONLY';
  readonly forwardTonAtomic: bigint;
  readonly attachedTonAtomicEstimated: bigint | null;
  readonly attachedGramLifecycle: AttachedGramLifecycleStatus;
  readonly estimatedTotalNativeAtomic: bigint | null;
  readonly broadcast: false;
  readonly notes: readonly string[];
}

export interface MainnetFeeEstimator {
  estimate(input: MainnetFeeEstimationInput): Promise<MainnetFeeEstimationResult>;
}

/** Deterministic mock estimator for unit tests / offline readiness. */
export class MockMainnetFeeEstimator implements MainnetFeeEstimator {
  constructor(
    private readonly estimatedAttachedAtomic: bigint | null = null,
  ) {}

  async estimate(input: MainnetFeeEstimationInput): Promise<MainnetFeeEstimationResult> {
    if (input.networkCode !== 'TON_MAINNET' || input.networkGlobalId !== -239) {
      throw new Error('MockMainnetFeeEstimator only supports TON_MAINNET / -239');
    }
    const forward =
      input.forwardTonAtomic ?? PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC;
    const attached = this.estimatedAttachedAtomic;
    return {
      mode: 'MOCK',
      forwardTonAtomic: forward,
      attachedTonAtomicEstimated: attached,
      attachedGramLifecycle: PHASE21_ATTACHED_GRAM_POLICY_STATUS,
      estimatedTotalNativeAtomic:
        attached === null ? null : attached + forward,
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
 */
export class LiveOptionalMainnetFeeEstimator implements MainnetFeeEstimator {
  constructor(private readonly mockFallback: MainnetFeeEstimator = new MockMainnetFeeEstimator()) {}

  async estimate(input: MainnetFeeEstimationInput): Promise<MainnetFeeEstimationResult> {
    const live = process.env.PHASE21_FEE_ESTIMATION_LIVE === '1';
    if (!live) {
      const mocked = await this.mockFallback.estimate(input);
      return { ...mocked, mode: 'MOCK' };
    }
    // Live path intentionally does not call RPC in Step 3 source — keep fail-closed mock shape.
    const mocked = await this.mockFallback.estimate(input);
    return {
      ...mocked,
      mode: 'LIVE_READ_ONLY',
      notes: [
        ...mocked.notes,
        'PHASE21_FEE_ESTIMATION_LIVE=1 set; Step 3 still returns non-broadcast estimate shell',
      ],
    };
  }
}
