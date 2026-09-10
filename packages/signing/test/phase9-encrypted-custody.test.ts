import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signVerify } from '@ton/crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  EncryptedLocalSigningProvider,
  SignerError,
  decryptKeyBundle,
  encryptKeyBundle,
  generateHotWalletSeed,
  identityFromSeed,
  writeKeyBundleFile,
} from '../src/index.js';

const PASSPHRASE = 'phase9-amendment-test-passphrase-ok';
/** Fast Argon2id params for unit tests only — not production defaults. */
const TEST_KDF = { memory: 16, passes: 1, parallelism: 1, dkLen: 32 } as const;
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function enc(seed: Buffer) {
  return encryptKeyBundle({ seed, passphrase: PASSPHRASE, kdfParams: TEST_KDF });
}

describe('Phase 9 amendment — encrypted key bundle', () => {
  it('generate -> encrypt -> decrypt -> same public identity', () => {
    const seed = generateHotWalletSeed();
    const identity = identityFromSeed(seed);
    const bundle = enc(seed);
    const material = decryptKeyBundle(bundle, PASSPHRASE);
    expect(material.publicKeyFingerprint).toBe(identity.publicKeyFingerprint);
    expect(material.addressRaw).toBe(identity.addressRaw);
    expect(Buffer.compare(material.publicKey, identity.publicKey)).toBe(0);
  });

  it('uses random salt/nonce across encryptions of the same seed', () => {
    const seed = Buffer.alloc(32, 7);
    const a = enc(seed);
    const b = enc(seed);
    expect(a.saltB64).not.toBe(b.saltB64);
    expect(a.nonceB64).not.toBe(b.nonceB64);
    expect(a.ciphertextB64).not.toBe(b.ciphertextB64);
    expect(a.publicKeyFingerprint).toBe(b.publicKeyFingerprint);
  });

  it('rejects wrong passphrase fail-closed', () => {
    const bundle = enc(generateHotWalletSeed());
    expect(() => decryptKeyBundle(bundle, 'wrong-passphrase-xxxxxx')).toThrow(SignerError);
    try {
      decryptKeyBundle(bundle, 'wrong-passphrase-xxxxxx');
    } catch (error) {
      expect(error).toBeInstanceOf(SignerError);
      expect((error as SignerError).code).toBe('KEY_DECRYPT_FAILED');
    }
  });

  it('rejects modified ciphertext', () => {
    const bundle = enc(generateHotWalletSeed());
    const ct = Buffer.from(bundle.ciphertextB64, 'base64');
    ct[0] = (ct[0]! + 1) % 256;
    const tampered = { ...bundle, ciphertextB64: ct.toString('base64') };
    expect(() => decryptKeyBundle(tampered, PASSPHRASE)).toThrow(SignerError);
  });

  it('rejects modified metadata (fingerprint)', () => {
    const bundle = enc(generateHotWalletSeed());
    const tampered = {
      ...bundle,
      publicKeyFingerprint: 'aa'.repeat(32),
    };
    expect(() => decryptKeyBundle(tampered, PASSPHRASE)).toThrow(SignerError);
  });

  it('rejects malformed bundle and unsupported version', () => {
    expect(() =>
      decryptKeyBundle(
        {
          formatVersion: 99,
          kdf: 'argon2id',
          kdfParams: { memory: 1024, passes: 1, parallelism: 1, dkLen: 32 },
          saltB64: Buffer.alloc(16).toString('base64'),
          aead: 'xchacha20poly1305',
          nonceB64: Buffer.alloc(24).toString('base64'),
          ciphertextB64: Buffer.alloc(48).toString('base64'),
          publicKeyFingerprint: 'aa'.repeat(32),
          networkGlobalId: -3,
          walletVersion: 'v5R1',
          workchain: 0,
          derivedAddressRaw: '0:aa',
        } as never,
        PASSPHRASE,
      ),
    ).toThrow(/Unsupported|KEY_BUNDLE_INVALID|format/);

    const good = enc(generateHotWalletSeed());
    const raw = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
    delete raw.ciphertextB64;
    expect(() => decryptKeyBundle(raw as never, PASSPHRASE)).toThrow(SignerError);
  });

  it('encrypted file contains no plaintext key/mnemonic/seed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alex-bundle-'));
    dirs.push(dir);
    const path = join(dir, 'hot-wallet.enc');
    const seed = generateHotWalletSeed();
    const bundle = enc(seed);
    writeKeyBundleFile(path, bundle);
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/mnemonic/i);
    expect(text).not.toMatch(/BEGIN PRIVATE/i);
    expect(text).not.toContain(seed.toString('hex'));
    expect(text).not.toContain(seed.toString('base64'));
    const parsed = JSON.parse(text) as { ciphertextB64?: string };
    expect(parsed.ciphertextB64).toBeTruthy();
  });
});

