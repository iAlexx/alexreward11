/**
 * Ingest a new AWS root/IAM access key for Phase 9 seal watchers.
 * Usage:
 *   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... pnpm ingest:phase9-aws-creds
 * Writes %TEMP%/phase9-root-ak.env (never prints secrets).
 * Verifies sts + account state + kms list-keys.
 */
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const id = String(process.env.AWS_ACCESS_KEY_ID || '').trim();
const secret = String(process.env.AWS_SECRET_ACCESS_KEY || '').trim();
if (!/^AKIA[0-9A-Z]{16}$/.test(id) || secret.length < 20) {
  console.error('Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (long-term keys).');
  process.exit(2);
}

delete process.env.AWS_SESSION_TOKEN;
delete process.env.AWS_PROFILE;
process.env.AWS_DEFAULT_REGION = process.env.AWS_DEFAULT_REGION || 'eu-central-1';

const aws =
  process.platform === 'win32' ? 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe' : 'aws';

const envPath = join(tmpdir(), 'phase9-root-ak.env');
writeFileSync(
  envPath,
  [`AWS_ACCESS_KEY_ID=${id}`, `AWS_SECRET_ACCESS_KEY=${secret}`, ''].join('\n'),
  { encoding: 'utf8', mode: 0o600 },
);

const ident = spawnSync(aws, ['sts', 'get-caller-identity', '--output', 'json'], {
  encoding: 'utf8',
  env: process.env,
});
if (ident.status !== 0) {
  console.error(ident.stderr || ident.stdout || 'sts failed');
  process.exit(ident.status ?? 1);
}
const account = JSON.parse(ident.stdout).Account;
console.log(`ingested=1 account=${account} env=${envPath}`);

const info = spawnSync(aws, ['account', 'get-account-information', '--output', 'json'], {
  encoding: 'utf8',
  env: process.env,
});
if (info.status === 0) {
  const st = JSON.parse(info.stdout).AccountState;
  console.log(`AccountState=${st}`);
} else {
  console.log('AccountState=unknown');
}

const kms = spawnSync(aws, ['kms', 'list-keys', '--max-items', '1'], {
  encoding: 'utf8',
  env: process.env,
});
console.log(`kms_list_keys_rc=${kms.status}`);
if (kms.status === 0) {
  console.log('KMS ready — run: SIGNER_AWS_REGION=eu-central-1 pnpm seal:phase9:kms');
} else {
  console.log('KMS not ready yet; watchers will keep polling this env file.');
}
