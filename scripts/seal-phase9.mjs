/**
 * Phase 9 archive helper (historical).
 *
 * AWS KMS seal path is SUPERSEDED (Owner v1.3): AWS Ed25519 compatibility was
 * TECHNICALLY PROVEN historically, but AWS as production Hot Wallet signing
 * custody is OWNER REJECTED. Production target is apps/signer + self-hosted
 * encrypted Ed25519 (FALLBACK_ENCRYPTED). This script no longer requires
 * kms-spike-report.json and will not run the obsolete AWS seal gate.
 *
 * Archive tooling (`create-phase-archive.mjs`) remains available via
 * `pnpm archive:phase` when Owner explicitly requests a new archive.
 *
 * Usage (fails closed — do not use for new seals without Owner instruction):
 *   node scripts/seal-phase9.mjs --commit <sha> [--report docs/PHASE_09_ACCEPTANCE_REPORT.md]
 */
import { existsSync, readFileSync } from 'node:fs';
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
if (!existsSync(reportPath)) {
  console.error(`Missing acceptance report: ${reportPath}`);
  process.exit(2);
}

const reportText = readFileSync(reportPath, 'utf8');
for (const banned of ['AWS_SECRET_ACCESS_KEY=', 'AWS_SESSION_TOKEN=', 'BEGIN PRIVATE KEY']) {
  if (reportText.includes(banned)) {
    console.error(`Acceptance report must not contain secret material (${banned})`);
    process.exit(1);
  }
}

console.error('PHASE 9 AWS SEAL PATH SUPERSEDED');
console.error(
  'AWS KMS was historically proven for Ed25519 compatibility, but Owner rejected AWS as production signer custody.',
);
console.error(
  'Production target: apps/signer + self-hosted encrypted Ed25519 (FALLBACK_ENCRYPTED). No signer-custody migration required.',
);
console.error(
  'Do not create new Phase 9 archives via this AWS-era seal helper. Use `pnpm archive:phase` only when Owner explicitly requests an archive.',
);
console.error(`Commit argued: ${commit}`);
console.error(`Report: ${reportPath}`);
process.exit(2);
