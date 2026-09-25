import { describe, expect, it } from 'vitest';

import {
  evaluatePhase10FinalSlotOccupancy,
  isBaselineIsolatedHistoricalAttemptId,
  isHiddenReadyFinalSlotOccupancyBlocker,
  type Phase10HiddenReadyCandidate,
} from '../src/phase10-final-slot-gate.js';

const BASELINE_ATTEMPT = '01a0cb5f-5337-715c-9969-a6e79f85b5cd';
const OTHER_ATTEMPT = '01a0d4cb-62cc-7618-9854-b1e29d96dca5';
const WD001 = '01a0cb5e-b72f-795d-b622-57eccb35183c';

function readyOutside(overrides: Partial<Phase10HiddenReadyCandidate> = {}): Phase10HiddenReadyCandidate {
  return {
    withdrawalId: WD001,
    publicId: 'WD-000001',
    attemptId: BASELINE_ATTEMPT,
    state: 'CONFIRMED',
    settled: true,
    hasIpp: true,
    inCampaign: false,
    ...overrides,
  };
}

describe('phase10 final-slot hidden-ready occupancy gate', () => {
  it('TEST1: historical baseline attemptId in allowlist does not occupy final slot', () => {
    const candidate = readyOutside();
    expect(
      isHiddenReadyFinalSlotOccupancyBlocker(candidate, {
        baselineIsolatedHistoricalAttemptIds: [BASELINE_ATTEMPT],
      }),
    ).toBe(false);

    const result = evaluatePhase10FinalSlotOccupancy({
      candidates: [candidate],
      baselineIsolatedHistoricalAttemptIds: [BASELINE_ATTEMPT],
    });
    expect(result.nonBaselineHiddenReadyCount).toBe(0);
    expect(result.blockers).toEqual([]);
    expect(result.excludedHistoricalBaseline).toHaveLength(1);
    expect(result.excludedHistoricalBaseline[0]?.attemptId).toBe(BASELINE_ATTEMPT);
    expect(result.hiddenReadyHardCap).toBe(Number.POSITIVE_INFINITY);
  });

  it('TEST2: identical ready shape without allowlisted attemptId still blocks', () => {
    const candidate = readyOutside({
      withdrawalId: '01a0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      publicId: 'WD-00XXXX',
      attemptId: OTHER_ATTEMPT,
    });
    expect(
      isHiddenReadyFinalSlotOccupancyBlocker(candidate, {
        baselineIsolatedHistoricalAttemptIds: [BASELINE_ATTEMPT],
      }),
    ).toBe(true);

    const result = evaluatePhase10FinalSlotOccupancy({
      candidates: [candidate],
      baselineIsolatedHistoricalAttemptIds: [BASELINE_ATTEMPT],
    });
    expect(result.nonBaselineHiddenReadyCount).toBe(1);
    expect(result.blockers[0]?.attemptId).toBe(OTHER_ATTEMPT);
    expect(result.hiddenReadyHardCap).toBe(0);
  });

  it('TEST3: missing/malformed allowlist fails closed (candidate remains blocker)', () => {
    const candidate = readyOutside();
    expect(isBaselineIsolatedHistoricalAttemptId(BASELINE_ATTEMPT, undefined)).toBe(false);
    expect(isBaselineIsolatedHistoricalAttemptId(BASELINE_ATTEMPT, null)).toBe(false);
    expect(isBaselineIsolatedHistoricalAttemptId(BASELINE_ATTEMPT, [''])).toBe(false);
    expect(isBaselineIsolatedHistoricalAttemptId(BASELINE_ATTEMPT, [123 as unknown as string])).toBe(
      false,
    );
    expect(isBaselineIsolatedHistoricalAttemptId(null, [BASELINE_ATTEMPT])).toBe(false);
    expect(isBaselineIsolatedHistoricalAttemptId('', [BASELINE_ATTEMPT])).toBe(false);

    expect(
      isHiddenReadyFinalSlotOccupancyBlocker(candidate, {
        baselineIsolatedHistoricalAttemptIds: null,
      }),
    ).toBe(true);
    expect(
      isHiddenReadyFinalSlotOccupancyBlocker(candidate, {
        baselineIsolatedHistoricalAttemptIds: null,
      }),
    ).toBe(true);
    expect(
      isHiddenReadyFinalSlotOccupancyBlocker(candidate, {
        baselineIsolatedHistoricalAttemptIds: [''],
      }),
    ).toBe(true);

    const result = evaluatePhase10FinalSlotOccupancy({
      candidates: [candidate],
      baselineIsolatedHistoricalAttemptIds: null,
    });
    expect(result.nonBaselineHiddenReadyCount).toBe(1);
    expect(result.hiddenReadyHardCap).toBe(0);
  });

  it('TEST4: WD-000001 exclusion is attempt-allowlist driven (not publicId special-case)', () => {
    // Same public ID / UUID, but attempt NOT on allowlist → still blocks.
    const spoof = readyOutside({ attemptId: OTHER_ATTEMPT });
    expect(
      isHiddenReadyFinalSlotOccupancyBlocker(spoof, {
        baselineIsolatedHistoricalAttemptIds: [BASELINE_ATTEMPT],
      }),
    ).toBe(true);

    // Different public ID, but allowlisted attempt → excluded (proves not publicId gate).
    const renamed = readyOutside({
      publicId: 'WD-HISTORICAL',
      withdrawalId: '01a0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      attemptId: BASELINE_ATTEMPT,
    });
    expect(
      isHiddenReadyFinalSlotOccupancyBlocker(renamed, {
        baselineIsolatedHistoricalAttemptIds: [BASELINE_ATTEMPT],
      }),
    ).toBe(false);
  });

  it('TEST5: evaluation does not invent campaign attachment or mutate candidates', () => {
    const candidate = readyOutside();
    const frozen = Object.freeze({ ...candidate });
    const allowlist = Object.freeze([BASELINE_ATTEMPT]);
    const before = structuredClone(frozen);

    const result = evaluatePhase10FinalSlotOccupancy({
      candidates: [frozen],
      baselineIsolatedHistoricalAttemptIds: allowlist,
    });

    expect(frozen).toEqual(before);
    expect(result.excludedHistoricalBaseline[0]?.inCampaign).toBe(false);
    expect(result.excludedHistoricalBaseline[0]?.publicId).toBe('WD-000001');
    // In-campaign ready rows are ignored entirely (already occupy an ordinal).
    const inCampaign = readyOutside({ inCampaign: true, attemptId: OTHER_ATTEMPT });
    const mixed = evaluatePhase10FinalSlotOccupancy({
      candidates: [frozen, inCampaign],
      baselineIsolatedHistoricalAttemptIds: allowlist,
    });
    expect(mixed.blockers).toEqual([]);
    expect(mixed.excludedHistoricalBaseline).toHaveLength(1);
  });

  it('mixed: baseline excluded while unrelated hidden ready still blocks', () => {
    const baseline = readyOutside();
    const other = readyOutside({
      withdrawalId: '01a0cccccccccccccccccccccccccccccc',
      publicId: 'WD-HIDDEN',
      attemptId: OTHER_ATTEMPT,
    });
    const result = evaluatePhase10FinalSlotOccupancy({
      candidates: [baseline, other],
      baselineIsolatedHistoricalAttemptIds: [BASELINE_ATTEMPT, '01a0deadbeefdeadbeefdeadbeefdead'],
    });
    expect(result.excludedHistoricalBaseline.map((c) => c.publicId)).toEqual(['WD-000001']);
    expect(result.blockers.map((c) => c.publicId)).toEqual(['WD-HIDDEN']);
    expect(result.nonBaselineHiddenReadyCount).toBe(1);
    expect(result.hiddenReadyHardCap).toBe(0);
  });
});
