/**
 * Phase 17 — PUBLIC_PAYOUT_LOGS_ENABLED fail-closed helper.
 * Missing / unset outside an explicitly configured test fixture => disabled.
 * Step 1 does not enable runtime send.
 *
 * Deferred Owner policies (not decided in Step 1):
 * - HISTORICAL_BACKFILL_POLICY: OWNER_POLICY_REQUIRED
 * - MULTIPLE_DESTINATION_POLICY: OWNER_POLICY_REQUIRED
 * - TESTNET_PUBLICATION_POLICY: OWNER_POLICY_REQUIRED
 * Future sender must fail closed against fake/synthetic payout proof and Mainnet
 * activation; no production channel IDs are seeded here.
 */

export function isPublicPayoutLogsEnabled(
  value: string | boolean | null | undefined = process.env.PUBLIC_PAYOUT_LOGS_ENABLED,
): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === null || value === undefined) {
    return false;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}
