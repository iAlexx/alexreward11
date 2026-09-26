/**
 * Phase 12 authority invariants for the Mini App.
 *
 * Frontend has zero financial authority. These tests scan the source tree so a
 * regression cannot silently invent balances, trust Telegram's unsafe user object,
 * or turn the claim-code path into a logging/storage surface.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(child)));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files.sort();
}

async function readSources(): Promise<ReadonlyArray<{ path: string; source: string }>> {
  const files = await listSourceFiles(srcRoot);
  return Promise.all(
    files.map(async (absolute) => ({
      path: absolute.slice(srcRoot.length).replaceAll('\\', '/'),
      source: await readFile(absolute, 'utf8'),
    })),
  );
}

describe('Phase 12 miniapp authority', () => {
  it('never trusts initDataUnsafe for authentication', async () => {
    const offenders = (await readSources()).filter(({ source }) =>
      /initDataUnsafe/.test(source),
    );
    // Type declaration may mention the field; using it as auth input is forbidden.
    expect(offenders.map((item) => item.path)).toEqual(['types/telegram-webapp.d.ts']);
    for (const offender of offenders) {
      expect(offender.source).not.toMatch(/authTelegram|Authorization/);
      expect(offender.source).not.toMatch(/initDataUnsafe\s*[.=(]/);
    }
  });

  it('never logs Founder claim codes', async () => {
    const claimSources = (await readSources()).filter(
      ({ path, source }) =>
        /claimCode|FounderClaim|founder\/claim/.test(source) || path.includes('Founder'),
    );
    for (const file of claimSources) {
      expect(file.source).not.toMatch(/console\.(log|info|debug|warn|error)\([^)]*claim/i);
      expect(file.source).not.toMatch(/localStorage\.[gs]etItem\([^)]*claim/i);
    }
  });

  it('clears claim codes after terminal outcomes and never persists them', async () => {
    const form = (await readSources()).find(({ path }) => path.includes('FounderClaimForm'));
    expect(form).toBeDefined();
    expect(form!.source).toMatch(/clearCode/);
    expect(form!.source).toMatch(/onSuccess/);
    expect(form!.source).toMatch(/onError/);
    expect(form!.source).not.toMatch(/localStorage\./);
    expect(form!.source).not.toMatch(/sessionStorage\./);
  });

  it('keeps @adsgram/react behind the sole bridge import', async () => {
    const offenders = (await readSources()).filter(
      ({ path, source }) =>
        /@adsgram\/(react|common)/.test(source) && path !== 'ads/AdsGramRewardedBridge.tsx',
    );
    expect(offenders.map((item) => item.path)).toEqual([]);
  });

  it('never invents optimistic balance, Founder, reward, or withdrawal state', async () => {
    const sources = await readSources();
    for (const file of sources) {
      expect(file.source).not.toMatch(/optimistic(?:ally)?\s+(?:credit|balance|reward|founder)/i);
      expect(file.source).not.toMatch(/setBalance\s*\(/);
      expect(file.source).not.toMatch(/localBalance|fakeBalance|mockBalance/);
    }

    const watch = sources.find(({ path }) => path.includes('WatchEarnCard'));
    expect(watch).toBeDefined();
    expect(watch!.source).toMatch(/result\.issued/);
    expect(watch!.source).toMatch(/Never optimistic/i);
  });

  it('formats money via BigInt atomic strings without inventing subunit conversion', async () => {
    const money = await readFile(join(srcRoot, 'lib/money/format.ts'), 'utf8');
    expect(money).toMatch(/BigInt/);
    expect(money).not.toMatch(/\btoFixed\b/);
    expect(money).not.toMatch(/\bdecimals\s*[:=]/);
  });

  it('blocks production use of the gated dev initData path', async () => {
    const telegram = await readFile(join(srcRoot, 'lib/auth/telegram.ts'), 'utf8');
    expect(telegram).toMatch(/NODE_ENV === 'production'/);
    expect(telegram).toMatch(/NEXT_PUBLIC_ALLOW_DEV_INIT_DATA/);
    expect(telegram).toMatch(/readTelegramInitData\(\) \?\? readDevInitData\(\)/);
  });
});
