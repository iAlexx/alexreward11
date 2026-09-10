/**
 * Create a TEST/SPIKE-only AWS KMS ECC_NIST_EDWARDS25519 signing key.
 * Does not archive credentials. Does not satisfy the formal spike by itself —
 * run `pnpm spike:kms` afterward against the printed ARN.
 *
 * Requires normal AWS credential resolution (env / profile / IAM role).
 */
const region = process.env.SIGNER_AWS_REGION || process.env.AWS_REGION;
if (!region) {
  console.error('PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE');
  console.error('Set SIGNER_AWS_REGION (or AWS_REGION) before provisioning.');
  process.exit(2);
}

const { createRequire } = await import('node:module');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromSigner = createRequire(join(root, 'apps', 'signer', 'package.json'));

let kms;
try {
  kms = requireFromSigner('@aws-sdk/client-kms');
} catch (error) {
  console.error('Unable to load @aws-sdk/client-kms from apps/signer:', error);
  process.exit(2);
}

const client = new kms.KMSClient({ region });
try {
  await client.config.credentials();
} catch (error) {
  console.error('PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE');
  console.error(
    `AWS credentials unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const created = await client.send(
  new kms.CreateKeyCommand({
    Description: 'ALEx Rewards Phase 9 TESTNET signer spike (ECC_NIST_EDWARDS25519)',
    KeyUsage: 'SIGN_VERIFY',
    KeySpec: 'ECC_NIST_EDWARDS25519',
    MultiRegion: false,
    Tags: [
      { TagKey: 'alex-rewards-phase', TagValue: '09' },
      { TagKey: 'alex-rewards-purpose', TagValue: 'testnet-signer-spike' },
      { TagKey: 'alex-rewards-mainnet', TagValue: 'false' },
    ],
  }),
);

const keyId = created.KeyMetadata?.KeyId;
const keyArn = created.KeyMetadata?.Arn;
const keySpec = created.KeyMetadata?.KeySpec;
const keyUsage = created.KeyMetadata?.KeyUsage;

if (!keyArn || String(keySpec) !== 'ECC_NIST_EDWARDS25519') {
  console.error(JSON.stringify({ ok: false, keyId, keyArn, keySpec, keyUsage }, null, 2));
  process.exit(1);
}

await client
  .send(
    new kms.CreateAliasCommand({
      AliasName: `alias/alex-rewards-phase9-spike-${String(keyId).slice(0, 8)}`,
      TargetKeyId: keyId,
    }),
  )
  .catch(() => {
    /* alias is convenience-only; ARN is authoritative */
  });

const out = {
  ok: true,
  region,
  keySpec,
  keyUsage,
  keyArn,
  next: [
    `export SIGNER_AWS_REGION=${region}`,
    `export SIGNER_KMS_KEY_ARN=${keyArn}`,
    'pnpm spike:kms',
    'Or set the same values as GitHub Actions secrets and dispatch Phase 9 KMS Spike.',
  ],
};

console.log(JSON.stringify(out, null, 2));
