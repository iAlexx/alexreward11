/**
 * Safe JSON serialization for Phase 21 canary payout PLAN CLI output.
 * BigInt -> exact decimal string. Never Number(bigint).
 */
export function phase21CanaryPayoutJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString(10);
  }
  return value;
}

export function stringifyPhase21CanaryPayoutJson(
  value: unknown,
  space: string | number | undefined = 2,
): string {
  return JSON.stringify(value, phase21CanaryPayoutJsonReplacer, space);
}
