/**
 * Process-level regression: chain-history-readonly-validate exit codes must
 * survive try/finally early return (process.exitCode, not skipped process.exit).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE } from '../src/phase10-chain-history-evidence.js';
import { readonlyValidateVerdictImpliesSuccess } from '../src/cli/phase10-ops-exit.js';

const here = dirname(fileURLToPath(import.meta.url));
const harnessPath = join(here, 'helpers', 'phase10-ops-readonly-exit-harness.mjs');
const cliSourcePath = join(here, '..', 'src', 'cli', 'phase10-ops.ts');
const exitHelperSourcePath = join(here, '..', 'src', 'cli', 'phase10-ops-exit.ts');

function runHarness(verdict: string): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, [harnessPath, verdict], {
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('phase10-ops chain-history-readonly-validate exit semantics', () => {
  it('keeps PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE false', () => {
    expect(PHASE10_CHAIN_HISTORY_PROVIDER_COLLECTOR_AVAILABLE).toBe(false);
  });

  it('CLI source commits process.exitCode before early return (not process.exit)', () => {
    const source = readFileSync(cliSourcePath, 'utf8');
    const helper = readFileSync(exitHelperSourcePath, 'utf8');
    expect(helper).toContain('process.exitCode = code');
    const validateBlockStart = source.indexOf("command === 'chain-history-readonly-validate'");
    expect(validateBlockStart).toBeGreaterThanOrEqual(0);
    const nextCommand = source.indexOf("command === 'campaign-rescan'", validateBlockStart);
    const block = source.slice(
      validateBlockStart,
      nextCommand > validateBlockStart ? nextCommand : source.length,
    );
    expect(block).toContain('setPhase10OpsProcessExitCode');
    expect(block).not.toMatch(/process\.exit\s*\(\s*exitCode\s*\)/);
    expect(block).not.toMatch(/process\.exit\s*\(\s*1\s*\)/);
  });

  it.each([
    ['PASS_ZERO_OUTGOING', 0],
    ['PASS_WITH_OBSERVED_TRANSFERS', 0],
    ['FAIL_BINDING', 1],
    ['FAIL_PROVIDER_HEALTH', 1],
    ['FAIL_INCOMPLETE_HISTORY', 1],
    ['FAIL_PROVIDER_DISAGREEMENT', 1],
  ] as const)(
    'verdict %s → process exit %i (pool cleanup still runs)',
    (verdict, expectedStatus) => {
      expect(readonlyValidateVerdictImpliesSuccess(verdict)).toBe(expectedStatus === 0);
      const result = runHarness(verdict);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(expectedStatus);
      expect(result.stdout).toContain('"event":"pool_end"');
      expect(result.stdout).toContain(`"verdict":"${verdict}"`);
      expect(result.stdout).toContain(`"ok":${expectedStatus === 0 ? 'true' : 'false'}`);
    },
  );
});
