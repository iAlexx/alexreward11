import { describe, expect, it } from 'vitest';

import {
  SignerError,
  decryptKeyBundle,
  encryptKeyBundle,
  generateHotWalletSeed,
  loadKeyBundleFile,
} from '../src/index.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PASSPHRASE = 'phase21-step2-test-passphrase';
const TEST_KDF = { memory: 16, passes: 1, parallelism: 1, dkLen: 32 } as const;

describe('Phase 21 Mainnet bundle encrypt/decrypt policy', () => {
  it('Mainnet encrypt without flag is rejected', () => {
    const seed = generateHotWalletSeed();
    expect(() =>
      encryptKeyBundle({
        seed,
        passphrase: PASSPHRASE,
        networkGlobalId: -239,
        kdfParams: TEST_KDF,
      }),
    ).toThrow(/MAINNET/);
  });

  it('Mainnet encrypt with flag succeeds (disposable random seed)', () => {
    const seed = generateHotWalletSeed();
    const bundle = encryptKeyBundle({
      seed,
      passphrase: PASSPHRASE,
      networkGlobalId: -239,
      kdfParams: TEST_KDF,
      phase21MainnetEnabled: true,
    });
    expect(bundle.networkGlobalId).toBe(-239);
    expect(bundle.publicKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Mainnet decrypt without flag is rejected', () => {
    const seed = generateHotWalletSeed();
    const bundle = encryptKeyBundle({
      seed,
      passphrase: PASSPHRASE,
      networkGlobalId: -239,
      kdfParams: TEST_KDF,
      phase21MainnetEnabled: true,
    });
    expect(() => decryptKeyBundle(bundle, PASSPHRASE)).toThrow(/MAINNET/);
  });

  it('Mainnet decrypt with flag succeeds', () => {
    const seed = generateHotWalletSeed();
    const bundle = encryptKeyBundle({
      seed,
      passphrase: PASSPHRASE,
      networkGlobalId: -239,
      kdfParams: TEST_KDF,
      phase21MainnetEnabled: true,
    });
    const material = decryptKeyBundle(bundle, PASSPHRASE, { phase21MainnetEnabled: true });
    expect(material.networkGlobalId).toBe(-239);
    expect(material.publicKeyFingerprint).toBe(bundle.publicKeyFingerprint);
  });

  it('Testnet encrypt/decrypt unchanged without Mainnet flag', () => {
    const seed = generateHotWalletSeed();
    const bundle = encryptKeyBundle({
      seed,
      passphrase: PASSPHRASE,
      networkGlobalId: -3,
      kdfParams: TEST_KDF,
    });
    expect(bundle.networkGlobalId).toBe(-3);
    const material = decryptKeyBundle(bundle, PASSPHRASE);
    expect(material.networkGlobalId).toBe(-3);

    const dir = mkdtempSync(join(tmpdir(), 'p21-bundle-'));
    try {
      const path = join(dir, 'bundle.enc.json');
      writeFileSync(path, `${JSON.stringify(bundle)}\n`, { encoding: 'utf8', mode: 0o600 });
      const loaded = loadKeyBundleFile(path);
      expect(loaded.networkGlobalId).toBe(-3);
      expect(() => decryptKeyBundle(loaded, PASSPHRASE, { phase21MainnetEnabled: true })).toThrow(
        SignerError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
