/**
 * Control Center package boundary markers.
 * Runtime source must not import ledger posting, TON signing, or cloud KMS clients.
 * Withdrawal decisions go through withdrawals domain commands only.
 * Founder grants go through auth with zero ledger side effects.
 */

export const CONTROL_CENTER_BOUNDARY = {
  forbidsLedger: true,
  forbidsTonSign: true,
  forbidsKms: true,
} as const;
