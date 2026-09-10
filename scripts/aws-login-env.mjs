/**
 * Hydrate process.env from `aws login` / CLI credential chain when the
 * Node AWS SDK default provider cannot see login-session credentials.
 * Never prints secret values.
 */
import { spawnSync } from 'node:child_process';

export function hydrateAwsLoginEnvFromCli() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return { hydrated: false, reason: 'env-already-set' };
  }

  const candidates =
    process.platform === 'win32'
      ? ['aws.exe', 'C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe', 'aws']
      : ['aws'];

  let result;
  for (const bin of candidates) {
    result = spawnSync(bin, ['configure', 'export-credentials', '--format', 'env-no-export'], {
      encoding: 'utf8',
      shell: false,
      env: process.env,
    });
    if (result.error?.code === 'ENOENT') continue;
    break;
  }
  if (!result || result.error?.code === 'ENOENT') {
    return { hydrated: false, reason: 'aws CLI not found on PATH' };
  }
  if (result.status !== 0) {
    return {
      hydrated: false,
      reason: (result.stderr || result.stdout || 'aws export-credentials failed').trim(),
    };
  }

  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = /^(AWS_[A-Z_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    process.env[match[1]] = match[2];
  }

  if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
    return { hydrated: false, reason: 'export-credentials produced no access key' };
  }

  return { hydrated: true, reason: 'aws-login-cli' };
}

export function formatKmsServiceError(error) {
  const name = error && typeof error === 'object' ? error.name || error.__type : '';
  const message = error instanceof Error ? error.message : String(error);
  if (
    String(name).includes('SubscriptionRequired') ||
    /subscription for the service/i.test(message)
  ) {
    return (
      'AWS credentials resolved, but KMS is not subscribed on this account ' +
      `(SubscriptionRequiredException). Activate AWS billing/KMS, then retry. Detail: ${message}`
    );
  }
  return message;
}
