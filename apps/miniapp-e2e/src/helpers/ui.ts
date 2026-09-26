import type { Page } from '@playwright/test';
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

export async function gotoNav(page: Page, name: keyof typeof NAV_PATHS): Promise<void> {
  await page.goto(`${E2E_MINIAPP_BASE_URL}${NAV_PATHS[name]}`);
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible({ timeout: 60_000 });
}
