import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LOCALES, defaultLocale, isLocale, isRtlLocale } from '../src/index.js';

async function loadKeys(locale: string): Promise<string[]> {
  const path = fileURLToPath(new URL(`../messages/${locale}.json`, import.meta.url));
  const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const keys: string[] = [];
  const walk = (node: unknown, prefix: string): void => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      keys.push(prefix);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, prefix === '' ? key : `${prefix}.${key}`);
    }
  };
  walk(raw, '');
  return keys.sort();
}

describe('i18n catalogs', () => {
  it('exposes ar/en/ru with Arabic RTL', () => {
    expect(LOCALES).toEqual(['ar', 'en', 'ru']);
    expect(defaultLocale).toBe('en');
    expect(isLocale('ar')).toBe(true);
    expect(isRtlLocale('ar')).toBe(true);
    expect(isRtlLocale('en')).toBe(false);
    expect(isRtlLocale('ru')).toBe(false);
  });

  it('keeps message key sets identical across locales', async () => {
    const [en, ar, ru] = await Promise.all([loadKeys('en'), loadKeys('ar'), loadKeys('ru')]);
    expect(ar).toEqual(en);
    expect(ru).toEqual(en);
    expect(en.length).toBeGreaterThan(50);
  });
});
