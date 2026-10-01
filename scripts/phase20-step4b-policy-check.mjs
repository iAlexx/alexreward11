/**
 * Phase 20 Step 4B / 4B.1 — Owner-approved policy static check (+ optional disposable DB gate).
 * Never mutates operational/staging DB. Never activates live policies.
 * Loads the approved JSON only via test/tool paths — not via @alex-rewards/fraud runtime exports.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
console.log('[phase20-step4b] runtime package must not load Phase20 approved JSON');

if (requireDb && !(process.env.PHASE20_DATABASE_URL ?? '')) {
  console.error('[phase20-step4b] PHASE20_STEP4B_REQUIRE_DB_GATES=1 requires PHASE20_DATABASE_URL');
  process.exit(1);
}

const artifactPath = join(
  root,
  'packages/fraud/policy/phase20-closed-beta-owner-approved.json',
);
const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
if (artifact.activationAuthorized !== false) {
  console.error('[phase20-step4b] FAIL activationAuthorized must be false');
  process.exit(1);
}
if (artifact.artifactId !== 'PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY') {
  console.error('[phase20-step4b] FAIL unexpected artifactId');
  process.exit(1);
}
console.log('[phase20-step4b] tool-loaded artifact OK (activationAuthorized=false)');

run('phase20-gap-register', ['phase20:gap-register:check']);
run('fraud-typecheck', ['--filter', '@alex-rewards/fraud', 'typecheck']);
run('fraud-build', ['--filter', '@alex-rewards/fraud', 'build']);
run('approved-policy-unit', [
  '--filter',
  '@alex-rewards/fraud',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase20-step4b-approved-policy.unit.test.ts',
]);
run('runtime-decoupling-unit', [
  '--filter',
  '@alex-rewards/fraud',
  'exec',
  'vitest',
  'run',
  '--fileParallelism=false',
  'test/phase20-step4b-runtime-decoupling.unit.test.ts',
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
  run('approved-policy (DB)', [
    '--filter',
    '@alex-rewards/fraud',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/phase20-step4b-approved-policy.db.test.ts',
  ]);
  run('eligibility-semantics (DB)', [
    '--filter',
    '@alex-rewards/fraud',
    'exec',
    'vitest',
    'run',
    '--fileParallelism=false',
    'test/phase20-eligibility-gate-semantics.db.test.ts',
  ]);
}

console.log('\n=== built-package-import ===');
const fraudPkg = join(root, 'packages/fraud');
const built = await import(pathToFileURL(join(fraudPkg, 'dist/index.js')).href);
if (Object.prototype.hasOwnProperty.call(built, 'PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY')) {
  console.error('[phase20-step4b] FAIL built export still exposes PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY');
  process.exit(1);
}
const distText = readFileSync(join(fraudPkg, 'dist/index.js'), 'utf8');
if (
  distText.includes('phase20-closed-beta-owner-approved.json') ||
  distText.includes('phase20-closed-beta-approved-policy')
) {
  console.error('[phase20-step4b] FAIL dist/index.js still references Phase20 approved policy');
  process.exit(1);
}
console.log('[phase20-step4b] built-package-import exit=0');

run('verify:boundaries', ['verify:boundaries']);
run('security:secrets', ['security:secrets']);
console.log('\n[phase20-step4b] PASS');