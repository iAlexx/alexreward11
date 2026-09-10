/**
 * Real AWS KMS ECC_NIST_EDWARDS25519 compatibility spike entrypoint.
 * Formal PASS requires live AWS credentials + ECC_NIST_EDWARDS25519 key.
 */
const region = process.env.SIGNER_AWS_REGION;
const keyArn = process.env.SIGNER_KMS_KEY_ARN;

function blocked(reason) {
  console.error('PHASE 9 BLOCKED — REAL KMS SPIKE ENVIRONMENT UNAVAILABLE');
  console.error(reason);
  process.exit(2);
}

if (!region || !keyArn) {
  blocked('SIGNER_AWS_REGION and SIGNER_KMS_KEY_ARN are required for the formal KMS spike.');
}

const { createRequire } = await import('node:module');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const { createHash } = await import('node:crypto');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromSigning = createRequire(join(root, 'packages', 'signing', 'package.json'));
const requireFromSigner = createRequire(join(root, 'apps', 'signer', 'package.json'));

let kms;
let tonCrypto;
let tonTon;
let tonCore;
try {
  kms = requireFromSigner('@aws-sdk/client-kms');
  tonCrypto = requireFromSigning('@ton/crypto');
  tonTon = requireFromSigning('@ton/ton');
  tonCore = requireFromSigning('@ton/core');
} catch (error) {
  blocked(
    `Unable to load spike dependencies: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const client = new kms.KMSClient({ region });
try {
  await client.config.credentials();
} catch (error) {
  blocked(`AWS credentials unavailable: ${error instanceof Error ? error.message : String(error)}`);
}

const describe = await client.send(new kms.DescribeKeyCommand({ KeyId: keyArn }));
const keySpec = describe.KeyMetadata?.KeySpec;
const keyUsage = describe.KeyMetadata?.KeyUsage;
if (String(keySpec) !== 'ECC_NIST_EDWARDS25519') {
  console.error(JSON.stringify({ ok: false, reason: 'wrong key spec', keySpec }, null, 2));
  process.exit(1);
}
if (String(keyUsage) !== 'SIGN_VERIFY') {
  console.error(JSON.stringify({ ok: false, reason: 'wrong key usage', keyUsage }, null, 2));
  process.exit(1);
}

const pub = await client.send(new kms.GetPublicKeyCommand({ KeyId: keyArn }));
const spki = Buffer.from(pub.PublicKey);
const publicKey = spki.subarray(spki.length - 32);
const fingerprint = createHash('sha256').update(publicKey).digest('hex');

const wallet = tonTon.WalletContractV5R1.create({
  publicKey,
  workchain: 0,
  walletId: { networkGlobalId: -3 },
});
const message = tonCore.beginCell().storeUint(1, 32).storeBuffer(Buffer.alloc(28, 7)).endCell();
const signingHash = Buffer.from(message.hash());

const signed = await client.send(
  new kms.SignCommand({
    KeyId: keyArn,
    Message: signingHash,
    MessageType: 'RAW',
    SigningAlgorithm: 'ED25519_SHA_512',
  }),
);
const signature = Buffer.from(signed.Signature);
const verifyPass = tonCrypto.signVerify(signingHash, signature, publicKey);

const signedAgain = await client.send(
  new kms.SignCommand({
    KeyId: keyArn,
    Message: signingHash,
    MessageType: 'RAW',
    SigningAlgorithm: 'ED25519_SHA_512',
  }),
);
const repeatPass = Buffer.from(signedAgain.Signature).equals(signature);

const altered = Buffer.alloc(signingHash.length);
signingHash.copy(altered);
altered.writeUInt8(altered.readUInt8(0) ^ 0xff, 0);
const alteredFail = !tonCrypto.signVerify(altered, signature, publicKey);

const report = {
  ok: verifyPass && repeatPass && alteredFail,
  region,
  keySpec,
  keyUsage,
  signingAlgorithm: 'ED25519_SHA_512',
  messageType: 'RAW',
  publicKeyFingerprint: fingerprint,
  messageHashFingerprint: createHash('sha256').update(signingHash).digest('hex'),
  localSignatureVerification: verifyPass ? 'PASS' : 'FAIL',
  repeatability: repeatPass ? 'PASS' : 'FAIL',
  alteredMessageRejects: alteredFail ? 'PASS' : 'FAIL',
  derivedTestnetWalletV5R1: wallet.address.toRawString(),
  note: 'No TON broadcast. Formal Phase 9 gate evidence only.',
};

console.log(JSON.stringify(report, null, 2));

const { writeFileSync } = await import('node:fs');
writeFileSync('kms-spike-report.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

process.exit(report.ok ? 0 : 1);
