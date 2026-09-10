import { createHash, randomBytes } from 'node:crypto';

import { keyPairFromSeed, sign } from '@ton/crypto';

import type { SigningKeyDescription, SignPort } from './signing-key-provider.js';

/**
 * TEST/SPIKE ONLY — ephemeral in-process Ed25519 key.
 * Does NOT satisfy production self-hosted encrypted custody requirements.
 */
export class LocalEphemeralSignPort implements SignPort {
  readonly kind = 'local_ephemeral' as const;
  private readonly keyPair: { publicKey: Buffer; secretKey: Buffer };

  constructor(seed?: Buffer) {
    const material = seed ?? randomBytes(32);
    if (material.length !== 32) {
      throw new Error('LocalEphemeralSignPort seed must be 32 bytes');
    }
    this.keyPair = keyPairFromSeed(material);
  }

  async getPublicKey(): Promise<Buffer> {
    return Buffer.from(this.keyPair.publicKey);
  }

  async signEd25519RawMessage(message: Buffer): Promise<Buffer> {
    return Buffer.from(sign(message, this.keyPair.secretKey));
  }

  async describe(): Promise<SigningKeyDescription> {
    return {
      keySpec: 'LOCAL_EPHEMERAL_ED25519',
      keyUsage: 'SIGN_VERIFY',
      signingAlgorithm: 'ED25519_SHA_512',
      messageType: 'RAW',
      provider: 'LocalEphemeralSignPort',
    };
  }

  publicKeyFingerprint(): string {
    return createHash('sha256').update(this.keyPair.publicKey).digest('hex');
  }
}

export function publicKeyFingerprint(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}
