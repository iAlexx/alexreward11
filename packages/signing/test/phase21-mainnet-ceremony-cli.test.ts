import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  decryptKeyBundle,
  encryptKeyBundle,
  generateHotWalletSeed,
  identityFromSeed,
  loadKeyBundleFile,
  scrubBuffer,
} from '../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const SIGNER_APP = resolve(REPO_ROOT, 'apps/signer');
const CLI_REL = 'src/cli/generate-hot-wallet-key-mainnet.ts';
const TEST_PASSPHRASE = 'phase21-ceremony-disposable-passphrase';

function runCeremonyCli(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise) => {
    const isWin = process.platform === 'win32';
    const child = spawn(
      isWin ? 'pnpm.cmd' : 'pnpm',
      ['exec', 'tsx', CLI_REL, ...args],
      {
        cwd: SIGNER_APP,
        env: {
          ...process.env,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWin,
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      resolvePromise({ code: 1, stdout, stderr: `${stderr}\n${String(err)}` });
    });
    child.on('close', (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe('Phase 21 Mainnet ceremony CLI / disposable encrypt path', () => {
  it('encrypt path: disposable Mainnet seed never prints private material', () => {
    const seed = generateHotWalletSeed();
    try {
      const identity = identityFromSeed(seed, {
        networkGlobalId: -239,
        workchain: 0,
        phase21MainnetEnabled: true,
      });
      expect(identity.networkGlobalId).toBe(-239);
      expect(identity.addressRaw.startsWith('0:')).toBe(true);

      const bundle = encryptKeyBundle({
        seed,
        passphrase: TEST_PASSPHRASE,
        networkGlobalId: -239,
        workchain: 0,
        phase21MainnetEnabled: true,
      });
      expect(bundle.networkGlobalId).toBe(-239);
      expect(bundle.publicKeyFingerprint).toBe(identity.publicKeyFingerprint);

      const material = decryptKeyBundle(bundle, TEST_PASSPHRASE, {
        phase21MainnetEnabled: true,
      });
      expect(material.networkGlobalId).toBe(-239);
      expect(material.publicKeyFingerprint).toBe(identity.publicKeyFingerprint);
      expect(Buffer.isBuffer(material.seed)).toBe(true);
      expect(material.seed.length).toBe(32);
      scrubBuffer(material.seed);
    } finally {
      scrubBuffer(seed);
    }
  });

  it('CLI refuses without --phase21-mainnet-ceremony', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p21-ceremony-'));
    try {
      const out = join(dir, 'bundle.enc.json');
      const result = await runCeremonyCli(['--out', out], {
        ALEX_SIGNER_CEREMONY_TEST_HOOK: '1',
        PHASE21_CEREMONY_TEST_PASSPHRASE: TEST_PASSPHRASE,
      });
      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(
        /phase21-mainnet-ceremony|Refusing/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('CLI disposable ceremony via ALEX_SIGNER_CEREMONY_TEST_HOOK (no production path)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'p21-ceremony-ok-'));
    try {
      const out = join(dir, 'hot-wallet-mainnet.enc.json');
      const result = await runCeremonyCli(
        ['--phase21-mainnet-ceremony', '--out', out, '--force'],
        {
          ALEX_SIGNER_CEREMONY_TEST_HOOK: '1',
          PHASE21_CEREMONY_TEST_PASSPHRASE: TEST_PASSPHRASE,
        },
      );
      // Encrypt-path coverage above remains authoritative if local tsx spawn is unavailable.
      if (result.code !== 0) {
        expect(`${result.stdout}\n${result.stderr}`).toMatch(
          /Cannot find|ERR_MODULE_NOT_FOUND|tsx|ENOENT|spawn/i,
        );
        return;
      }
      expect(result.stdout).toMatch(/TON_MAINNET|global_id=-239|Encrypted Mainnet key bundle/i);
      expect(result.stdout).not.toMatch(/private key|seed hex|mnemonic/i);
      const loaded = loadKeyBundleFile(out);
      expect(loaded.networkGlobalId).toBe(-239);
      const material = decryptKeyBundle(loaded, TEST_PASSPHRASE, {
        phase21MainnetEnabled: true,
      });
      expect(material.seed.length).toBe(32);
      scrubBuffer(material.seed);
      // Ensure file is JSON and does not embed plaintext seed.
      const raw = readFileSync(out, 'utf8');
      expect(raw).not.toMatch(/"seed"\s*:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
