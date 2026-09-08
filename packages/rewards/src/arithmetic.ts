import { PG_BIGINT_MAX, PG_BIGINT_MIN } from '@alex-rewards/ledger';

import { RewardDomainError } from './errors.js';

const ECPM_DENOMINATOR = 1000n * 10_000n * 10_000n;
const BPS_DENOMINATOR = 10_000n;

function assertPgBigint(value: bigint, label: string): bigint {
  if (value < PG_BIGINT_MIN || value > PG_BIGINT_MAX) {
    throw new RewardDomainError('ARITHMETIC_OVERFLOW', `${label} exceeds PostgreSQL BIGINT range`, {
      details: { label, value: value.toString(10) },
    });
  }
  return value;
}

function parseNonNegativeAtomic(value: bigint | string, label: string): bigint {
  let amount: bigint;
  if (typeof value === 'bigint') {
    amount = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(trimmed)) {
      throw new RewardDomainError('VALIDATION', `${label} must be a non-negative integer string`, {
        details: { label },
      });
    }
    amount = BigInt(trimmed);
  } else {
    throw new RewardDomainError('VALIDATION', `${label} must be bigint or string`, {
      details: { label },
    });
  }
  return assertPgBigint(amount, label);
}

function parsePositiveAtomic(value: bigint | string, label: string): bigint {
  const amount = parseNonNegativeAtomic(value, label);
  if (amount <= 0n) {
    throw new RewardDomainError('VALIDATION', `${label} must be greater than zero`, {
      details: { label },
    });
  }
  return amount;
}

function parseBps(value: number, label: string): bigint {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RewardDomainError('VALIDATION', `${label} must be an integer between 0 and 10000`, {
      details: { label, value },
    });
  }
  return BigInt(value);
}

/**
 * Spec §21.1:
 * raw = FLOOR(estimated_ecpm_atomic * user_share_bps * safety_factor_bps / (1000 * 10000 * 10000))
 * Intermediates use JS bigint; the floored result must fit PostgreSQL BIGINT.
 */
export function computeRawRewardAtomic(input: {
  readonly estimatedEcpmAtomic: bigint | string;
  readonly userShareBps: number;
  readonly safetyFactorBps: number;
}): bigint {
  const ecpm = parsePositiveAtomic(input.estimatedEcpmAtomic, 'estimatedEcpmAtomic');
  const userShare = parseBps(input.userShareBps, 'userShareBps');
  const safety = parseBps(input.safetyFactorBps, 'safetyFactorBps');
  const numerator = ecpm * userShare * safety;
  const raw = numerator / ECPM_DENOMINATOR;
  return assertPgBigint(raw, 'rawRewardAtomic');
}

/** Clamp raw reward into [min, max] when bounds are present. Bounds must already be positive. */
export function clampRewardAtomic(input: {
  readonly rawAtomic: bigint | string;
  readonly minRewardAtomic?: bigint | string | null;
  readonly maxRewardAtomic?: bigint | string | null;
}): bigint {
  let value = parseNonNegativeAtomic(input.rawAtomic, 'rawAtomic');
  if (input.minRewardAtomic !== undefined && input.minRewardAtomic !== null) {
    const min = parsePositiveAtomic(input.minRewardAtomic, 'minRewardAtomic');
    if (value < min) value = min;
  }
  if (input.maxRewardAtomic !== undefined && input.maxRewardAtomic !== null) {
    const max = parsePositiveAtomic(input.maxRewardAtomic, 'maxRewardAtomic');
    if (value > max) value = max;
  }
  if (
    input.minRewardAtomic !== undefined &&
    input.minRewardAtomic !== null &&
    input.maxRewardAtomic !== undefined &&
    input.maxRewardAtomic !== null
  ) {
    const min = parsePositiveAtomic(input.minRewardAtomic, 'minRewardAtomic');
    const max = parsePositiveAtomic(input.maxRewardAtomic, 'maxRewardAtomic');
    if (min > max) {
      throw new RewardDomainError('VALIDATION', 'minRewardAtomic cannot exceed maxRewardAtomic');
    }
  }
  if (value <= 0n) {
    throw new RewardDomainError(
      'VALIDATION',
      'quoted reward must be greater than zero after clamp',
      {
        details: { rawAtomic: value.toString(10) },
      },
    );
  }
  return assertPgBigint(value, 'clampedRewardAtomic');
}

/**
 * Quoted base amount: fixed reward wins when present; otherwise formula + clamp.
 */
export function computeQuotedRewardAtomic(input: {
  readonly fixedRewardAtomic?: bigint | string | null;
  readonly estimatedEcpmAtomic?: bigint | string | null;
  readonly userShareBps?: number | null;
  readonly safetyFactorBps?: number | null;
  readonly minRewardAtomic?: bigint | string | null;
  readonly maxRewardAtomic?: bigint | string | null;
}): bigint {
  if (input.fixedRewardAtomic !== undefined && input.fixedRewardAtomic !== null) {
    return parsePositiveAtomic(input.fixedRewardAtomic, 'fixedRewardAtomic');
  }
  if (
    input.estimatedEcpmAtomic === undefined ||
    input.estimatedEcpmAtomic === null ||
    input.userShareBps === undefined ||
    input.userShareBps === null ||
    input.safetyFactorBps === undefined ||
    input.safetyFactorBps === null
  ) {
    throw new RewardDomainError(
      'VALIDATION',
      'dynamic reward requires estimatedEcpmAtomic, userShareBps, and safetyFactorBps',
    );
  }
  const raw = computeRawRewardAtomic({
    estimatedEcpmAtomic: input.estimatedEcpmAtomic,
    userShareBps: input.userShareBps,
    safetyFactorBps: input.safetyFactorBps,
  });
  return clampRewardAtomic({
    rawAtomic: raw,
    minRewardAtomic: input.minRewardAtomic ?? null,
    maxRewardAtomic: input.maxRewardAtomic ?? null,
  });
}

/**
 * ADR-013 interim: FLOOR(base_amount_atomic * bonus_bps / 10000).
 * Zero after FLOOR is treated as no bonus (0), not an error.
 */
export function computeMembershipBonusAtomic(input: {
  readonly baseAmountAtomic: bigint | string;
  readonly bonusBps: number;
}): bigint {
  const base = parsePositiveAtomic(input.baseAmountAtomic, 'baseAmountAtomic');
  const bps = parseBps(input.bonusBps, 'bonusBps');
  const bonus = (base * bps) / BPS_DENOMINATOR;
  return assertPgBigint(bonus, 'membershipBonusAtomic');
}
