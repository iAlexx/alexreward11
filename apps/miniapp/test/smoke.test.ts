import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  formatAtomicAmount,
  InvalidAtomicAmountError,
  parseAtomicAmount,
} from '../src/lib/money/format';
import { GET as live } from '../src/app/api/health/live/route';

const appRoot = fileURLToPath(new URL('../src/app/', import.meta.url));

describe('Phase 12 miniapp smoke', () => {
  it('exposes the required App Router screens', async () => {
    const appGroup = join(appRoot, '(app)');
    const entries = await readdir(appGroup, { withFileTypes: true });
    const names = new Set(entries.map((entry) => entry.name));
    expect(names.has('page.tsx')).toBe(true);
    expect(names.has('layout.tsx')).toBe(true);
    for (const route of ['earn', 'tasks', 'friends', 'wallet', 'profile', 'activity', 'notifications']) {
      expect(names.has(route)).toBe(true);
    }
    const profile = await readdir(join(appGroup, 'profile'), { withFileTypes: true });
    expect(profile.some((entry) => entry.name === 'founder')).toBe(true);
  });

  it('formats atomic amounts with BigInt and rejects non-integers', () => {
    expect(parseAtomicAmount('1500')).toBe(1500n);
    expect(formatAtomicAmount('1500')).toBe('1500');
    expect(formatAtomicAmount('0')).toBe('0');
    expect(() => parseAtomicAmount('1.5')).toThrow(InvalidAtomicAmountError);
    expect(() => parseAtomicAmount('abc')).toThrow(InvalidAtomicAmountError);
  });

  it('keeps the health contract online', async () => {
    const response = live();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ service: 'miniapp', status: 'ok' });
  });
});
