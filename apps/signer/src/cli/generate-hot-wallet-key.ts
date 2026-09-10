#!/usr/bin/env node
/**
 * OFFLINE/OPERATOR Hot Wallet key generation for self-hosted encrypted custody.
 * Never prints private key/seed/mnemonic. Never uploads. Never commits the bundle.
 *
 * Usage:
 *   pnpm --filter @alex-rewards/signer exec tsx src/cli/generate-hot-wallet-key.ts --out ./hot-wallet.enc
 *   (or after build: node dist/cli/generate-hot-wallet-key.js --out ...)
 *
 * Passphrase via interactive TTY only (not argv, not env).
 */
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

import {
  encryptKeyBundle,
  generateHotWalletSeed,
  identityFromSeed,
  scrubBuffer,
  writeKeyBundleFile,
} from '@alex-rewards/signing';

function parseArgs(argv: string[]): { out: string; force: boolean } {
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' || a === '-o') {
      out = argv[++i];
    } else if (a === '--force') {
      force = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: generate-hot-wallet-key --out <path> [--force]
Generates TESTNET Wallet V5 R1 Hot Wallet identity and writes encrypted bundle.
Passphrase is read interactively from TTY. Private material is never printed.`);
      process.exit(0);
    }
  }
  if (!out) {
    console.error('Missing --out <path>');
    process.exit(1);
  }
  return { out: resolve(out), force };
}

async function readPassphrase(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error('Passphrase input requires an interactive TTY. Refusing non-TTY stdin.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
    // Hide echo by writing prompt then reading raw if possible
    process.stdout.write(prompt);
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r') {
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          rl.close();
          resolvePromise(buf);
          return;
        }
        if (ch === '\u0003') {
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += ch;
      }
    };
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
  process.stdin.setRawMode?.(false);
  return answer;
}

async function main(): Promise<void> {
  const { out, force } = parseArgs(process.argv.slice(2));
  if (existsSync(out) && !force) {
    console.error(`Refusing to overwrite existing file: ${out} (pass --force)`);
    process.exit(1);
  }

  const seed = generateHotWalletSeed();
  const identity = identityFromSeed(seed, { networkGlobalId: -3, workchain: 0 });

  console.log('ALEx Rewards — Hot Wallet key generation (TESTNET only)');
  console.log('Network: TON_TESTNET (global_id=-3) Wallet V5 R1');
  console.log(`Public key fingerprint: ${identity.publicKeyFingerprint}`);
  console.log(`Derived address (raw):  ${identity.addressRaw}`);
  console.log(`Derived address (friendly): ${identity.addressFriendly}`);
  console.log('');
  console.log('Enter a strong encryption passphrase (min 16 chars).');
  console.log(
    'This passphrase is NEVER stored. Loss of passphrase OR bundle = permanent Hot Wallet loss.',
  );

  const pass1 = await readPassphrase('Passphrase: ');
  const pass2 = await readPassphrase('Confirm passphrase: ');
  if (pass1 !== pass2) {
    scrubBuffer(seed);
    console.error('Passphrases do not match. Aborting.');
    process.exit(1);
  }
  if (pass1.length < 16) {
    scrubBuffer(seed);
    console.error('Passphrase too short (min 16). Aborting.');
    process.exit(1);
  }

  try {
    const bundle = encryptKeyBundle({
      seed,
      passphrase: pass1,
      networkGlobalId: -3,
      workchain: 0,
    });
    writeKeyBundleFile(out, bundle);
    console.log('');
    console.log(`Encrypted key bundle written: ${out}`);
    console.log('Permissions set to 0600 where supported.');
    console.log('Create TWO offline encrypted backups stored separately before production use.');
    console.log(
      'Do NOT commit this file. Do NOT place passphrase in .env / Docker / CI / Telegram / Admin.',
    );
  } finally {
    scrubBuffer(seed);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
