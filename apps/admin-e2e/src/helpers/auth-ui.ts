import { ADMIN_TOTP_PERIOD_SECONDS, generateTotpCode } from '@alex-rewards/auth';
import { Client } from 'pg';
import type { Page, Response } from '@playwright/test';

import { E2E_API_BASE_URL } from '../env.js';
import { resolvePhase13DatabaseUrl } from '../fixtures/db.js';
import { readSecrets } from '../fixtures/seed-meta.js';

const PERIOD_MS = ADMIN_TOTP_PERIOD_SECONDS * 1000;

/**
 * TOTP steps are single-use. After login consumes the current step, wait for the next window.
 */
export async function waitForUnusedTotpWindow(): Promise<void> {
  const now = Date.now();
  const elapsed = now % PERIOD_MS;
  const waitMs = PERIOD_MS - elapsed + 100;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

export function currentTotpCode(): string {
  const secrets = readSecrets();
  const bytes = Uint8Array.from(Buffer.from(secrets.totpSecretBase64, 'base64'));
  return generateTotpCode(bytes);
}

/** Clear lockout / failure counters so prior failed attempts do not poison later specs. */
export async function clearAdminAuthThrottle(): Promise<void> {
  const client = new Client({ connectionString: resolvePhase13DatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DELETE FROM admin_auth_throttle`);
  } finally {
    await client.end();
  }
}

export async function loginViaPasswordTotpUi(
  page: Page,
  email: string,
): Promise<{ loginJson: unknown; loginResponse: Response }> {
  await clearAdminAuthThrottle();
  await waitForUnusedTotpWindow();

  const secrets = readSecrets();
  await page.goto('/login');
  await page.getByRole('tab', { name: 'Password + TOTP' }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(secrets.password);
  await page.locator('input[autocomplete="one-time-code"]').fill(currentTotpCode());

  const loginResponsePromise = page.waitForResponse(
    (res) =>
      res.url().includes('/v1/admin/auth/login/password-totp') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const loginResponse = await loginResponsePromise;
  const loginJson = (await loginResponse.json()) as unknown;
  if (!loginResponse.ok()) {
    throw new Error(
      `password+TOTP login failed: ${loginResponse.status()} ${JSON.stringify(loginJson)}`,
    );
  }
  await page.waitForURL(/\/overview/, { timeout: 60_000 });
  await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor({ timeout: 60_000 });
  return { loginJson, loginResponse };
}

export async function completeReauthDialogPasswordTotp(page: Page): Promise<void> {
  const secrets = readSecrets();
  const dialog = page.locator('dialog.admin-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  await dialog.getByRole('tab', { name: 'Password + TOTP' }).click();
  await waitForUnusedTotpWindow();
  await dialog.locator('input[type="password"]').fill(secrets.password);
  await dialog.locator('input[autocomplete="one-time-code"]').fill(currentTotpCode());
  await dialog.getByRole('button', { name: 'Reauthenticate', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 60_000 });
}

export async function assertNoAdminCredentialStorage(page: Page): Promise<{
  sessionKeys: string[];
  localKeys: string[];
}> {
  return page.evaluate(() => {
    const sessionKeys: string[] = [];
    const localKeys: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key !== null) sessionKeys.push(key);
    }
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null) localKeys.push(key);
    }
    return { sessionKeys, localKeys };
  });
}

/** Path=/v1/admin cookies are only visible for URLs under that path. */
export async function getAdminSessionCookie(page: Page) {
  const cookies = await page.context().cookies(`${E2E_API_BASE_URL}/v1/admin/auth/session`);
  return cookies.find((c) => c.name === 'admin_session');
}
