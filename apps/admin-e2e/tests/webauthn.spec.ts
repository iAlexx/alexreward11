import { adminPost } from '../src/helpers/api.js';
import { getAdminSessionCookie, loginViaPasswordTotpUi } from '../src/helpers/auth-ui.js';
import { createPasskeyCredential, enableVirtualAuthenticator } from '../src/helpers/webauthn.js';
import { expect, test } from './fixtures.js';

test.describe('B. WebAuthn enrollment + login', () => {
  test('reauthenticated Owner enrolls passkey; logout; WebAuthn login is cookie-only', async ({
    page,
    seed,
  }) => {
    test.setTimeout(240_000);
    await enableVirtualAuthenticator(page);
    const { loginJson } = await loginViaPasswordTotpUi(page, seed.email);
    expect(loginJson).not.toHaveProperty('sessionToken');

    const optionsRes = await adminPost(page, '/v1/admin/auth/webauthn/register/options', {});
    expect(optionsRes.status, JSON.stringify(optionsRes.body)).toBe(200);
    const optionsBody = optionsRes.body as {
      options: Record<string, unknown>;
    };

    const attestation = await createPasskeyCredential(page, optionsBody.options);
    const verifyRes = await adminPost(page, '/v1/admin/auth/webauthn/register/verify', {
      response: attestation,
      label: 'e2e-virtual-passkey',
    });
    expect(verifyRes.status, JSON.stringify(verifyRes.body)).toBe(200);

    const logout = await adminPost(page, '/v1/admin/auth/logout', {});
    expect(logout.status, JSON.stringify(logout.body)).toBe(200);

    // Stay on the same page/CDP session so the virtual authenticator still holds the passkey.
    await page.goto('about:blank', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Passkey' }).click();
    await page.locator('input[type="email"]').fill(seed.email);

    const loginResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/v1/admin/auth/webauthn/login/verify') &&
        res.request().method() === 'POST',
      { timeout: 120_000 },
    );
    await page.getByRole('button', { name: 'Sign in with passkey', exact: true }).click();
    const loginResponse = await loginResponsePromise;
    expect(loginResponse.ok()).toBeTruthy();
    const webauthnLoginJson = (await loginResponse.json()) as unknown;
    expect(webauthnLoginJson).not.toHaveProperty('sessionToken');

    const adminCookie = await getAdminSessionCookie(page);
    expect(adminCookie?.httpOnly).toBe(true);

    await page.waitForURL(/\/overview/, { timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible({
      timeout: 60_000,
    });
  });
});
