#!/usr/bin/env node
/**
 * OFFLINE Phase 21 Mainnet Hot Wallet key ceremony tooling (V5R1).
 *
 * Requires explicit --phase21-mainnet-ceremony flag.
 * Passphrase: interactive TTY twice (production path).
 * Test hook: ALEX_SIGNER_CEREMONY_TEST_HOOK=1 may inject passphrase via
 * PHASE21_CEREMONY_TEST_PASSPHRASE — NEVER for production path; never argv.
 * Seed is never printed. Bundle mode 0600 where supported.
 * Do NOT run a real production ceremony from Step 3 engineering.
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

function parseArgs(argv: string[]): {
  out: string;
  force: boolean;
  ceremony: boolean;
} {
  let out: string | undefined;
  let force = false;
  let ceremony = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out' || a === '-o') {
      out = argv[++i];
    } else if (a === '--force') {
      force = true;
    } else if (a === '--phase21-mainnet-ceremony') {
      ceremony = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: generate-hot-wallet-key-mainnet --phase21-mainnet-ceremony --out <path> [--force]\n' +
          'Generates disposable MAINNET Wallet V5 R1 Hot Wallet identity and writes encrypted bundle.\n' +
          'Passphrase is interactive (TTY). Private material is never printed.',
      );
      process.exit(0);
    }
  }
  if (!ceremony) {
    console.error('Refusing: missing required --phase21-mainnet-ceremony flag');
    process.exit(1);
  }
  if (!out) {
    console.error('Missing --out <path>');
    process.exit(1);
  }
  return { out: resolve(out), force, ceremony };
}

async function readPassphraseInteractive(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error('Passphrase input requires an interactive TTY. Refusing non-TTY stdin.');
    process.exit(1);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolvePromise) => {
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

/**
 * Secure test hook only. Production path never reads passphrase from env/argv.
 */
async function obtainPassphrasePair(): Promise<{ pass1: string; pass2: string }> {
  const testHook = process.env.ALEX_SIGNER_CEREMONY_TEST_HOOK === '1';
  const testPass = process.env.PHASE21_CEREMONY_TEST_PASSPHRASE;
  if (testHook && typeof testPass === 'string' && testPass.length >= 16) {
    return { pass1: testPass, pass2: testPass };
  }
  const pass1 = await readPassphraseInteractive('Passphrase: ');
  const pass2 = await readPassphraseInteractive('Confirm passphrase: ');
  return { pass1, pass2 };
}

async function main(): Promise<void> {
  const { out, force } = parseArgs(process.argv.slice(2));
  if (existsSync(out) && !force) {
    console.error(`Refusing to overwrite existing file: ${out} (pass --force)`);
    process.exit(1);
  }

  const seed = generateHotWalletSeed();
  const identity = identityFromSeed(seed, {
    networkGlobalId: -239,
    workchain: 0,
    phase21MainnetEnabled: true,
  });

  console.log('ALEx Rewards — Hot Wallet key generation (MAINNET ceremony tooling)');
  console.log('Network: TON_MAINNET (global_id=-239) Wallet V5 R1');
  console.log(`Public key fingerprint: ${identity.publicKeyFingerprint}`);
  console.log(`Derived address (raw):  ${identity.addressRaw}`);
  console.log(`Derived address (friendly): ${identity.addressFriendly}`);
  console.log('');
  console.log('Enter a strong encryption passphrase (min 16 chars).');
  console.log(
    'This passphrase is NEVER stored in env. Loss of passphrase OR bundle = permanent Hot Wallet loss.',
  );

  const { pass1, pass2 } = await obtainPassphrasePair();
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
      networkGlobalId: -239,
      workchain: 0,
      phase21MainnetEnabled: true,
    });
    writeKeyBundleFile(out, bundle);
    console.log('');
    console.log(`Encrypted Mainnet key bundle written: ${out}`);
    console.log('Permissions set to 0600 where supported.');
    console.log('Create TWO offline encrypted backups stored separately before production use.');
    console.log(
      'Do NOT commit this file. Do NOT place passphrase in .env / Docker / CI / Telegram / Admin.',
    );
    console.log('Step 3 engineering must NOT run a real production ceremony.');
  } finally {
    scrubBuffer(seed);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
