#!/usr/bin/env node
/**
 * Process harness for chain-history-readonly-validate CLI exit semantics.
 * Mirrors try / early-return / finally pool cleanup from phase10-ops.ts.
 * Inlines the same exit helpers used by the CLI (see phase10-ops-exit.ts).
 */
import process from 'node:process';

function setPhase10OpsProcessExitCode(code) {
  process.exitCode = code;
}

function readonlyValidateVerdictImpliesSuccess(verdict) {
  return String(verdict).startsWith('PASS');
}

async function main() {
  const verdict = process.argv[2];
  if (verdict === undefined || verdict.trim() === '') {
    process.stderr.write(JSON.stringify({ ok: false, error: 'verdict argv required' }) + '\n');
    setPhase10OpsProcessExitCode(2);
    return;
  }

  const pool = {
    ended: false,
    async end() {
      this.ended = true;
      process.stdout.write(JSON.stringify({ event: 'pool_end' }) + '\n');
    },
  };

  try {
    const ok = readonlyValidateVerdictImpliesSuccess(verdict);
    setPhase10OpsProcessExitCode(ok ? 0 : 1);
    process.stdout.write(JSON.stringify({ ok, verdict, poolEndedBeforeReturn: pool.ended }) + '\n');
    return;
  } finally {
    await pool.end();
  }
}

await main();
