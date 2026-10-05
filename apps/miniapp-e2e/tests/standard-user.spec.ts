import { E2E_MINIAPP_BASE_URL } from '../src/env.js';
import { formatAtomicForUi } from '../src/helpers/money.js';
import { expectSeededBalancesVisible, gotoNav } from '../src/helpers/ui.js';
import { expect, test } from './fixtures.js';

test.describe('Phase 12 STANDARD USER browser E2E', () => {
  test('1–3 auth entry, home server balances match seeded ledger', async ({
    asStandardUser: page,
    seed,
  }) => {
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expectSeededBalancesVisible(page, seed.balances);
  });

  test('4–7 Earn AdsGram BLOCKED, dynamic wording, usageBasis, no client credit', async ({
    asStandardUser: page,
    seed,
  }) => {
    await gotoNav(page, 'Earn');
    await expect(page.getByText('Production rewards are blocked for this provider')).toBeVisible();
    await expect(page.getByText(/Blocked\s*·/)).toBeVisible();
    await expect(
      page.getByText('Rewards vary and are never guaranteed. Inventory and quotes can change.'),
    ).toBeVisible();
    await expect(
      page.getByText('Counted from server-authorized sessions — not proven provider requests.'),
    ).toBeVisible();
    await expect(page.getByText(/Availability is not guaranteed/i)).toBeVisible();

    const availableBefore = formatAtomicForUi(seed.balances.available);
    await page.getByRole('button', { name: 'Watch an ad' }).click();
    await expect(page.getByText('Rewards are not enabled in this environment.')).toBeVisible();

    await gotoNav(page, 'Home');
    await expectSeededBalancesVisible(page, seed.balances);
    await expect(
      page.locator('.alex-money').filter({ hasText: 'Available' }).locator('.alex-money__value'),
    ).toContainText(availableBefore);
  });

  test('8 Tasks and Friends ENGINE_NOT_ENABLED', async ({ asStandardUser: page }) => {
    await gotoNav(page, 'Tasks');
    await expect(page.getByText('The mission engine is not enabled yet')).toBeVisible();
    await expect(page.getByText('This feature is not enabled yet.')).toBeVisible();

    await gotoNav(page, 'Friends');
    await expect(page.getByText('The referral programme is not enabled yet')).toBeVisible();
  });

  test('9–10 Wallet balances, verification, history, withdrawal quote fee/net', async ({
    asStandardUser: page,
    seed,
  }) => {
    await gotoNav(page, 'Wallet');
    await expectSeededBalancesVisible(page, seed.balances);
    await expect(page.getByText('Ownership proven')).toBeVisible();
    await expect(page.getByText(seed.standardFriendlyAddress)).toBeVisible();
    await expect(page.getByText('TON Connect is not configured')).toBeVisible();
    await expect(page.getByText('No withdrawals yet.')).toBeVisible();

    await page.getByLabel('Amount (atomic units)').fill(seed.quote.requested);
    await page.getByRole('button', { name: 'Get quote' }).click();
    await expect(
      page.getByText(new RegExp(`Fee:\\s*${formatAtomicForUi(seed.quote.fee)}`)),
    ).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Net:\\s*${formatAtomicForUi(seed.quote.net)}`)),
    ).toBeVisible();
  });

  test('11–14 locale, payout privacy, support ticket, deletion request only', async ({
    asStandardUser: page,
    apiBaseUrl,
  }) => {
    await page.goto(`${E2E_MINIAPP_BASE_URL}/profile`);
    await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();

    await page.getByRole('button', { name: 'Hide identity' }).click();
    await expect(page.getByText('Payout privacy updated.')).toBeVisible();
    const settingsAfterPrivacy = await page.request.get(`${apiBaseUrl}/v1/me/settings`, {
      headers: {
        Authorization: `Bearer ${await accessTokenFromPage(page)}`,
      },
    });
    expect(settingsAfterPrivacy.ok()).toBeTruthy();
    const privacyBody = (await settingsAfterPrivacy.json()) as {
      publicPayoutIdentityMode: string;
    };
    expect(privacyBody.publicPayoutIdentityMode).toBe('HIDE_IDENTITY');

    await page.getByLabel('Subject').fill('Phase12 E2E support');
    await page.getByLabel('Message (optional)').fill('Isolated e2e ticket body');
    await page.getByRole('button', { name: 'Send support request' }).click();
    await expect(page.getByText(/Ticket .+ created\./)).toBeVisible();

    await page.getByLabel('I understand this is a review request, not immediate deletion.').check();
    await page.getByRole('button', { name: 'Request account deletion review' }).click();
    await expect(page.getByText(/Deletion review request .+ submitted\./)).toBeVisible();

    await page.getByRole('button', { name: 'RU' }).click();
    await expect(page.getByText('Язык обновлён.')).toBeVisible();
    const settingsAfterLocale = await page.request.get(`${apiBaseUrl}/v1/me/settings`, {
      headers: {
        Authorization: `Bearer ${await accessTokenFromPage(page)}`,
      },
    });
    expect(settingsAfterLocale.ok()).toBeTruthy();
    const localeBody = (await settingsAfterLocale.json()) as { preferredLocale: string };
    expect(localeBody.preferredLocale).toBe('ru');
    await expect.poll(async () => page.evaluate(() => document.documentElement.lang)).toBe('ru');

    await page.getByRole('button', { name: 'EN' }).click();
    await expect(page.getByText('Language updated.')).toBeVisible();
    const settingsAfterEn = await page.request.get(`${apiBaseUrl}/v1/me/settings`, {
      headers: {
        Authorization: `Bearer ${await accessTokenFromPage(page)}`,
      },
    });
    const enBody = (await settingsAfterEn.json()) as { preferredLocale: string };
    expect(enBody.preferredLocale).toBe('en');
  });

  test('15 reload restores server truth', async ({ asStandardUser: page, seed }) => {
    await expectSeededBalancesVisible(page, seed.balances);
    await page.evaluate(() => {
      const nodes = document.querySelectorAll('.alex-money__value');
      for (const node of nodes) {
        node.textContent = '999999999 USDT';
      }
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expectSeededBalancesVisible(page, seed.balances);
  });
});

async function accessTokenFromPage(page: import('@playwright/test').Page): Promise<string> {
  const token = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('alex.rewards.auth.v1');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { session?: { accessToken?: string } };
    return parsed.session?.accessToken ?? null;
  });
  if (token === null || token.trim() === '') {
    throw new Error('missing access token in sessionStorage');
  }
  return token;
}
