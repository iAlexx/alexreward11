/**
 * Static safety constants for architecture / unit tests.
 * The restore-drill package is read-only orchestration evidence.
 */

export const RESTORE_DRILL_FORBIDDEN_CAPABILITIES = {
  sqlMutation: false,
  ledgerPosting: false,
  withdrawalDispatch: false,
  tonBroadcast: false,
  signerUnlock: false,
  signerSign: false,
  temporalWorkflowStart: false,
  temporalWorkflowReplay: false,
  autoUnpause: false,
  autoResend: false,
  databaseUrlFallback: false,
} as const;

/** Packages that must never be imported by restore-drill production source. */
export const RESTORE_DRILL_FORBIDDEN_IMPORTS = [
  '@alex-rewards/signing',
  '@alex-rewards/ton',
  '@alex-rewards/ads',
  '@alex-rewards/rewards',
  '@alex-rewards/control-center',
  '@alex-rewards/fraud',
  '@alex-rewards/wallets',
] as const;

/** Exact allowed named runtime imports from financial packages. */
export const RESTORE_DRILL_ALLOWED_LEDGER_IMPORTS = ['checkLedgerInvariants'] as const;
export const RESTORE_DRILL_ALLOWED_WITHDRAWALS_IMPORTS = ['runPhase10RestoreReconcileScan'] as const;
export const RESTORE_DRILL_ALLOWED_DB_IMPORTS = ['listMigrationFiles'] as const;
