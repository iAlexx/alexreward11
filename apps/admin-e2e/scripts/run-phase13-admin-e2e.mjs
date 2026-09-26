#!/usr/bin/env node
/**
 * Root entry for `pnpm test:phase13:admin-e2e`.
 * Builds API + Admin for the E2E ports, installs Chromium if needed, runs Playwright.
 * Requires PHASE13_ADMIN_E2E=1 and an isolated PHASE13_DATABASE_URL / PHASE13_ADMIN_E2E_DATABASE_URL.
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

if (process.env.PHASE13_ADMIN_E2E !== '1') {
  console.error('REFUSE: set PHASE13_ADMIN_E2E=1 to run Phase 13 Admin browser E2E');
  process.exit(1);
}

const adminPort = process.env.PHASE13_ADMIN_E2E_ADMIN_PORT ?? '3031';
const apiPort = process.env.PHASE13_ADMIN_E2E_API_PORT ?? '3032';
const apiBase = process.env.PHASE13_ADMIN_E2E_API_BASE_URL ?? `http://localhost:${apiPort}`;
const adminBase = process.env.PHASE13_ADMIN_E2E_ADMIN_BASE_URL ?? `http://localhost:${adminPort}`;

run(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@alex-rewards/api...',
    '--filter=@alex-rewards/admin...',
  ],
  {
    NEXT_PUBLIC_API_BASE_URL: apiBase,
    ADMIN_WEBAUTHN_ORIGIN: adminBase,
  },
);

run('pnpm', ['--filter', '@alex-rewards/admin-e2e', 'exec', 'playwright', 'install', 'chromium']);

run('pnpm', ['--filter', '@alex-rewards/admin-e2e', 'run', 'test:phase13:admin-e2e']);
