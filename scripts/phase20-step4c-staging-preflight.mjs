/**
 * Root wrapper — Phase 20 Step 4C read-only staging preflight.
 * Activation is intentionally unimplemented.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.PHASE20_STEP4C_ACTIVATE === '1') {
  console.error('[phase20-step4c] REFUSED: activation is not implemented in this step');
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  'pnpm',
  [
    '--filter',
    '@alex-rewards/fraud',
    'exec',
    'node',
    'scripts/phase20-step4c-staging-preflight.mjs',
  ],
  { cwd: root, env: process.env, encoding: 'utf8', shell: true, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
