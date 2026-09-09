import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const srcRoot = join(packageRoot, 'src');
const botRoot = join(packageRoot, '..', '..', 'apps', 'bot', 'src');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('Phase 8 boundary import bans', () => {
  it('control-center does not import ledger / kms / ton sign', () => {
    const files = walkTs(srcRoot);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/@alex-rewards\/ledger/);
      expect(source).not.toMatch(/@aws-sdk\/client-kms/);
      expect(source).not.toMatch(/from\s+['"]@alex-rewards\/ton['"]/);
    }
  });

  it('apps/bot does not import kms or ton sign paths', () => {
    const files = walkTs(botRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/@aws-sdk\/client-kms/);
      expect(source).not.toMatch(/from\s+['"]@alex-rewards\/ton['"]/);
      expect(source).not.toMatch(/@alex-rewards\/ledger/);
    }
  });

  it('boundary module documents fail-closed rules', () => {
    const source = readFileSync(join(srcRoot, 'boundary.ts'), 'utf8');
    expect(source).toMatch(/forbidsLedger/);
    expect(source).toMatch(/forbidsTonSign/);
    expect(source).toMatch(/forbidsKms/);
  });
});
