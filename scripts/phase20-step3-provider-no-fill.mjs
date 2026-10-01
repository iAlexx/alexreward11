/**
 * Phase 20 Step 3 — provider / no-fill / Earn UX validation harness.
 * Observation only: AdsGram monetary remains BLOCKED. No Railway / operational DB.
 *
 * Always: gap-register, Earn UX unit, boundaries, secrets.
 * When PHASE20_STEP3_REQUIRE_DB_GATES=1: require PHASE20_DATABASE_URL and run
 * mandatory disposable-DB provider suites (fail if 0 tests).
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireDb = process.env.PHASE20_STEP3_REQUIRE_DB_GATES === '1';

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
    console.error(`[phase20-step3] FAIL ${label} exit=${code}`);
    process.exit(code);
  }
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const skippedAll = /Test Files\s+0 passed/.test(out) || /No test files found/.test(out);
  const testsLine = out.match(/Tests\s+(\d+)\s+passed/);
  const passed = testsLine ? Number(testsLine[1]) : null;
  if (requireDb && label.includes('(DB)') && (skippedAll || passed === 0)) {
    console.error(`[phase20-step3] FAIL ${label}: mandatory DB suite produced 0 tests`);
    process.exit(1);
  }
  console.log(`[phase20-step3] ${label} exit=0${passed !== null ? ` passed=${passed}` : ''}`);
}

console.log('[phase20-step3] provider/no-fill/Earn observation harness');
console.log('[phase20-step3] AdsGram monetary remains BLOCKED; no Railway/operational DB');
console.log(`[phase20-step3] PHASE20_STEP3_REQUIRE_DB_GATES=${requireDb ? '1' : '0'}`);

if (requireDb && !(process.env.PHASE20_DATABASE_URL ?? '')) {
  console.error('[phase20-step3] PHASE20_STEP3_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL');
  process.exit(1);
}

run('phase20-gap-register', 'pnpm', ['phase20:gap-register:check']);
run(
  'phase20-earn-nofill-ux-unit',
  'pnpm',
  [
    '--filter',
    '@alex-rewards/miniapp',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/phase20-earn-nofill-ux.unit.test.ts',
  ],
);
run(
  'phase20-earn-authority-baseline',
  'pnpm',
  [
    '--filter',
    '@alex-rewards/miniapp',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/earn-authority.test.ts',
  ],
);

if (requireDb) {
  run(
    'phase20-provider-nofill-blocked (DB)',
    'pnpm',
    [
      '--filter',
      '@alex-rewards/ads',
      'exec',
      'vitest',
      'run',
      '--fileParallelism=false',
      'test/phase20-provider-nofill-blocked.db.test.ts',
    ],
  );
}

run('verify:boundaries', 'pnpm', ['verify:boundaries']);
run('security:secrets', 'pnpm', ['security:secrets']);
console.log('\n[phase20-step3] PASS');