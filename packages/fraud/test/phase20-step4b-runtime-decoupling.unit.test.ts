/**
 * Phase 20 Step 4B.1 — prove fraud runtime export graph does not load the approved policy artifact.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const fraudRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = join(fraudRoot, 'src');

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('Phase 20 Step 4B.1 runtime decoupling', () => {
  it('src runtime tree has no Phase20 approved-policy references', () => {
    const files = listTsFiles(srcRoot);
    expect(files.some((f) => f.endsWith('phase20-closed-beta-approved-policy.ts'))).toBe(false);

    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('phase20-closed-beta-owner-approved.json');
      expect(text).not.toContain('PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY');
      expect(text).not.toContain('phase20-closed-beta-approved-policy');
    }

    const index = readFileSync(join(srcRoot, 'index.ts'), 'utf8');
    expect(index).not.toMatch(/readFileSync/);
  });

  it('built package root import does not require Phase20 policy JSON', async () => {
    const distIndex = join(fraudRoot, 'dist', 'index.js');
    const distText = readFileSync(distIndex, 'utf8');
    expect(distText).not.toContain('phase20-closed-beta-owner-approved.json');
    expect(distText).not.toContain('PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY');
    expect(distText).not.toContain('phase20-closed-beta-approved-policy');

    const mod = await import('@alex-rewards/fraud');
    expect(mod).toBeTypeOf('object');
    expect(mod).not.toHaveProperty('PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY');
    expect(typeof mod.validateRiskRuleConfig).toBe('function');
  });
});