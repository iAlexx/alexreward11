/**
 * CLI process exit helper for Phase 10 ops.
 *
 * Use `process.exitCode` (not immediate `process.exit`) so `try/finally` pool
 * cleanup still runs after an early `return` from command handlers.
 */
export function setPhase10OpsProcessExitCode(code: number): void {
  process.exitCode = code;
}

/** Same mapping as `chain-history-readonly-validate` CLI success check. */
export function readonlyValidateVerdictImpliesSuccess(verdict: string): boolean {
  return verdict.startsWith('PASS');
}
