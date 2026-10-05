import { randomUUID } from 'node:crypto';

import { formatAtomicForUi } from '../src/helpers/money.js';
import { expectSeededBalancesVisible, gotoNav } from '../src/helpers/ui.js';
import { expect, test } from './fixtures.js';

test.describe('Phase 12 CLIENT TAMPER browser E2E', () => {
  test('DOM balance edits do not mutate backend; refetch restores authority', async ({
    asStandardUser: page,
    seed,
    apiBaseUrl,
  }) => {
    await expectSeededBalancesVisible(page, seed.balances);

    await page.evaluate(() => {
      for (const node of document.querySelectorAll('.alex-money__value')) {
        node.textContent = '999999999 USDT';
      }
    });
    await expect(page.getByText('999999999 USDT').first()).toBeVisible();

    const balances = await page.request.get(`${apiBaseUrl}/v1/me/balances`, {
      headers: { Authorization: `Bearer ${await token(page)}` },
    });
    expect(balances.ok()).toBeTruthy();
    const body = (await balances.json()) as {
      available: { amountAtomic: string };
    };
    expect(body.available.amountAtomic).toBe(seed.balances.available);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expectSeededBalancesVisible(page, seed.balances);
  });

  test('fabricated Founder flag does not create membership', async ({
    asStandardUser: page,
    apiBaseUrl,
  }) => {
    await page.goto('/profile/founder');
    await expect(page.getByText('You are not a Founder yet')).toBeVisible();

    await page.evaluate(() => {
      const badge = document.createElement('p');
      badge.className = 'alex-badge';
      badge.textContent = 'Founder';
      document.body.appendChild(badge);
      const number = document.createElement('p');
      number.className = 'alex-title';
      number.textContent = 'Founder #1';
      document.body.appendChild(number);
    });
    await expect(page.getByText('Founder #1')).toBeVisible();

    const membership = await page.request.get(`${apiBaseUrl}/v1/membership`, {
      headers: { Authorization: `Bearer ${await token(page)}` },
    });
    const body = (await membership.json()) as { isFounder: boolean; founderNumber: number | null };
    expect(body.isFounder).toBe(false);
    expect(body.founderNumber).toBeNull();

    await page.reload();
    await expect(page.getByText('You are not a Founder yet')).toBeVisible();
  });

  test('fabricated reward completion does not create ledger reward', async ({
    asStandardUser: page,
    seed,
    apiBaseUrl,
  }) => {
    await gotoNav(page, 'Earn');
    const fakeSessionId = randomUUID();
    const verify = await page.request.post(
      `${apiBaseUrl}/v1/ads/sessions/${fakeSessionId}/attempt-verify`,
      {
        headers: {
          Authorization: `Bearer ${await token(page)}`,
          'Content-Type': 'application/json',
        },
        data: {},
      },
    );
    expect(verify.ok()).toBeFalsy();

    const balances = await page.request.get(`${apiBaseUrl}/v1/me/balances`, {
      headers: { Authorization: `Bearer ${await token(page)}` },
    });
    const body = (await balances.json()) as {
      available: { amountAtomic: string };
      pending: { amountAtomic: string };
    };
    expect(body.available.amountAtomic).toBe(seed.balances.available);
    expect(body.pending.amountAtomic).toBe(seed.balances.pending);
    expect(formatAtomicForUi(body.available.amountAtomic)).toBe(
      formatAtomicForUi(seed.balances.available),
    );
  });
});

async function token(page: import('@playwright/test').Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('alex.rewards.auth.v1');
    if (raw === null) return null;
    return (JSON.parse(raw) as { session?: { accessToken?: string } }).session?.accessToken ?? null;
  });
  if (value === null || value.trim() === '') throw new Error('missing access token');
  return value;
}
