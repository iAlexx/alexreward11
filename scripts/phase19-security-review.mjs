/**
 * Phase 19 security review harness.
 *
 * Runs deterministic, non-live security suites. When PHASE19_REQUIRE_DB_GATES=1,
 * mandatory DB suites fail closed unless a disposable isolated test DB URL is set.
 * Never points at operational staging/source Postgres.
 *
 * Skip regression: a mandatory DB suite that reports zero passed tests (all skipped)
 * fails the harness — PHASE19_REQUIRE_DB_GATES=1 cannot PASS on skipped gates.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireDbGates = process.env.PHASE19_REQUIRE_DB_GATES === '1';
const selfTest = process.env.PHASE19_HARNESS_SELF_TEST === '1';

const dbUrl =
  process.env.PHASE19_SECURITY_DATABASE_URL ??
  process.env.OWNER_ADMIN_AUTH_DATABASE_URL ??
  process.env.M0_DATABASE_URL ??
  process.env.PHASE7_DATABASE_URL ??
  process.env.PHASE2_DATABASE_URL ??
  '';

function normalizeUrl(url) {
  return url.includes('localhost')
    ? url.replace('://localhost', '://127.0.0.1').replace('@localhost:', '@127.0.0.1:')
    : url;
}

function buildDbEnv() {
  if (dbUrl.trim() === '') {
    console.error(
      'FATAL: PHASE19_REQUIRE_DB_GATES=1 requires PHASE19_SECURITY_DATABASE_URL (or OWNER_ADMIN_AUTH/M0/PHASE7/PHASE2) pointing at an isolated *_test / *_phaseN database.',
    );
    process.exit(1);
  }
  const normalized = normalizeUrl(dbUrl.trim());
  return {
    ...process.env,
    PHASE19_SECURITY_DATABASE_URL: normalized,
    OWNER_ADMIN_AUTH_DATABASE_URL: normalized,
    M0_DATABASE_URL: normalized,
    DATABASE_URL: normalized,
    // Exact names inspected from package harnesses:
    PHASE3_DATABASE_URL: normalized,
    PHASE3_AUTH_TESTS: '1',
    PHASE8_DATABASE_URL: normalized,
    PHASE8_CONTROL_CENTER_TESTS: '1',
    PHASE16_DATABASE_URL: normalized,
    PHASE16_MISSION_TESTS: '1',
    PHASE5_REWARD_TESTS: '1',
    PHASE19_FEATURE_FLAG_TESTS: '1',
    OWNER_BOOTSTRAP_TESTS: '1',
    OWNER_ADMIN_AUTH_TESTS: '1',
    ALEX_OWNER_BOOTSTRAP_TEST_HOOKS: '1',
  };
}

/** @param {string} output */
export function parseVitestPassedCount(output) {
  const m = output.match(/Tests\s+(\d+)\s+passed/);
  if (!m) return null;
  return Number(m[1]);
}

/** @param {string} label @param {string} output */
export function assertMandatorySuiteNotSkipped(label, output) {
  const passed = parseVitestPassedCount(output);
  if (passed === null) {
    throw new Error(
      `[phase19-security-review] FAIL: mandatory suite "${label}" produced no vitest Tests summary (cannot prove execution)`,
    );
  }
  if (passed === 0) {
    throw new Error(
      `[phase19-security-review] FAIL: mandatory suite "${label}" reported 0 passed tests (skipped under PHASE19_REQUIRE_DB_GATES=1)`,
    );
  }
  return passed;
}

