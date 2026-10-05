import { Client } from 'pg';

import { E2E_MINIAPP_BASE_URL, resolvePhase12DatabaseUrlFromEnv } from '../src/env.js';
import { installTelegramWebAppInitData, loginViaApiAndStoreSession } from '../src/fixtures/auth.js';
import { readSecrets } from '../src/fixtures/seed-meta.js';
import { formatAtomicForUi } from '../src/helpers/money.js';
import { expect, test } from './fixtures.js';

test.describe('Phase 12 FOUNDER USER browser E2E', () => {
  test('non-Founder screen, claim once, badge+number, entitlements, clear code, replay refused', async ({
    browser,
    seed,
    apiBaseUrl,
  }) => {
    const secrets = readSecrets();
    const claimCode = secrets.founderClaimCode;

    const founderContext = await browser.newContext();
    const founderPage = await founderContext.newPage();
    await installTelegramWebAppInitData(founderPage, seed.founderTelegramUserId);
    await loginViaApiAndStoreSession(founderPage, apiBaseUrl, seed.founderTelegramUserId);
    await founderPage.goto(`${E2E_MINIAPP_BASE_URL}/profile/founder`);
    await expect(founderPage.getByRole('heading', { name: 'Founder' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(founderPage.getByText('You are not a Founder yet')).toBeVisible();
    await expect(
      founderPage.getByText('Founder status never bypasses a security, limit or withdrawal check.'),
    ).toBeVisible();

    await founderPage.getByLabel('Founder claim code').fill(claimCode);
    await founderPage.getByRole('button', { name: 'Submit claim code' }).click();
    // Claim form unmounts after success; assert server-rendered Founder status instead of the
    // transient success banner that lived on the form.
    await expect(
      founderPage.getByText(`Founder #${seed.founderNumber}`, { exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(founderPage.getByLabel('Founder claim code')).toHaveCount(0);

    await expect(founderPage.getByText('Founder', { exact: true }).first()).toBeVisible();
    await expect(
      founderPage.getByRole('heading', { name: 'Entitlements', exact: true }),
    ).toBeVisible();

    const accessToken = await token(founderPage);
    const membership = await founderPage.request.get(`${apiBaseUrl}/v1/membership`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(membership.ok()).toBeTruthy();
    const membershipBody = (await membership.json()) as {
      isFounder: boolean;
      founderNumber: number | null;
      securityBypass: boolean;
    };
    expect(membershipBody.isFounder).toBe(true);
    expect(membershipBody.founderNumber).toBe(seed.founderNumber);
    expect(membershipBody.securityBypass).toBe(false);

    const replay = await founderPage.request.post(`${apiBaseUrl}/v1/membership/founder/claim`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      data: { claimCode },
    });
    expect(replay.ok()).toBeFalsy();

    const ledgerCount = await countLedgerTxForUser(seed.founderTelegramUserId);
    expect(ledgerCount).toBe(0);

    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await installTelegramWebAppInitData(otherPage, seed.otherTelegramUserId);
    await loginViaApiAndStoreSession(otherPage, apiBaseUrl, seed.otherTelegramUserId);
    await otherPage.goto(`${E2E_MINIAPP_BASE_URL}/profile/founder`);
    await expect(otherPage.getByText('You are not a Founder yet')).toBeVisible({ timeout: 60_000 });
    await otherPage.getByLabel('Founder claim code').fill(claimCode);
    await otherPage.getByRole('button', { name: 'Submit claim code' }).click();
    await expect(otherPage.getByText('This claim code was rejected.')).toBeVisible();

    await founderContext.close();
    await otherContext.close();
  });

  test('Founder is not a security bypass for balances', async ({ asFounderUser: page, seed }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Home' })).toBeVisible();
    await expectBalanceRow(page, 'Available', '0');
    await expect(
      page
        .locator('.alex-money')
        .filter({ hasText: 'Available' })
        .getByText(seed.balances.available),
    ).toHaveCount(0);
  });
});

async function expectBalanceRow(
  page: import('@playwright/test').Page,
  label: string,
  amountAtomic: string,
): Promise<void> {
  const row = page.locator('.alex-money').filter({ hasText: label });
  await expect(row).toBeVisible();
  await expect(row.locator('.alex-money__value')).toContainText(formatAtomicForUi(amountAtomic));
}

async function token(page: import('@playwright/test').Page): Promise<string> {
  const value = await page.evaluate(() => {
    const raw = window.sessionStorage.getItem('alex.rewards.auth.v1');
    if (raw === null) return null;
    return (JSON.parse(raw) as { session?: { accessToken?: string } }).session?.accessToken ?? null;
  });
  if (value === null || value.trim() === '') throw new Error('missing access token');
  return value;
}

async function countLedgerTxForUser(telegramUserId: string): Promise<number> {
  const client = new Client({ connectionString: resolvePhase12DatabaseUrlFromEnv() });
  await client.connect();
  try {
    const result = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c
       FROM ledger_transactions lt
       JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
       JOIN ledger_accounts la ON la.id = le.ledger_account_id
       JOIN users u ON u.id = la.owner_id
       WHERE u.telegram_user_id = $1::bigint
         AND la.owner_type = 'USER'`,
      [telegramUserId],
    );
    return result.rows[0]?.c ?? -1;
  } finally {
    await client.end();
  }
}
