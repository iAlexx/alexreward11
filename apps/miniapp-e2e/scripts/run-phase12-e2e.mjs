#!/usr/bin/env node
/**
 * Root entry for `pnpm test:phase12:e2e`.
 * Builds API + Mini App for the E2E ports, installs Chromium if needed, runs Playwright.
 * Requires PHASE12_E2E=1 and an isolated PHASE12_DATABASE_URL (or default phase12_e2e DB).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (process.env.PHASE12_E2E !== '1') {
  console.error('REFUSE: set PHASE12_E2E=1 to run Phase 12 browser E2E');
  process.exit(1);
}

const apiPort = process.env.PHASE12_E2E_API_PORT ?? '3012';
const apiBase = process.env.PHASE12_E2E_API_BASE_URL ?? `http://127.0.0.1:${apiPort}`;

run(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@alex-rewards/api...',
    '--filter=@alex-rewards/miniapp...',
  ],
  {
    NEXT_PUBLIC_API_BASE_URL: apiBase,
  },
);

run('pnpm', ['--filter', '@alex-rewards/miniapp-e2e', 'exec', 'playwright', 'install', 'chromium']);

run('pnpm', ['--filter', '@alex-rewards/miniapp-e2e', 'run', 'test:phase12:e2e']);
