import { createHash } from 'node:crypto';

/**
 * Deterministic canonical JSON for digests.
 * Sorts object keys recursively; arrays keep order; never relies on insertion order.
 */
export function canonicalizeForDigest(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}

/** SHA-256 hex digest of the canonical representation of a safe input set. */
export function computeRiskInputsDigest(
  ruleVersion: number,
  safeInputs: Readonly<Record<string, unknown>>,
): string {
  const payload = canonicalizeForDigest({
    ruleVersion,
    safeInputs,
  });
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
