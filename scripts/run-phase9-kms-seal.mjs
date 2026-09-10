/**
 * After AWS account leaves PENDING_ACTIVATION:
 * provision TEST/SPIKE ECC_NIST_EDWARDS25519 key → formal spike →
 * patch acceptance report G with safe metadata → dual archive.
 *
 * Never prints credentials. Refuses mocks / incomplete reports.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hydrateAwsLoginEnvFromCli } from './aws-login-env.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const region = process.env.SIGNER_AWS_REGION || process.env.AWS_REGION || 'eu-central-1';
process.env.SIGNER_AWS_REGION = region;
process.env.AWS_REGION = region;
process.env.AWS_DEFAULT_REGION = region;

function awsBin() {
  if (process.platform === 'win32') return 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe';
  return 'aws';
}

function runCaptured(bin, args) {
  return spawnSync(bin, args, {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });
}

hydrateAwsLoginEnvFromCli();

const accountProc = runCaptured(awsBin(), [
  'account',
  'get-account-information',
  '--output',
  'json',
]);
if (accountProc.status === 0) {
  const info = JSON.parse(accountProc.stdout);
  if (info.AccountState === 'PENDING_ACTIVATION') {
    console.error('PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE');
    console.error(
      `AccountState=PENDING_ACTIVATION (account ${info.AccountId}). Finish payment/PI vet first.`,
    );
    process.exit(2);
  }
}

const provision = runCaptured(process.execPath, [
  join(root, 'scripts', 'provision-kms-spike-key.mjs'),
]);
process.stdout.write(provision.stdout || '');
process.stderr.write(provision.stderr || '');
if (provision.status !== 0) process.exit(provision.status ?? 1);

const arnMatch = /"keyArn":\s*"(arn:aws:kms:[^"]+)"/.exec(provision.stdout || '');
if (!arnMatch) {
  console.error('Could not parse keyArn from provision output');
  process.exit(1);
}
process.env.SIGNER_KMS_KEY_ARN = arnMatch[1];

const spike = runCaptured(process.execPath, [join(root, 'scripts', 'spike-kms-compatibility.mjs')]);
process.stdout.write(spike.stdout || '');
process.stderr.write(spike.stderr || '');
if (spike.status !== 0) process.exit(spike.status ?? 1);

const spikePath = resolve(root, 'kms-spike-report.json');
if (!existsSync(spikePath)) {
  console.error('Missing kms-spike-report.json after spike');
  process.exit(1);
}
const reportJson = JSON.parse(readFileSync(spikePath, 'utf8'));
if (!reportJson.ok || reportJson.keySpec !== 'ECC_NIST_EDWARDS25519') {
  console.error('Formal spike did not PASS ECC_NIST_EDWARDS25519');
  process.exit(1);
}

const safe = {
  ok: reportJson.ok,
  region: reportJson.region,
  keySpec: reportJson.keySpec,
  keyUsage: reportJson.keyUsage,
  signingAlgorithm: reportJson.signingAlgorithm,
  messageType: reportJson.messageType,
  publicKeyFingerprint: reportJson.publicKeyFingerprint,
  messageHashFingerprint: reportJson.messageHashFingerprint,
  localSignatureVerification: reportJson.localSignatureVerification,
  repeatability: reportJson.repeatability,
  alteredMessageRejects: reportJson.alteredMessageRejects,
  derivedTestnetWalletV5R1: reportJson.derivedTestnetWalletV5R1,
  note: reportJson.note,
};

const reportPath = resolve(root, 'docs/PHASE_09_ACCEPTANCE_REPORT.md');
let report = readFileSync(reportPath, 'utf8');
const evidence = [
  '**KMS compatibility: PASS (real AWS ECC_NIST_EDWARDS25519)**',
  '',
  'Safe metadata only (from `kms-spike-report.json`):',
  '',
  '```json',
  JSON.stringify(safe, null, 2),
  '```',
  '',
].join('\n');

report = report.replace(
  /\*\*Status:\*\*[^\n]+/,
  '**Status:** ACCEPTED RUNTIME — ordinary CI PASS + formal KMS spike PASS. Sealed dual archive follows.',
);
if (!/## G\. Real KMS compatibility evidence/.test(report)) {
  console.error('Acceptance report missing section G');
  process.exit(1);
}
report = report.replace(
  /## G\. Real KMS compatibility evidence[\s\S]*?(?=\n## H\. )/m,
  `## G. Real KMS compatibility evidence\n\n${evidence}`,
);
writeFileSync(reportPath, `${report.trimEnd()}\n`, 'utf8');

const commit = runCaptured(process.platform === 'win32' ? 'git.exe' : 'git', [
  'rev-parse',
  'HEAD',
]).stdout.trim();
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  console.error('Unable to resolve HEAD commit');
  process.exit(1);
}

const seal = runCaptured(process.execPath, [
  join(root, 'scripts', 'seal-phase9.mjs'),
  '--commit',
  commit,
  '--report',
  reportPath,
]);
process.stdout.write(seal.stdout || '');
process.stderr.write(seal.stderr || '');
process.exit(seal.status ?? 1);
