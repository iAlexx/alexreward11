/**
 * Local/CI equivalent of mandatory M1 security gates (S-04).
 * Fails closed if required disposable DB URL is missing.
 * Does NOT push; does NOT touch operational alex_rewards.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function redact(url) {
  return String(url).replace(/:([^:@/]+)@/, ':***@');
}

const dbUrl =
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.M0_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  process.env.PHASE2_DATABASE_URL ??
  '';

if (dbUrl.trim() === '') {
  console.error(
    'FATAL: M1 security gates require OWNER_ADMIN_AUTH_DATABASE_URL (or M0/PHASE7/PHASE2) pointing at an isolated *_test / *_phaseN database.',
  );
  process.exit(1);
}

const normalized = dbUrl.includes('localhost')
  ? dbUrl.replace('://localhost', '://127.0.0.1').replace('@localhost:', '@127.0.0.1:')
  : dbUrl;

console.log(`[m1-security-gates] database=${redact(normalized)}`);
console.log('[m1-security-gates] M1_CI_SECURITY_GATE=1 (fail-closed; no silent skip)');

const env = {
  ...process.env,
  M1_CI_SECURITY_GATE: '1',
  OWNER_ADMIN_AUTH_DATABASE_URL: normalized,
  M0_DATABASE_URL: process.env.M0_DATABASE_URL ?? normalized,
  OWNER_BOOTSTRAP_TESTS: '1',
  OWNER_ADMIN_AUTH_TESTS: '1',
  ALEX_OWNER_BOOTSTRAP_TEST_HOOKS: '1',
};

function run(label, command, args) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ ${command} ${args.join(' ')}`);
  const started = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: true,
    stdio: 'inherit',
  });
  const ended = new Date().toISOString();
  console.log(`[${label}] start=${started} end=${ended} exit=${result.status ?? 1}`);
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('M0 single-Owner', 'pnpm', ['--filter', '@alex-rewards/db', 'run', 'test:m0-security-gate']);
run('Owner Authentication', 'pnpm', [
  '--filter',
  '@alex-rewards/auth',
  'run',
  'test:owner-admin-auth',
]);
run('M1 Owner Bootstrap (+ acceptance)', 'pnpm', [
  '--filter',
  '@alex-rewards/auth',
  'run',
  'test:owner-bootstrap',
]);

console.log('\n[m1-security-gates] ALL MANDATORY SUITES COMPLETED');
