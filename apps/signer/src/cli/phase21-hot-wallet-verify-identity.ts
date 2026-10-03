#!/usr/bin/env node
/**
 * Offline Hot Wallet identity proof from an EXISTING encrypted Mainnet bundle.
 * Never generates keys. Never funds/registers. Passphrase: interactive TTY only.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

import { readSecretFromTty } from '@alex-rewards/auth';
import {
  decryptKeyBundle,
  deriveWalletV5R1,
  loadKeyBundleFile,
  publicKeyFingerprintHex,
  scrubBuffer,
} from '@alex-rewards/signing';

const SCHEMA = 'phase21-hot-wallet-identity-proof.v1' as const;

function envNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function sha256HexOfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toLowerCase();
}

async function main(): Promise<void> {
  const bundlePath = envNonEmpty('PHASE21_HOT_WALLET_BUNDLE_PATH');
  if (bundlePath === null) {
    printJson({
      ok: false,
      command: 'hot-wallet:verify-identity',
      refuseCode: 'BUNDLE_PATH_REQUIRED',
      message: 'PHASE21_HOT_WALLET_BUNDLE_PATH required (existing encrypted bundle; never generate)',
      readyForLivePayout: false,
    });
    process.exitCode = 1;
    return;
  }

  const outputPath = envNonEmpty('PHASE21_HOT_WALLET_IDENTITY_PROOF_OUT');
  let passphrase = '';
  let seed: Buffer | undefined;
  let secretKey: Buffer | undefined;
  let publicKey: Buffer | undefined;

  try {
    passphrase = await readSecretFromTty(
      'Hot Wallet encrypted bundle passphrase (TTY, not echoed): ',
    );

    const bundle = loadKeyBundleFile(bundlePath);
    if (bundle.networkGlobalId !== -239) {
      throw new Error('encrypted bundle networkGlobalId must be -239 (Mainnet)');
    }
    if (bundle.walletVersion !== 'v5R1') {
      throw new Error('encrypted bundle walletVersion must be v5R1');
    }
    if (bundle.workchain !== 0) {
      throw new Error('encrypted bundle workchain must be 0');
    }

    const material = decryptKeyBundle(bundle, passphrase, { phase21MainnetEnabled: true });
    seed = material.seed;
    secretKey = material.secretKey;
    publicKey = material.publicKey;

    const derived = deriveWalletV5R1({
      publicKey: material.publicKey,
      networkGlobalId: -239,
      workchain: 0,
      phase21MainnetEnabled: true,
    });
    const fingerprint = publicKeyFingerprintHex(material.publicKey);
    if (fingerprint !== material.publicKeyFingerprint) {
      throw new Error('recomputed fingerprint mismatch');
    }
    if (derived.addressRaw !== material.addressRaw) {
      throw new Error('recomputed address mismatch');
    }

    const proof = {
      schemaVersion: SCHEMA,
      networkCode: 'TON_MAINNET' as const,
      networkGlobalId: -239 as const,
      walletVersion: 'v5R1' as const,
      workchain: 0 as const,
      addressRaw: derived.addressRaw,
      addressFriendly: derived.addressFriendly,
      publicKeyFingerprintSha256: fingerprint,
      encryptedBundleSha256: sha256HexOfFile(bundlePath),
      verifiedAt: new Date().toISOString(),
      sanitized: true as const,
      readyForLivePayout: false as const,
    };

    for (const forbidden of ['seed', 'secretKey', 'privateKey', 'passphrase', 'mnemonic']) {
      if (forbidden in proof) {
        throw new Error(`proof must not contain ${forbidden}`);
      }
    }

    if (outputPath !== null) {
      writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    printJson({
      ok: true,
      command: 'hot-wallet:verify-identity',
      proof,
      outputPath,
      readyForLivePayout: false,
      notes: [
        'EXISTING bundle only — no key generation',
        'Sanitized proof only; seed/passphrase never written',
        'Registration still requires Owner-authenticated Phase21 APPLY later',
      ],
    });
  } catch (error: unknown) {
    printJson({
      ok: false,
      command: 'hot-wallet:verify-identity',
      message: error instanceof Error ? error.message : String(error),
      readyForLivePayout: false,
    });
    process.exitCode = 1;
  } finally {
    passphrase = '';
    scrubBuffer(seed);
    scrubBuffer(secretKey);
    scrubBuffer(publicKey);
  }
}

await main();
