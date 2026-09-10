import { describe, expect, it } from 'vitest';

import { SignerError } from '@alex-rewards/signing';

import { extractEd25519PublicKey } from '../src/kms/aws-kms.js';

describe('AWS KMS SPKI public-key extraction', () => {
  it('extracts the trailing 32-byte Ed25519 raw key from SPKI DER', () => {
    const raw = Buffer.alloc(32, 7);
    // Minimal fake SPKI wrapper: prefix || raw key
    const spki = Buffer.concat([Buffer.from([0x30, 0x2a, 0x03, 0x21, 0x00]), raw]);
    expect(extractEd25519PublicKey(spki).equals(raw)).toBe(true);
  });

  it('rejects undersized material', () => {
    expect(() => extractEd25519PublicKey(Buffer.alloc(16, 1))).toThrow(SignerError);
  });
});
