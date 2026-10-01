/**
 * Phase 20 Step 4B — Owner-approved policy static check (+ optional disposable DB gate).
 * Never mutates operational/staging DB. Never activates live policies.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireDb = process.env.PHASE20_STEP4B_REQUIRE_DB_GATES === '1';

function run(label, args, env = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync('pnpm', args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    shell: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const code = result.status ?? 1;
  if (code !== 0) {
    console.error(`[phase20-step4b] FAIL ${label} exit=${code}`);
    process.exit(code);
  }
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const testsLine = out.match(/Tests\s+(\d+)\s+passed/);
  const passed = testsLine ? Number(testsLine[1]) : null;
  if (requireDb && label.includes('(DB)') && (passed === null || passed === 0)) {
    console.error(`[phase20-step4b] FAIL ${label}: mandatory DB suite produced 0 tests`);
    process.exit(1);
  }
  console.log(`[phase20-step4b] ${label} exit=0${passed !== null ? ` passed=${passed}` : ''}`);
}

console.log('[phase20-step4b] Owner-approved policy static/disposable validation');
console.log(`[phase20-step4b] PHASE20_STEP4B_REQUIRE_DB_GATES=${requireDb ? '1' : '0'}`);
console.log('[phase20-step4b] activationAuthorized remains false; no staging activation');

if (requireDb && !(process.env.PHASE20_DATABASE_URL ?? '')) {
  console.error('[phase20-step4b] PHASE20_STEP4B_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL');
  process.exit(1);
}

run('phase20-gap-register', ['phase20:gap-register:check']);
run('approved-policy-unit', [
  '--filter',
  '@alex-rewards/fraud',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase20-step4b-approved-policy.unit.test.ts',
]);
run('eligibility-semantics-unit', [
  '--filter',
  '@alex-rewards/fraud',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase20-eligibility-gate-semantics.unit.test.ts',
]);

if (requireDb) {
  run(
    'approved-policy (DB)',
    [
      '--filter',
      '@alex-rewards/fraud',
      'exec',
      'vitest',
      'run',
      '--fileParallelism=false',
      'test/phase20-step4b-approved-policy.db.test.ts',
    ],
  );
  run(
    'eligibility-semantics (DB)',
    [
      '--filter',
      '@alex-rewards/fraud',
      'exec',
      'vitest',
      'run',
      '--fileParallelism=false',
      'test/phase20-eligibility-gate-semantics.db.test.ts',
    ],
  );
}

run('verify:boundaries', ['verify:boundaries']);
run('security:secrets', ['security:secrets']);
console.log('\n[phase20-step4b] PASS');