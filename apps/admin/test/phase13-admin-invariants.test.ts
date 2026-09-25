/**
 * Phase 13 Admin Control Plane invariant scans.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ADMIN_NAV, REQUIRED_NAV_LABELS } from '../src/lib/nav';
import { strings } from '../src/lib/strings';

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

describe('Phase 13 admin — no balance editor', () => {
  it('never ships Set Balance / Edit Balance UI', async () => {
    const offenders = (await readSources()).filter(({ path, source }) => {
      // Prohibition copy in strings is asserted separately.
      if (path === 'lib/strings.ts') return false;
      return /set\s*balance|edit\s*balance|SetBalance|EditBalance|balance\s*=\s*x/i.test(
        source,
      );
    });
    expect(offenders.map((item) => item.path)).toEqual([]);
  });

  it('documents ledger-derived balances and refuses direct editors in copy', () => {
    expect(strings.noBalanceEditor).toMatch(/ledger/i);
    expect(strings.noBalanceEditor).toMatch(/not provided|refused|ledger-derived/i);
  });
});

describe('Phase 13 admin — nav completeness', () => {
  it('includes every required Owner Control Plane area', () => {
    const labels = ADMIN_NAV.map((item) => item.label);
    for (const required of REQUIRED_NAV_LABELS) {
      expect(labels).toContain(required);
    }
    expect(ADMIN_NAV).toHaveLength(REQUIRED_NAV_LABELS.length);
  });

  it('has unique hrefs for every nav item', () => {
    const hrefs = ADMIN_NAV.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('Phase 13 admin — auth page smoke', () => {
  it('login form wires WebAuthn primary, password+TOTP fallback, and recovery', async () => {
    const login = (await readSources()).find(({ path }) => path.includes('LoginForm'));
    expect(login).toBeDefined();
    expect(login!.source).toMatch(/startAuthentication/);
    expect(login!.source).toMatch(/webauthnLoginOptions/);
    expect(login!.source).toMatch(/loginPasswordTotp/);
    expect(login!.source).toMatch(/recoveryConsume/);
    expect(login!.source).toMatch(/Passkey/);
    expect(login!.source).toMatch(/Password \+ TOTP/);
    expect(login!.source).toMatch(/Recovery/);
  });

  it('session guard and reauth provider exist', async () => {
    const sources = await readSources();
    const guard = sources.find(({ path }) => path.includes('AdminSessionGuard'));
    const reauth = sources.find(({ path }) => path.includes('ReauthProvider'));
    expect(guard).toBeDefined();
    expect(reauth).toBeDefined();
    expect(guard!.source).toMatch(/\/login/);
    expect(reauth!.source).toMatch(/reauthWebAuthn|reauthPasswordTotp/);
  });
});

describe('Phase 13 admin — AdsGram blocked display', () => {
  it('always displays BLOCKED status and disables APPROVED control', async () => {
    const ads = (await readSources()).find(({ path }) => path.includes('pages/AdsPage'));
    expect(ads).toBeDefined();
    expect(ads!.source).toMatch(/adsgram-blocked/);
    expect(ads!.source).toMatch(/BLOCKED/);
    expect(ads!.source).toMatch(/adsgramApproveDisabled/);
    expect(ads!.source).toMatch(/disabled/);
    expect(ads!.source).toMatch(/Set APPROVED/);
    expect(ads!.source).not.toMatch(/productionMonetaryStatus:\s*['"]APPROVED['"]/);
  });
});

describe('Phase 13 admin — policy no-code-field scan', () => {
  it('Policy Center has no free-form code/script/SQL/eval editor', async () => {
    const policy = (await readSources()).find(({ path }) =>
      path.includes('pages/PolicyCenterPage'),
    );
    expect(policy).toBeDefined();
    expect(policy!.source).not.toMatch(/<textarea[^>]*(code|script|sql|eval)/i);
    expect(policy!.source).not.toMatch(/name=["'](code|script|sql|eval)["']/i);
    expect(policy!.source).not.toMatch(/Function\(|eval\(|new Function/);
    expect(policy!.source).toMatch(/No scripting engine|no free-form code/i);
  });
});
