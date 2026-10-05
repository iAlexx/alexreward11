import { test as base, expect, type Page } from '@playwright/test';

import { E2E_API_BASE_URL, E2E_MINIAPP_BASE_URL } from '../src/env.js';
import { installTelegramWebAppInitData, loginViaApiAndStoreSession } from '../src/fixtures/auth.js';
import { readPublicSeed, type Phase12E2ePublicSeed } from '../src/fixtures/seed-meta.js';

type Fixtures = {
  seed: Phase12E2ePublicSeed;
  apiBaseUrl: string;
  asStandardUser: Page;
  asFounderUser: Page;
  asOtherUser: Page;
};

/**
 * Telegram-auth style entry:
 * 1. Inject signed initData (survives telegram-web-app.js overwrite).
 * 2. Also mint a real session via POST /v1/auth/telegram (Phase 3 pattern).
 * AuthProvider boots READY from sessionStorage; initData remains available for retry.
 */
async function bootAsTelegramUser(page: Page, telegramUserId: string): Promise<void> {
  await installTelegramWebAppInitData(page, telegramUserId);
  await loginViaApiAndStoreSession(page, E2E_API_BASE_URL, telegramUserId);
  await page.goto(E2E_MINIAPP_BASE_URL + '/');
  await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Every value on this screen comes from the server.')).toBeVisible();
}

export const test = base.extend<Fixtures>({
  seed: async ({}, use) => {
    await use(readPublicSeed());
  },
  apiBaseUrl: async ({}, use) => {
    await use(E2E_API_BASE_URL);
  },
  asStandardUser: async ({ page, seed }, use) => {
    await bootAsTelegramUser(page, seed.standardTelegramUserId);
    await use(page);
  },
  asFounderUser: async ({ page, seed }, use) => {
    await bootAsTelegramUser(page, seed.founderTelegramUserId);
    await use(page);
  },
  asOtherUser: async ({ page, seed }, use) => {
    await bootAsTelegramUser(page, seed.otherTelegramUserId);
    await use(page);
  },
});

export { expect };
