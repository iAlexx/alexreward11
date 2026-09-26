/**
 * Phase 10 final-campaign-slot occupancy gate (read-only decision helpers).
 *
 * A CONFIRMED + settled + IPP withdrawal that is outside the current campaign
 * evidence set normally blocks the final acceptance slot as a "hidden ready"
 * payout. Explicit historical baseline attempts listed on the campaign as
 * `baselineIsolatedHistoricalAttemptIds` are excluded from that occupancy gate
 * only — they remain preserved economic history and must never be attached,
 * deleted, or assigned campaign ordinals by this helper.
 *
 * Fail closed: missing/malformed allowlist or missing attempt id → do not exclude.
 */

export interface Phase10HiddenReadyCandidate {
  readonly withdrawalId: string;
  readonly publicId: string | null;
  /** Latest (or only) attempt id used for baseline allowlist matching. */
  readonly attemptId: string | null;
  readonly state: string;
  readonly settled: boolean;
  readonly hasIpp: boolean;
  /** True when withdrawalId is already in the campaign withdrawalIds / evidence. */
  readonly inCampaign: boolean;
}

export interface Phase10FinalSlotOccupancyResult {
  /** Candidates that still block the final campaign slot after baseline exclusion. */
  readonly blockers: readonly Phase10HiddenReadyCandidate[];
  /** Candidates ignored solely because attemptId ∈ baselineIsolatedHistoricalAttemptIds. */
  readonly excludedHistoricalBaseline: readonly Phase10HiddenReadyCandidate[];
  /** Count of non-baseline hidden-ready blockers (0 ⇒ no occupancy hard-stop from this gate). */
  readonly nonBaselineHiddenReadyCount: number;
  /**
   * Capacity hard-stop contribution: 0 when any non-baseline blocker remains,
   * otherwise positive infinity (caller mins with other caps).
   */
  readonly hiddenReadyHardCap: number;
}

function normalizeAllowlist(
  baselineIsolatedHistoricalAttemptIds: readonly string[] | null | undefined,
): ReadonlySet<string> | null {
  if (baselineIsolatedHistoricalAttemptIds === null) return null;
  if (baselineIsolatedHistoricalAttemptIds === undefined) return null;
  if (!Array.isArray(baselineIsolatedHistoricalAttemptIds)) return null;
  const ids = baselineIsolatedHistoricalAttemptIds.filter(
    (id): id is string => typeof id === 'string' && id.trim() !== '',
  );
  // Malformed-only lists (non-empty array but zero usable ids) → fail closed.
  if (baselineIsolatedHistoricalAttemptIds.length > 0 && ids.length === 0) {
    return null;
  }
  return new Set(ids.map((id) => id.trim()));
}

/**
 * Returns true only when attemptId is an exact member of a usable allowlist.
 * Fail closed on missing attempt id or missing/malformed allowlist.
 */
export function isBaselineIsolatedHistoricalAttemptId(
  attemptId: string | null | undefined,
  baselineIsolatedHistoricalAttemptIds: readonly string[] | null | undefined,
): boolean {
  if (typeof attemptId !== 'string' || attemptId.trim() === '') {
    return false;
  }
  const allow = normalizeAllowlist(baselineIsolatedHistoricalAttemptIds);
  if (allow === null) {
    return false;
  }
  return allow.has(attemptId.trim());
}

/**
 * True when the candidate is a CONFIRMED+settled+IPP outside-campaign payout
 * that should occupy/block the final acceptance slot.
 *
 * Historical baseline attempts listed in `baselineIsolatedHistoricalAttemptIds`
 * return false (do not occupy / do not block).
 */
export function isHiddenReadyFinalSlotOccupancyBlocker(
  candidate: Phase10HiddenReadyCandidate,
  options: {
    readonly baselineIsolatedHistoricalAttemptIds?: readonly string[] | null;
  } = {},
): boolean {
  if (candidate.inCampaign) return false;
  if (candidate.state !== 'CONFIRMED') return false;
  if (candidate.settled !== true) return false;
  if (candidate.hasIpp !== true) return false;

  if (
    isBaselineIsolatedHistoricalAttemptId(
      candidate.attemptId,
      options.baselineIsolatedHistoricalAttemptIds,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Partition outside-campaign CONFIRMED+settled+IPP candidates into blockers vs
 * excluded historical baselines. Does not mutate inputs or campaign evidence.
 */
export function evaluatePhase10FinalSlotOccupancy(input: {
  readonly candidates: readonly Phase10HiddenReadyCandidate[];
  readonly baselineIsolatedHistoricalAttemptIds?: readonly string[] | null;
}): Phase10FinalSlotOccupancyResult {
  const blockers: Phase10HiddenReadyCandidate[] = [];
  const excludedHistoricalBaseline: Phase10HiddenReadyCandidate[] = [];
  const opts: {
    readonly baselineIsolatedHistoricalAttemptIds?: readonly string[] | null;
  } =
    input.baselineIsolatedHistoricalAttemptIds !== undefined
      ? { baselineIsolatedHistoricalAttemptIds: input.baselineIsolatedHistoricalAttemptIds }
      : {};

  for (const candidate of input.candidates) {
    const isReadyShape =
      candidate.inCampaign === false &&
      candidate.state === 'CONFIRMED' &&
      candidate.settled === true &&
      candidate.hasIpp === true;
    if (!isReadyShape) {
      continue;
    }
    if (
      isBaselineIsolatedHistoricalAttemptId(
        candidate.attemptId,
        input.baselineIsolatedHistoricalAttemptIds,
      )
    ) {
      excludedHistoricalBaseline.push(candidate);
      continue;
    }
    if (isHiddenReadyFinalSlotOccupancyBlocker(candidate, opts)) {
      blockers.push(candidate);
    }
  }

  return {
    blockers,
    excludedHistoricalBaseline,
    nonBaselineHiddenReadyCount: blockers.length,
    hiddenReadyHardCap: blockers.length > 0 ? 0 : Number.POSITIVE_INFINITY,
  };
}