describe('Phase 9 amendment — lock / unlock lifecycle', () => {
  it('boots LOCKED; sign while LOCKED rejected; unlock then sign; wrong unlock stays LOCKED; re-lock stops signing', async () => {
    const seed = generateHotWalletSeed();
    const bundle = enc(seed);
    const provider = new EncryptedLocalSigningProvider({ bundle });
    expect(provider.custodyState).toBe('LOCKED');
    expect(provider.isSigningReady()).toBe(false);
    await expect(provider.signEd25519RawMessage(Buffer.alloc(32, 1))).rejects.toMatchObject({
      code: 'SIGNER_LOCKED',
    });

    await expect(provider.unlock('wrong-passphrase-xxxx')).rejects.toBeInstanceOf(SignerError);
    expect(provider.custodyState).toBe('LOCKED');

    await provider.unlock(PASSPHRASE);
    expect(provider.custodyState).toBe('UNLOCKED');
    expect(provider.isSigningReady()).toBe(true);
    const pk = await provider.getPublicKey();
    const msg = Buffer.alloc(32, 9);
    const sig = await provider.signEd25519RawMessage(msg);
    expect(signVerify(msg, sig, pk)).toBe(true);

    provider.relock();
    expect(provider.custodyState).toBe('LOCKED');
    await expect(provider.signEd25519RawMessage(msg)).rejects.toMatchObject({
      code: 'SIGNER_LOCKED',
    });
  });

  it('restart semantics: new provider instance starts LOCKED', async () => {
    const seed = generateHotWalletSeed();
    const bundle = enc(seed);
    const a = new EncryptedLocalSigningProvider({ bundle });
    await a.unlock(PASSPHRASE);
    expect(a.isSigningReady()).toBe(true);
    const b = new EncryptedLocalSigningProvider({ bundle });
    expect(b.custodyState).toBe('LOCKED');
    expect(b.isSigningReady()).toBe(false);
  });

  it('rejects identity mismatch and wrong network', async () => {
    const seed = generateHotWalletSeed();
    const identity = identityFromSeed(seed);
    const bundle = enc(seed);
    const wrongFp = new EncryptedLocalSigningProvider({
      bundle,
      expectedPublicKeyFingerprint: 'bb'.repeat(32),
    });
    await expect(wrongFp.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: 'KEY_IDENTITY_MISMATCH',
    });
    const wrongAddr = new EncryptedLocalSigningProvider({
      bundle,
      expectedHotWalletAddressRaw:
        '0:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    });
    await expect(wrongAddr.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: 'KEY_IDENTITY_MISMATCH',
    });
    const wrongNet = new EncryptedLocalSigningProvider({
      bundle,
      expectedNetworkGlobalId: -239,
    });
    await expect(wrongNet.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: 'KEY_IDENTITY_MISMATCH',
    });
    void identity;
  });

  it('forbids MAINNET networkGlobalId in Phase 9 key generation', () => {
    const seed = generateHotWalletSeed();
    expect(() => identityFromSeed(seed, { networkGlobalId: -239, workchain: 0 })).toThrow(
      /MAINNET/,
    );
  });
});
