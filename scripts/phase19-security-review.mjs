/**
 * Phase 19 Step 1 security review harness.
 *
 * Runs deterministic, non-live security suites. DB-backed gates fail closed when
 * no disposable isolated test DB URL is configured (never use operational staging).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const dbUrl =
  process.env.PHASE19_SECURITY_DATABASE_URL ??
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.M0_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  process.env.PHASE2_DATABASE_URL ??
  '';

function run(label, command, args, { requireDb = false } = {}) {
  console.log(`\n=== ${label} ===`);
  if (requireDb && dbUrl.trim() === '') {
    console.error(
      `FATAL: ${label} requires PHASE19_SECURITY_DATABASE_URL (or OWNER_ADMIN_AUTH/M0/PHASE7/PHASE2) pointing at an isolated *_test database. Refusing operational DB.`,
    );
    process.exit(1);
  }
  const env = { ...process.env };
  if (requireDb) {
    const normalized = dbUrl.includes('localhost')
      ? dbUrl.replace('://localhost', '://127.0.0.1').replace('@localhost:', '@127.0.0.1:')
      : dbUrl;
    env.PHASE19_SECURITY_DATABASE_URL = normalized;
    env.OWNER_ADMIN_AUTH_DATABASE_URL = env.OWNER_ADMIN_AUTH_DATABASE_URL ?? normalized;
    env.M0_DATABASE_URL = env.M0_DATABASE_URL ?? normalized;
  }
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: true,
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('[phase19-security-review] discovery harness');
console.log('[phase19-security-review] no live AdsGram/Telegram/Railway/Mainnet/signer attacks');

run('phase19-discovery-source', 'pnpm', [
  '--filter',
  '@alex-rewards/api',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase19-security-discovery.test.ts',
]);

run('phase13-admin-security-matrix', 'pnpm', [
  '--filter',
  '@alex-rewards/api',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase13-admin-security-matrix.test.ts',
]);

// Optional DB-backed suites: fail closed only when PHASE19_REQUIRE_DB_GATES=1
if (process.env.PHASE19_REQUIRE_DB_GATES === '1') {
  run(
    'phase8-founder-admin-db',
    'pnpm',
    ['--filter', '@alex-rewards/control-center', 'run', 'test:phase8'],
    { requireDb: true },
  );
  run(
    'phase16-mission-claim-db',
    'pnpm',
    ['--filter', '@alex-rewards/tasks', 'run', 'test:phase16'],
    { requireDb: true },
  );
} else {
  console.log(
    '[phase19-security-review] DB-backed founder/mission suites SKIPPED (set PHASE19_REQUIRE_DB_GATES=1 with disposable DB URL to require them)',
  );
}

console.log('\n[phase19-security-review] PASS (discovery harness)');
