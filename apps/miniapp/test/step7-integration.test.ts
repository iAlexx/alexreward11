/**
 * LOOTRA Step 7 — full Mini App integration / UX QA invariants.
 * Authority boundaries from Steps 1–6 must remain intact.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { messagesByLocale } from '../src/i18n/messages';
import {
  formatAtomicAmount,
  formatAtomicAmountGrouped,
} from '../src/lib/money/format';
import { BOTTOM_NAV_ROUTES, resolvePrimaryNavActiveIndex } from '../src/lib/bottom-nav-routes';
import { deriveHomeSurfaceState } from '../src/lib/home/home-surface';
import type { HomeSummaryResponse } from '@alex-rewards/contracts';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const appRoot = fileURLToPath(new URL('../src/app/', import.meta.url));

async function listSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      files.push(...(await listSources(child)));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

async function readSrc(relative: string): Promise<string> {
  return readFile(join(srcRoot, relative), 'utf8');
}

describe('LOOTRA Step 7 integration QA', () => {
  it('primary routes and secondary nav semantics remain intact', () => {
    expect(BOTTOM_NAV_ROUTES).toEqual(['/', '/earn', '/tasks', '/friends', '/wallet']);
    expect(resolvePrimaryNavActiveIndex('/wallet/withdrawals/x')).toBe(4);
    expect(resolvePrimaryNavActiveIndex('/profile/support/x')).toBeNull();
    expect(resolvePrimaryNavActiveIndex('/notifications')).toBeNull();
    expect(resolvePrimaryNavActiveIndex('/activity')).toBeNull();
  });

  it('atomic money display never invents decimal USDT conversion', () => {
    expect(formatAtomicAmount('9400000')).toBe('9400000');
    expect(formatAtomicAmountGrouped('9400000')).toBe('9,400,000');
    expect(formatAtomicAmountGrouped('9400000')).not.toMatch(/9\.4/);
  });

  it('Home ENGINE_NOT_ENABLED missions/referrals do not degrade whole Home', () => {
    const home = {
      asOf: '2026-09-28T00:00:00.000Z',
      balances: {
        status: 'READY',
        data: {
          asOf: '2026-09-28T00:00:00.000Z',
          available: { state: 'READY', amountAtomic: '1', assetSymbol: 'USDT', assetId: 'a' },
          pending: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
          reserved: { state: 'READY', amountAtomic: '0', assetSymbol: 'USDT', assetId: 'a' },
          lifetimeEarned: { state: 'READY', amountAtomic: '1', assetSymbol: 'USDT', assetId: 'a' },
        },
      },
      todayAds: { status: 'READY', data: null },
      missions: { status: 'UNAVAILABLE', data: null, errorCode: 'ENGINE_NOT_ENABLED' },
      referrals: { status: 'UNAVAILABLE', data: null, errorCode: 'ENGINE_NOT_ENABLED' },
      latestWithdrawal: { status: 'EMPTY', data: null },
      announcement: { status: 'EMPTY', data: null },
      membershipBrief: {
        status: 'READY',
        data: { active: false, planCode: null, isFounder: false, founderNumber: null },
      },
    } satisfies HomeSummaryResponse;
    expect(deriveHomeSurfaceState(home)).toBe('READY');
  });

  it('public brand remains LOOTRA; no ALEx Rewards user-facing product name', async () => {
    const layout = await readFile(join(appRoot, 'layout.tsx'), 'utf8');
    expect(layout).toMatch(/title:\s*'LOOTRA'/);
    expect(messagesByLocale.en.app.brand).toBe('LOOTRA');
    expect(messagesByLocale.ar.app.brand).toBe('LOOTRA');
    expect(messagesByLocale.ru.app.brand).toBe('LOOTRA');

    const files = await listSources(srcRoot);
    for (const absolute of files) {
      const source = await readFile(absolute, 'utf8');
      expect(source).not.toMatch(/ALEx Rewards|Alex Rewards|ALEX Rewards/);
    }
  });

  it('rejects prototype / fake financial UI literals in runtime source', async () => {
    const files = await listSources(srcRoot);
    const blob = (await Promise.all(files.map((f) => readFile(f, 'utf8')))).join('\n');
    expect(blob).not.toMatch(/\bMikhail\b|\bSofia\b|\bNour\b/);
    expect(blob).not.toMatch(/\b3\.81\b|\b10%|\b12 active\b|\b4 pending\b/i);
    expect(blob).not.toMatch(/Claim Reward/i);
    expect(blob).not.toMatch(/mockReferral|fakeTask|fakeBalance|mockBalance/i);
    expect(blob).not.toMatch(/txHash|tonviewer|tonscan/i);
    expect(blob).not.toMatch(/Cancel withdrawal/i);
    expect(blob).not.toMatch(/Set as primary|Delete wallet|Remove payout wallet/i);
  });

  it('Telegram nav remains transform-safe and touch-safe', async () => {
    const css = await readFile(join(appRoot, 'globals.css'), 'utf8');
    const nav = await readSrc('components/BottomNav.tsx');
    expect(css).not.toMatch(/transform:\s*translateX\(-50%\)/);
    expect(css).toMatch(/overflow-x:\s*clip/);
    expect(css).toMatch(/safe-area-inset-top/);
    expect(css).toMatch(/safe-area-inset-bottom/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(/@media \(max-width:\s*320px\)/);
    expect(nav).toMatch(/AppLink/);
    expect(nav).not.toMatch(/next\/link/);
  });

  it('Activity and Notifications remain honest unavailable shells', async () => {
    const activity = await readFile(join(appRoot, '(app)/activity/page.tsx'), 'utf8');
    const notifications = await readFile(join(appRoot, '(app)/notifications/page.tsx'), 'utf8');
    const shell = await readSrc('components/UnavailableShell.tsx');
    expect(activity).toMatch(/UnavailableShell/);
    expect(notifications).toMatch(/UnavailableShell/);
    expect(shell).toMatch(/no mocked rows/i);
    expect(shell).not.toMatch(/unreadCount|fakeInbox|mockNotification/i);
  });

  it('EN/AR/RU catalogs stay present for shell namespaces', () => {
    for (const locale of ['en', 'ar', 'ru'] as const) {
      const m = messagesByLocale[locale];
      expect(m.app.brand).toBe('LOOTRA');
      expect(m.nav.home.length).toBeGreaterThan(0);
      expect(m.wallet.title.length).toBeGreaterThan(0);
      expect(m.profile.support.length).toBeGreaterThan(0);
      expect(m.founder.title.length).toBeGreaterThan(0);
      expect(m.activity.title.length).toBeGreaterThan(0);
      expect(m.notifications.title.length).toBeGreaterThan(0);
    }
  });

  it('money surfaces use grouped atomic helpers without subunit conversion', async () => {
    const money = await readSrc('lib/money/format.ts');
    const amountUi = await readSrc('components/MoneyAmount.tsx');
    expect(money).toMatch(/BigInt/);
    expect(money).not.toMatch(/\btoFixed\b/);
    expect(money).not.toMatch(/\bdecimals\s*[:=]/);
    expect(amountUi).toMatch(/formatAtomicAmountGrouped/);
    expect(amountUi).toMatch(/baseUnits/);
    expect(amountUi).not.toMatch(/toFixed|\/\s*1e6|\/\s*1000000/);
  });
});
