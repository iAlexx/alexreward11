/**
 * Phase 11 — module boundary proof.
 *
 * `packages/ads` normalizes ad evidence and gates monetary eligibility. It composes
 * transactions through the Reward Engine and must never reach the ledger itself. This is
 * asserted against the source on disk rather than against a mocked module graph, so the
 * guarantee survives refactors, re-exports and indirect imports.
 *
 * Needs no database.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

async function listSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSourceFiles(child)));
    } else if (/\.tsx?$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files.sort();
}

async function readSources(): Promise<ReadonlyArray<{ path: string; source: string }>> {
  const files = await listSourceFiles(srcRoot);
  return Promise.all(
    files.map(async (path) => ({
      path: path.slice(packageRoot.length).replaceAll('\\', '/'),
      source: await readFile(path, 'utf8'),
    })),
  );
}

describe('Phase 11 packages/ads boundaries', () => {
  it('contains source files to inspect', async () => {
    const sources = await readSources();
    expect(sources.length).toBeGreaterThan(10);
  });

  it('never imports the ledger package', async () => {
    const offenders = (await readSources())
      .filter(({ source }) => /from\s+['"]@alex-rewards\/ledger['"]/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('never references a ledger posting API', async () => {
    const offenders = (await readSources())
      .filter(({ source }) =>
        /postLedgerTransaction|getOrCreateLedgerAccount|reverseLedgerTransaction/.test(source),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('never writes to a ledger or balance table', async () => {
    const offenders = (await readSources())
      .filter(({ source }) =>
        /(?:INSERT\s+INTO|UPDATE)\s+(?:ledger_entries|ledger_transactions|ledger_accounts|ledger_account_balances)/i.test(
          source,
        ),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('declares no mutable authoritative balance shortcut', async () => {
    const offenders = (await readSources())
      .filter(({ source }) =>
        /users\s*\.\s*balance|\bbalance\s+(?:bigint|numeric|integer)/i.test(source),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('declares no dependency on the ledger or on a client SDK', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    expect(declared).not.toContain('@alex-rewards/ledger');
    expect(declared).not.toContain('@adsgram/react');
    expect(declared).not.toContain('react');
    expect(declared).toContain('@alex-rewards/rewards');
  });

  it('routes issuance exclusively through the Reward Engine command', async () => {
    const sources = await readSources();
    const issuers = sources.filter(({ source }) => /\bissueAdReward\b/.test(source));
    expect(issuers.map(({ path }) => path)).toEqual(['src/sessions/lifecycle.ts']);
    expect(issuers[0]?.source).toMatch(/from\s+'@alex-rewards\/rewards'/);
  });
});
