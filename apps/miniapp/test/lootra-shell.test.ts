import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { BOTTOM_NAV_ROUTES } from '../src/lib/bottom-nav-routes';
import {
  hasCompletedOnboarding,
  markOnboardingComplete,
  ONBOARDING_STORAGE_KEY,
} from '../src/lib/onboarding-preference';
import { messagesByLocale } from '../src/i18n/messages';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const appRoot = fileURLToPath(new URL('../src/app/', import.meta.url));
const publicBrand = fileURLToPath(new URL('../public/brand/lootra/', import.meta.url));

describe('LOOTRA Step 1 shell foundation', () => {
  it('bottom nav keeps five real routes with active semantics', () => {
    expect(BOTTOM_NAV_ROUTES).toEqual(['/', '/earn', '/tasks', '/friends', '/wallet']);
  });

  it('bottom nav still uses AppLink document navigation (Telegram touch-safe)', async () => {
    const nav = await readFile(join(srcRoot, 'components/BottomNav.tsx'), 'utf8');
    expect(nav).toMatch(/AppLink/);
    expect(nav).toMatch(/aria-current/);
    expect(nav).not.toMatch(/next\/link/);
    expect(nav).not.toMatch(/translateX\(-50%\)/);
  });

  it('public brand metadata and i18n brand are LOOTRA', async () => {
    const layout = await readFile(join(appRoot, 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/title:\s*'LOOTRA'/);
    expect(layout).toMatch(/LOOTRA Rewards Mini App/);
    expect(messagesByLocale.en.app.brand).toBe('LOOTRA');
    expect(messagesByLocale.ar.app.brand).toBe('LOOTRA');
    expect(messagesByLocale.ru.app.brand).toBe('LOOTRA');
  });

  it('ships approved brand assets under public/brand/lootra', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(publicBrand);
    for (const name of [
      'l-accent.png',
      'rewards-hero.png',
      'tasks-hero.png',
      'wallet-hero.png',
      'bot-hero.png',
    ]) {
      expect(files).toContain(name);
    }
  });

  it('onboarding preference stores only a non-sensitive completion flag', () => {
    expect(ONBOARDING_STORAGE_KEY).toBe('lootra:onboarding:v1');
    const store = new Map<string, string>();
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });
    try {
      expect(hasCompletedOnboarding()).toBe(false);
      markOnboardingComplete();
      expect(hasCompletedOnboarding()).toBe(true);
      const raw = store.get(ONBOARDING_STORAGE_KEY);
      expect(raw).toBe('completed');
      expect(raw).not.toMatch(/token|initData|wallet|balance|claim|refresh|session/i);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: original,
      });
    }
  });

  it('notifications shell has no mocked notification rows', async () => {
    const page = await readFile(join(appRoot, '(app)/notifications/page.tsx'), 'utf8');
    const shell = await readFile(join(srcRoot, 'components/UnavailableShell.tsx'), 'utf8');
    expect(page).toMatch(/UnavailableShell/);
    expect(shell).toMatch(/UnavailableShell/);
    expect(shell).toMatch(/kind/);
    expect(page + shell).not.toMatch(/Mikhail|Sofia|Nour|0\.024|unreadCount/);
    expect(page + shell).not.toMatch(/\bfake\b/i);
    expect(messagesByLocale.en.notifications.body).toMatch(/not available/i);
  });

  it('activity shell has no mocked history rows', async () => {
    const page = await readFile(join(appRoot, '(app)/activity/page.tsx'), 'utf8');
    expect(page).toMatch(/UnavailableShell/);
    expect(page).not.toMatch(/12\.840|reward activity|mock/i);
    expect(messagesByLocale.en.activity.state).toMatch(/Unavailable/i);
  });

  it('auth status enum and READY gate remain unchanged', async () => {
    const auth = await readFile(join(srcRoot, 'providers/AuthProvider.tsx'), 'utf8');
    expect(auth).toMatch(/'LOADING'/);
    expect(auth).toMatch(/'READY'/);
    expect(auth).toMatch(/'UNAUTHORIZED'/);
    expect(auth).toMatch(/'EXPIRED'/);
    expect(auth).toMatch(/'UNAVAILABLE'/);
    expect(auth).toMatch(/AuthSplash/);
    expect(auth).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*setStatus/);
  });

  it('RTL shell direction helpers remain compatible', async () => {
    const css = await readFile(join(appRoot, 'globals.css'), 'utf8');
    expect(css).toMatch(/\[dir='rtl'\]/);
    expect(css).toMatch(/overflow-x:\s*clip/);
    expect(css).toMatch(/safe-area-inset-top/);
    expect(css).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    // Navigation dock must not use the prior Telegram WebView-breaking centering transform.
    expect(css).not.toMatch(/transform:\s*translateX\(-50%\)/);
    expect(css).toMatch(/\.lootra-bottom-nav[\s\S]*left:\s*0/);
    expect(css).toMatch(/\.lootra-bottom-nav[\s\S]*margin-inline:\s*auto/);
  });

  it('shell i18n namespaces exist in EN / AR / RU', () => {
    for (const locale of ['en', 'ar', 'ru'] as const) {
      const messages = messagesByLocale[locale];
      expect(messages.onboarding.skip.length).toBeGreaterThan(0);
      expect(messages.onboarding.next.length).toBeGreaterThan(0);
      expect(messages.onboarding.getStarted.length).toBeGreaterThan(0);
      expect(messages.activity.title.length).toBeGreaterThan(0);
      expect(messages.notifications.title.length).toBeGreaterThan(0);
    }
  });
});
