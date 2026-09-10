import { createHash } from 'node:crypto';

import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  DescribeKeyCommand,
} from '@aws-sdk/client-kms';

import type { KmsKeyDescription, SignPort } from '@alex-rewards/signing';
import { SignerError } from '@alex-rewards/signing';

/**
 * Real AWS KMS Ed25519 adapter.
 * Signs exact message bytes with ED25519_SHA_512 + MessageType RAW.
 */
export class AwsKmsSignPort implements SignPort {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(options: { region: string; keyArn: string }) {
    this.client = new KMSClient({ region: options.region });
    this.keyId = options.keyArn;
  }

  async getPublicKey(): Promise<Buffer> {
    const response = await this.client.send(new GetPublicKeyCommand({ KeyId: this.keyId }));
    if (!response.PublicKey) {
      throw new SignerError('KMS_REJECTED', 'KMS GetPublicKey returned empty public key');
    }
    if (String(response.KeySpec ?? '') !== 'ECC_NIST_EDWARDS25519') {
      throw new SignerError('KMS_REJECTED', 'KMS key spec must be ECC_NIST_EDWARDS25519', {
        keySpec: response.KeySpec,
      });
    }
    if (String(response.KeyUsage ?? '') !== 'SIGN_VERIFY') {
      throw new SignerError('KMS_REJECTED', 'KMS key usage must be SIGN_VERIFY', {
        keyUsage: response.KeyUsage,
      });
    }
    return extractEd25519PublicKey(Buffer.from(response.PublicKey));
  }

  async signEd25519RawMessage(message: Buffer): Promise<Buffer> {
    const response = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: message,
        MessageType: 'RAW',
        // Ed25519 algorithms require a current AWS account/API; cast keeps compile-time
        // compatibility with pinned SDK while documenting the exact algorithm used at runtime.
        SigningAlgorithm: 'ED25519_SHA_512' as never,
      }),
    );
    if (!response.Signature) {
      throw new SignerError('KMS_REJECTED', 'KMS Sign returned empty signature');
    }
    return Buffer.from(response.Signature);
  }

  async describe(): Promise<KmsKeyDescription> {
    const response = await this.client.send(new DescribeKeyCommand({ KeyId: this.keyId }));
    const meta = response.KeyMetadata;
    return {
      keySpec: meta?.KeySpec ?? 'UNKNOWN',
      keyUsage: meta?.KeyUsage ?? 'UNKNOWN',
      signingAlgorithm: 'ED25519_SHA_512',
      messageType: 'RAW',
    };
  }
}

/** Extract raw 32-byte Ed25519 public key from SubjectPublicKeyInfo DER. */
export function extractEd25519PublicKey(spkiDer: Buffer): Buffer {
  // SPKI for Ed25519 ends with 0x03 0x21 0x00 || 32-byte key
  if (spkiDer.length >= 32) {
    const raw = spkiDer.subarray(spkiDer.length - 32);
    if (raw.length === 32) return Buffer.from(raw);
  }
  throw new SignerError('KMS_REJECTED', 'Unable to parse Ed25519 public key from KMS SPKI');
}

export function fingerprintPublicKey(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}
