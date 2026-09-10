import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { signVerify } from '@ton/crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ARGON2ID_V1_BOUNDS,
  EncryptedLocalSigningProvider,
  SignerError,
  assertArgon2idParamsV1,
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

  it('failed second unlock after UNLOCKED destroys key A and remains LOCKED', async () => {
    const seedA = generateHotWalletSeed();
    const seedB = generateHotWalletSeed();
    const identityA = identityFromSeed(seedA);
    const bundleA = enc(seedA);
    const bundleB = enc(seedB);

    const provider = new EncryptedLocalSigningProvider({
      bundle: bundleA,
      expectedPublicKeyFingerprint: identityA.publicKeyFingerprint,
    });
    await provider.unlock(PASSPHRASE);
    expect(provider.custodyState).toBe('UNLOCKED');
    expect(provider.isSigningReady()).toBe(true);
    const msg = Buffer.alloc(32, 3);
    const sigA = await provider.signEd25519RawMessage(msg);
    expect(signVerify(msg, sigA, await provider.getPublicKey())).toBe(true);

    // Different valid encrypted bundle B cannot satisfy expected fingerprint of A.
    provider.replaceBundle(bundleB);
    await expect(provider.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: 'KEY_IDENTITY_MISMATCH',
    });
    expect(provider.custodyState).toBe('LOCKED');
    expect(provider.isSigningReady()).toBe(false);
    await expect(provider.signEd25519RawMessage(msg)).rejects.toMatchObject({
      code: 'SIGNER_LOCKED',
    });
    await expect(provider.getPublicKey()).rejects.toMatchObject({ code: 'SIGNER_LOCKED' });
  });

  it('every unlock failure class fail-closes even when previously UNLOCKED', async () => {
    const seed = generateHotWalletSeed();
    const bundle = enc(seed);
    const provider = new EncryptedLocalSigningProvider({ bundle });
    const msg = Buffer.alloc(32, 5);

    await provider.unlock(PASSPHRASE);
    expect(provider.isSigningReady()).toBe(true);

    // KEY_DECRYPT_FAILED
    await expect(provider.unlock('wrong-passphrase-xxxx')).rejects.toMatchObject({
      code: 'KEY_DECRYPT_FAILED',
    });
    expect(provider.custodyState).toBe('LOCKED');
    expect(provider.isSigningReady()).toBe(false);
    await expect(provider.signEd25519RawMessage(msg)).rejects.toMatchObject({
      code: 'SIGNER_LOCKED',
    });

    // KEY_BUNDLE_INVALID (unsupported version)
    await provider.unlock(PASSPHRASE);
    provider.replaceBundle({ ...bundle, formatVersion: 99 as never });
    await expect(provider.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: 'KEY_BUNDLE_INVALID',
    });
    expect(provider.custodyState).toBe('LOCKED');

    // KEY_IDENTITY_MISMATCH (network)
    provider.replaceBundle(bundle);
    await provider.unlock(PASSPHRASE);
    provider.replaceBundle({ ...bundle, networkGlobalId: -239 });
    await expect(provider.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: 'KEY_IDENTITY_MISMATCH',
    });
    expect(provider.custodyState).toBe('LOCKED');
    expect(provider.isSigningReady()).toBe(false);

    // KEY_BUNDLE_MISSING
    const empty = new EncryptedLocalSigningProvider({});
    await expect(empty.unlock(PASSPHRASE)).rejects.toMatchObject({
      code: 'KEY_BUNDLE_MISSING',
    });
    expect(empty.custodyState).toBe('LOCKED');
  });
});

describe('Phase 9 amendment — Argon2id KDF parameter bounds', () => {
  it('accepts DEFAULT and test params within v1 bounds', () => {
    expect(assertArgon2idParamsV1({ memory: 16, passes: 1, parallelism: 1, dkLen: 32 })).toEqual({
      memory: 16,
      passes: 1,
      parallelism: 1,
      dkLen: 32,
    });
    expect(
      assertArgon2idParamsV1({ memory: 65_536, passes: 3, parallelism: 1, dkLen: 32 }).dkLen,
    ).toBe(32);
  });

  it('rejects zero, negative, non-finite, and out-of-bounds KDF metadata before Argon2id', () => {
    const base = { memory: 16, passes: 1, parallelism: 1, dkLen: 32 };
    const badCases: Array<Record<string, unknown>> = [
      { ...base, memory: 0 },
      { ...base, memory: -1 },
      { ...base, memory: Number.NaN },
      { ...base, memory: Number.POSITIVE_INFINITY },
      { ...base, memory: 1.5 },
      { ...base, memory: ARGON2ID_V1_BOUNDS.memoryMaxKiB + 1 },
      { ...base, passes: 0 },
      { ...base, passes: ARGON2ID_V1_BOUNDS.passesMax + 1 },
      { ...base, parallelism: 0 },
      { ...base, parallelism: ARGON2ID_V1_BOUNDS.parallelismMax + 1 },
      { ...base, dkLen: 16 },
      { ...base, dkLen: 64 },
      { ...base, dkLen: 0 },
      { ...base, memory: 10_000_000 }, // unreasonable RAM
      { ...base, passes: 1_000_000 }, // unreasonable CPU
    ];
    for (const bad of badCases) {
      expect(() => assertArgon2idParamsV1(bad)).toThrow(SignerError);
    }
  });

  it('decrypt rejects tampered KDF metadata requesting unreasonable resources', () => {
    const bundle = enc(generateHotWalletSeed());
    const hostile = {
      ...bundle,
      kdfParams: {
        memory: 50_000_000,
        passes: 1_000_000,
        parallelism: 64,
        dkLen: 32,
      },
    };
    expect(() => decryptKeyBundle(hostile, PASSPHRASE)).toThrow(SignerError);
    try {
      decryptKeyBundle(hostile, PASSPHRASE);
    } catch (error) {
      expect(error).toBeInstanceOf(SignerError);
      expect((error as SignerError).code).toBe('KEY_BUNDLE_INVALID');
    }
  });
});
