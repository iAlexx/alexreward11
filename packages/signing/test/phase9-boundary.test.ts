import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PHASE9_DEFERRED_TO_PHASE_10, SIGNER_BOUNDARY } from '../src/index.js';

const repoRoot = join(import.meta.dirname, '../../..');

function walkTsFiles(dir: string, acc: string[] = []): string[] {
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkTsFiles(p, acc);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('Phase 9 boundary invariants', () => {
  it('documents no broadcast / no DB write / attempt-id-only input', () => {
    expect(SIGNER_BOUNDARY.mayBroadcastTon).toBe(false);
    expect(SIGNER_BOUNDARY.mayCallTonRpc).toBe(false);
    expect(SIGNER_BOUNDARY.mayWriteFinancialDb).toBe(false);
    expect(SIGNER_BOUNDARY.acceptedCallerInput).toEqual(['withdrawalAttemptId']);
    expect(PHASE9_DEFERRED_TO_PHASE_10.length).toBeGreaterThan(0);
  });

  it('packages/signing source does not import AWS KMS client or TonClient broadcast', () => {
    const files = [
      'src/index.ts',
      'src/sign-attempt.ts',
      'src/canonical-message.ts',
      'src/local-ephemeral-kms.ts',
      'src/encrypted-local-signing-provider.ts',
      'src/encrypted-key-bundle.ts',
      'src/signing-key-provider.ts',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/@aws-sdk\/client-kms/);
      expect(source).not.toMatch(/TonClient/);
      expect(source).not.toMatch(/\.sendBoc\s*\(/);
    }
  });

  it('only apps/signer may wire EncryptedLocalSigningProvider for production custody', () => {
    const apps = ['api', 'bot', 'admin', 'worker'];
    for (const app of apps) {
      const files = walkTsFiles(join(repoRoot, 'apps', app, 'src'));
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        expect(source, relative(repoRoot, file)).not.toMatch(/EncryptedLocalSigningProvider/);
        expect(source, relative(repoRoot, file)).not.toMatch(/decryptKeyBundle/);
        expect(source, relative(repoRoot, file)).not.toMatch(/@aws-sdk\/client-kms/);
        expect(source, relative(repoRoot, file)).not.toMatch(/SIGNER_PRIVATE_KEY\s*=/);
      }
    }
  });

  it('apps/signer does not import AWS KMS SDK', () => {
    const files = walkTsFiles(join(repoRoot, 'apps', 'signer', 'src'));
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, relative(repoRoot, file)).not.toMatch(/@aws-sdk\/client-kms/);
    }
  });

  it('repository product surface has no real encrypted production bundle committed', () => {
    const forbidden = ['.enc', 'hot-wallet.enc', 'hot_wallet.enc'];
    const scanRoots = [
      join(repoRoot, 'apps'),
      join(repoRoot, 'packages'),
      join(repoRoot, 'docs'),
      join(repoRoot, 'infra'),
    ];
    for (const root of scanRoots) {
      const files = walkTsFiles(root);
      // also check for .enc files via directory walk of non-ts
      void files;
      void forbidden;
    }
    // Explicit: no committed .enc under repo (except none expected)
    const encHits: string[] = [];
    function walkAll(dir: string): void {
      if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return;
      for (const name of readdirSync(dir)) {
        if (
          name === 'node_modules' ||
          name === 'dist' ||
          name === '.git' ||
          name === 'phase-archives'
        )
          continue;
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walkAll(p);
        else if (name.endsWith('.enc')) encHits.push(relative(repoRoot, p));
      }
    }
    walkAll(repoRoot);
    expect(encHits).toEqual([]);
  });
});
