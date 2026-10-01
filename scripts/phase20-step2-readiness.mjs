/**
 * Phase 20 Step 2 readiness harness (non-money Closed Beta blocker preparation).
 * No Railway / live providers / operational DB.
 *
 * Always: gap-register check, notification unit, referrals authority unit,
 *         boundaries, secrets.
 * When PHASE20_STEP2_REQUIRE_DB_GATES=1: require PHASE20_DATABASE_URL and run
 * mandatory disposable-DB suites (fail if skipped / 0 tests).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireDb = process.env.PHASE20_STEP2_REQUIRE_DB_GATES === '1';

function run(label, command, args, env = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const code = result.status ?? 1;
  if (code !== 0) {
    console.error(`[phase20-step2] FAIL ${label} exit=${code}`);
    process.exit(code);
  }
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const skippedAll = /Test Files\s+0 passed/.test(out) || /No test files found/.test(out);
  const testsLine = out.match(/Tests\s+(\d+)\s+passed/);
  const passed = testsLine ? Number(testsLine[1]) : null;
  if (requireDb && label.includes('(DB)') && (skippedAll || passed === 0)) {
    console.error(`[phase20-step2] FAIL ${label}: mandatory DB suite produced 0 tests`);
    process.exit(1);
  }
  console.log(`[phase20-step2] ${label} exit=0${passed !== null ? ` passed=${passed}` : ''}`);
  return { passed };
}

console.log('[phase20-step2] harness');
console.log('[phase20-step2] no Railway/live providers/operational DB');
console.log(`[phase20-step2] PHASE20_STEP2_REQUIRE_DB_GATES=${requireDb ? '1' : '0'}`);

if (requireDb && !(process.env.PHASE20_DATABASE_URL ?? '')) {
  console.error('[phase20-step2] PHASE20_STEP2_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL');
  process.exit(1);
}

run('phase20-gap-register', 'pnpm', ['phase20:gap-register:check']);
run('phase20-notifications-unit', 'pnpm', [
  '--filter',
  '@alex-rewards/api',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase20-notifications-nosend.unit.test.ts',
]);
run('phase20-referral-authority-unit', 'pnpm', [
  '--filter',
  '@alex-rewards/referrals',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase20-referral-authority.unit.test.ts',
]);

if (requireDb) {
  run('phase20-notifications-admin (DB)', 'pnpm', [
    '--filter',
    '@alex-rewards/api',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/phase20-notifications-admin.db.test.ts',
  ]);
  run('phase20-fraud-eligibility (DB)', 'pnpm', [
    '--filter',
    '@alex-rewards/fraud',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/phase20-eligibility-controlled.db.test.ts',
  ]);
  run('phase20-mission-list-empty (DB)', 'pnpm', [
    '--filter',
    '@alex-rewards/tasks',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/phase20-mission-list-empty.db.test.ts',
  ]);
  run('phase20-referral-controlled (DB)', 'pnpm', [
    '--filter',
    '@alex-rewards/referrals',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/phase20-referral-controlled.db.test.ts',
  ]);
  run(
    'phase14-eligibility-authoritative (DB)',
    'pnpm',
    [
      '--filter',
      '@alex-rewards/fraud',
      'exec',
      'vitest',
      'run',
      '--fileParallelism=false',
      'test/phase14-eligibility-authoritative.unit.test.ts',
      'test/phase14-eligibility-authoritative.db.test.ts',
    ],
    { PHASE14_DATABASE_URL: process.env.PHASE20_DATABASE_URL },
  );
  run(
    'phase19-mission-revoke (DB)',
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
    { PHASE16_DATABASE_URL: process.env.PHASE20_DATABASE_URL },
  );
  run(
    'phase19-mission-revoke-issuance (DB)',
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
    {
      PHASE16_DATABASE_URL: process.env.PHASE20_DATABASE_URL,
      PHASE5_REWARD_TESTS: '1',
    },
  );
}

run('verify:boundaries', 'pnpm', ['verify:boundaries']);
run('security:secrets', 'pnpm', ['security:secrets']);

console.log('\n[phase20-step2] PASS');