if (selfTest) {
  const cases = [
    ['Tests  15 passed | 6 skipped (21)', 15],
    ['Tests  1 passed (1)', 1],
    ['Tests  0 passed | 3 skipped (3)', 0],
  ];
  for (const [sample, expected] of cases) {
    const got = parseVitestPassedCount(sample);
    if (got !== expected) {
      console.error('SELF_TEST_FAIL parse', sample, got, expected);
      process.exit(1);
    }
  }
  let threw = false;
  try {
    assertMandatorySuiteNotSkipped(
      'phase19-feature-flag-concurrency-db',
      'Test Files  1 skipped (1)\nTests  0 passed | 1 skipped (1)\n',
    );
  } catch {
    threw = true;
  }
  if (!threw) {
    console.error('SELF_TEST_FAIL expected throw on 0 passed');
    process.exit(1);
  }
  const ok = assertMandatorySuiteNotSkipped(
    'phase3-auth-db',
    'Test Files  1 passed | 1 skipped (2)\nTests  15 passed | 6 skipped (21)\n',
  );
  if (ok !== 15) {
    console.error('SELF_TEST_FAIL accept', ok);
    process.exit(1);
  }
  console.log('[phase19-security-review] SELF_TEST PASS');
  process.exit(0);
}

function run(label, command, args, env = process.env, { captureAndAssert = false } = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: true,
    stdio: captureAndAssert ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  const code = result.status ?? 1;
  if (captureAndAssert) {
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (code !== 0) {
      console.log(`[${label}] exit=${code}`);
      process.exit(code);
    }
    try {
      const passed = assertMandatorySuiteNotSkipped(label, out);
      console.log(`[${label}] exit=${code} mandatory_passed=${passed}`);
    } catch (error) {
      console.error(String(error?.message ?? error));
      process.exit(1);
    }
    return code;
  }
  console.log(`[${label}] exit=${code}`);
  if (code !== 0) {
    process.exit(code);
  }
  return code;
}

console.log('[phase19-security-review] harness');
console.log('[phase19-security-review] no live AdsGram/Telegram/Railway/Mainnet/signer attacks');
console.log(`[phase19-security-review] PHASE19_REQUIRE_DB_GATES=${requireDbGates ? '1' : '0'}`);

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

run('phase19-payout-pause-unit', 'pnpm', [
  '--filter',
  '@alex-rewards/withdrawals',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase19-payout-pause-fail-closed.test.ts',
]);

if (!requireDbGates) {
  console.log(
    '[phase19-security-review] DB-backed suites SKIPPED (set PHASE19_REQUIRE_DB_GATES=1 with disposable DB URL to require them)',
  );
  console.log('\n[phase19-security-review] PASS (non-DB harness)');
  process.exit(0);
}

const dbEnv = buildDbEnv();

const dbSuites = [
  [
    'phase3-auth-db',
    'pnpm',
    ['--filter', '@alex-rewards/auth', 'run', 'test:phase3'],
  ],
  [
    'phase8-control-center-db',
    'pnpm',
    ['--filter', '@alex-rewards/control-center', 'run', 'test:phase8'],
  ],
  [
    'phase16-mission-db',
    'pnpm',
    ['--filter', '@alex-rewards/tasks', 'run', 'test:phase16'],
  ],
  [
    'phase16-mission-issuance-db',
    'pnpm',
    ['--filter', '@alex-rewards/rewards', 'run', 'test:phase16'],
  ],
  [
    'phase19-feature-flag-concurrency-db',
    'pnpm',
    [
      '--filter',
      '@alex-rewards/api',
      'exec',
      'vitest',
      'run',
      '--fileParallelism=false',
      'test/phase19-feature-flag-concurrency.db.test.ts',
    ],
  ],
  [
    'phase19-mission-revoke-db',
    'pnpm',
    [
      '--filter',
      '@alex-rewards/tasks',
      'exec',
      'vitest',
      'run',
      '--fileParallelism=false',
      'test/phase19-mission-version-revoke.db.test.ts',
    ],
  ],
  [
    'phase19-mission-revoke-issuance-db',
    'pnpm',
    [
      '--filter',
      '@alex-rewards/rewards',
      'exec',
      'vitest',
      'run',
      '--fileParallelism=false',
      'test/phase19-mission-revoke-issuance.db.test.ts',
    ],
  ],
];

for (const [label, command, args] of dbSuites) {
  run(label, command, args, dbEnv, { captureAndAssert: true });
}

console.log('\n[phase19-security-review] PASS (full DB gates)');
