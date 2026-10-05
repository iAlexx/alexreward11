import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import { E2E_MINIAPP_BASE_URL } from '../env.js';
import { formatAtomicForUi } from './money.js';

/** Assert Home (or Wallet) balance labels show the seeded atomic amounts. */
export async function expectSeededBalancesVisible(
  page: Page,
  balances: { available: string; pending: string; reserved: string },
): Promise<void> {
  await expectBalanceRow(page, 'Available', balances.available);
  await expectBalanceRow(page, 'Pending', balances.pending);
  await expectBalanceRow(page, 'Reserved', balances.reserved);
}

async function expectBalanceRow(page: Page, label: string, amountAtomic: string): Promise<void> {
  const row = page.locator('.alex-money').filter({ hasText: label });
  await expect(row).toBeVisible();
  await expect(row.locator('.alex-money__value')).toContainText(formatAtomicForUi(amountAtomic));
}

const NAV_PATHS = {
  Home: '/',
  Earn: '/earn',
  Tasks: '/tasks',
  Friends: '/friends',
  Wallet: '/wallet',
} as const;

export type NavName = keyof typeof NAV_PATHS;

/**
 * The element under the painted control must be that control (or a child of it).
 * A transparent overlay that steals taps fails this before the click.
 */
export async function expectPointerHits(
  page: Page,
  locator: Locator,
  expectedHref: string,
): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  const hitHref = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const el = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return el?.closest('a')?.getAttribute('href') ?? null;
  });
  expect(hitHref, `elementFromPoint must hit ${expectedHref}`).toBe(expectedHref);
}

/** Primary navigation via the bottom bar, not `page.goto`. */
export async function gotoNav(page: Page, name: NavName): Promise<void> {
  const link = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', {
    name,
    exact: true,
  });
  await expect(link).toBeVisible();
  await expectPointerHits(page, link, NAV_PATHS[name]);
  await link.click();
  await expect.poll(async () => new URL(page.url()).pathname).toBe(NAV_PATHS[name]);
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

export async function clickGoToEarn(page: Page): Promise<void> {
  const link = page.getByRole('link', { name: 'Go to Earn' });
  await expect(link).toBeVisible();
  await expectPointerHits(page, link, '/earn');
  await link.click();
  await expect.poll(async () => new URL(page.url()).pathname).toBe('/earn');
  await expect(page.getByRole('heading', { level: 1, name: 'Earn', exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

export async function clickProfileHeader(page: Page): Promise<void> {
  const link = page.getByRole('link', { name: 'Open profile' });
  await expect(link).toBeVisible();
  await expectPointerHits(page, link, '/profile');
  await link.click();
  await expect.poll(async () => new URL(page.url()).pathname).toBe('/profile');
  await expect(page.getByRole('heading', { level: 1, name: 'Profile', exact: true })).toBeVisible({
    timeout: 60_000,
  });
}

/** Setup-only navigation. Do not use this to prove the bottom bar is tappable. */
export function miniappUrl(path: string): string {
  return `${E2E_MINIAPP_BASE_URL}${path}`;
}
