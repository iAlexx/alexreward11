import {
  assertNoAdminCredentialStorage,
  getAdminSessionCookie,
  loginViaPasswordTotpUi,
} from '../src/helpers/auth-ui.js';
import { expect, test } from './fixtures.js';

test.describe('A. Cookie-only login', () => {
  test('password+TOTP login is cookie-only with no client credential storage', async ({
    page,
    seed,
  }) => {
    const { loginJson } = await loginViaPasswordTotpUi(page, seed.email);

    expect(loginJson).toBeTruthy();
    expect(loginJson).not.toHaveProperty('sessionToken');
    if (loginJson !== null && typeof loginJson === 'object') {
      for (const key of Object.keys(loginJson as Record<string, unknown>)) {
        expect(key.toLowerCase()).not.toContain('token');
      }
    }

    const adminCookie = await getAdminSessionCookie(page);
    expect(adminCookie, 'HttpOnly admin_session cookie must exist').toBeTruthy();
    expect(adminCookie!.httpOnly).toBe(true);
    expect(adminCookie!.path).toBe('/v1/admin');

    const storage = await assertNoAdminCredentialStorage(page);
    expect(storage.sessionKeys.some((k) => /admin|bearer|session|token/i.test(k))).toBe(false);
    expect(storage.localKeys.some((k) => /admin|bearer|session|token/i.test(k))).toBe(false);

    // Login helper already asserted Overview; confirm cookie still authenticates via API.
    const session = await page.context().request.get(
      `${seed.apiBaseUrl}/v1/admin/auth/session`,
      {
        headers: {
          Origin: seed.adminBaseUrl,
          Referer: `${seed.adminBaseUrl}/`,
          Accept: 'application/json',
        },
      },
    );
    expect(session.ok()).toBeTruthy();
    const body = (await session.json()) as { authSource?: string; email?: string };
    expect(body.authSource).toBe('cookie');
    expect(body.email).toBe(seed.email);
  });
});
