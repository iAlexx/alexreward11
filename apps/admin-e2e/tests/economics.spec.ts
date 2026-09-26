import { loginViaPasswordTotpUi } from '../src/helpers/auth-ui.js';
import { expect, test } from './fixtures.js';

test.describe('F. Economics honesty', () => {
  test('shows truthful categories; no settled margin from payout principal; UNAVAILABLE visible', async ({
    page,
    seed,
  }) => {
    await loginViaPasswordTotpUi(page, seed.email);
    await page.goto('/economics');

    await expect(
      page.getByText('CONFIRMED_WITHDRAWAL_PRINCIPAL_OPERATIONAL', { exact: false }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Operational payout principal only/i)).toBeVisible();

    const pageText = await page.locator('body').innerText();
    // Disclaimer may say "not settled margin" — forbid labeling principal AS settled margin/profit.
    expect(pageText).not.toMatch(/settledMarginAtomic/i);
    expect(pageText).not.toMatch(/settled margin\/profit/i);
    expect(pageText).toMatch(/not settled margin/i);

    await expect(page.getByText('PROVIDER_SETTLED_CONFIRMED_REVENUE', { exact: false })).toBeVisible();
    await expect(page.getByText('UNAVAILABLE').first()).toBeVisible();
    await expect(
      page.getByText('PROVIDER_SETTLEMENT_NOT_CONFIGURED', { exact: false }),
    ).toBeVisible();
  });
});
