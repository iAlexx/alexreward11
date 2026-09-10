/**
 * Seal Phase 9 only after formal KMS spike evidence exists.
 * Usage:
 *   node scripts/seal-phase9.mjs --commit <sha> [--report docs/PHASE_09_ACCEPTANCE_REPORT.md]
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(
    'Usage: node scripts/seal-phase9.mjs --commit <sha> [--report docs/PHASE_09_ACCEPTANCE_REPORT.md]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
let commit = '';
let report = 'docs/PHASE_09_ACCEPTANCE_REPORT.md';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--commit') commit = args[++i] || '';
  else if (args[i] === '--report') report = args[++i] || report;
  else usage();
}
if (!/^[0-9a-f]{40}$/i.test(commit)) usage();

const reportPath = resolve(root, report);
const spikePath = resolve(root, 'kms-spike-report.json');
if (!existsSync(spikePath)) {
  console.error('PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE');
  console.error('Missing kms-spike-report.json. Run pnpm spike:kms first.');
  process.exit(2);
}
if (!existsSync(reportPath)) {
  console.error(`Missing acceptance report: ${reportPath}`);
  process.exit(2);
}

const spike = JSON.parse(readFileSync(spikePath, 'utf8'));
if (!spike.ok || spike.keySpec !== 'ECC_NIST_EDWARDS25519') {
  console.error('kms-spike-report.json is not a formal PASS for ECC_NIST_EDWARDS25519');
  process.exit(1);
}
if (spike.localSignatureVerification !== 'PASS') {
  console.error('kms-spike-report.json localSignatureVerification is not PASS');
  process.exit(1);
}

const reportText = readFileSync(reportPath, 'utf8');
for (const banned of ['AWS_SECRET_ACCESS_KEY=', 'AWS_SESSION_TOKEN=', 'BEGIN PRIVATE KEY']) {
  if (reportText.includes(banned)) {
    console.error(`Acceptance report must not contain secret material (${banned})`);
    process.exit(1);
  }
}

const archive = spawnSync(
  process.execPath,
  [
    join(root, 'scripts', 'create-phase-archive.mjs'),
    '--phase',
    '09',
    '--slug',
    'TON_TESTNET_SIGNER_SPIKE',
    '--commit',
    commit,
    '--report',
    reportPath,
    '--roadmap-version',
    '1.2',
    '--final-ci-url',
    'https://github.com/iAlexx/alexreward11/actions/runs/34422715453',
    '--quality-job',
    '102701408253:PASS',
    '--docker-smoke-job',
    '102702545301:PASS',
    '--next-phase-status',
    'No Phase 10 / Mainnet work started. Phase 9 proves signing boundary only.',
  ],
  { cwd: root, encoding: 'utf8', shell: false },
);
process.stdout.write(archive.stdout || '');
process.stderr.write(archive.stderr || '');
process.exit(archive.status ?? 1);
