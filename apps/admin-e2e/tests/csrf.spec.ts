import { E2E_ADMIN_BASE_URL, E2E_API_BASE_URL } from '../src/env.js';
import { errorCode } from '../src/helpers/api.js';
import { loginViaPasswordTotpUi } from '../src/helpers/auth-ui.js';
import { expect, test } from './fixtures.js';

test.describe('E. CSRF Origin enforcement', () => {
  test('attacker Origin cannot mutate with cookie credentials', async ({ page, seed }) => {
    await loginViaPasswordTotpUi(page, seed.email);

    const res = await page
      .context()
      .request.post(`${E2E_API_BASE_URL}/v1/admin/confirmations/prepare`, {
        headers: {
          Origin: 'https://evil.example',
          Referer: 'https://evil.example/attack',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        data: {
          actionType: 'feature_flags.mutate',
          resourceType: 'feature_flag',
          resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
          expectedVersion: '0',
          payload: { attack: true },
        },
      });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as unknown;
    expect(errorCode(body)).toBe('FORBIDDEN');

    // Same cookie with correct Admin Origin still works.
    const session = await page.context().request.get(`${E2E_API_BASE_URL}/v1/admin/auth/session`, {
      headers: {
        Origin: E2E_ADMIN_BASE_URL,
        Referer: `${E2E_ADMIN_BASE_URL}/`,
        Accept: 'application/json',
      },
    });
    expect(session.ok()).toBeTruthy();
  });
});
