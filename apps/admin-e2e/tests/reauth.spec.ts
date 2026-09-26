import { resolvePhase13DatabaseUrlFromEnv } from '../src/env.js';
import { staleAdminSessionReauth } from '../src/fixtures/db.js';
import { readSecrets } from '../src/fixtures/seed-meta.js';
import { adminGet, adminPost, errorCode } from '../src/helpers/api.js';
import {
  completeReauthDialogPasswordTotp,
  currentTotpCode,
  loginViaPasswordTotpUi,
  waitForUnusedTotpWindow,
} from '../src/helpers/auth-ui.js';
import { expect, test } from './fixtures.js';

test.describe('C. Reauth freshness', () => {
  test('stale reauth blocks high-impact prepare; password+TOTP reauth refreshes', async ({
    page,
    seed,
  }) => {
    await loginViaPasswordTotpUi(page, seed.email);

    await staleAdminSessionReauth(resolvePhase13DatabaseUrlFromEnv());

    const stalePrepare = await adminPost(page, '/v1/admin/confirmations/prepare', {
      actionType: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: '0',
      payload: { probe: true },
    });
    expect(stalePrepare.status).toBeGreaterThanOrEqual(400);
    const staleCode = errorCode(stalePrepare.body);
    expect(staleCode === 'FORBIDDEN' || staleCode === 'UNAUTHENTICATED').toBe(true);

    const secrets = readSecrets();
    await waitForUnusedTotpWindow();
    const reauth = await adminPost(page, '/v1/admin/auth/reauth/password-totp', {
      password: secrets.password,
      totpCode: currentTotpCode(),
    });
    expect(reauth.status, JSON.stringify(reauth.body)).toBe(200);
    const reauthBody = reauth.body as { reauthenticatedAt?: string };
    expect(reauthBody.reauthenticatedAt).toBeTruthy();
    const freshnessMs = Date.now() - Date.parse(reauthBody.reauthenticatedAt!);
    expect(freshnessMs).toBeLessThan(60_000);

    const session = await adminGet(page, '/v1/admin/auth/session');
    expect(session.status).toBe(200);
    const sessionBody = session.body as { reauthenticatedAt?: string };
    expect(sessionBody.reauthenticatedAt).toBeTruthy();

    await page.goto('/feature-flags');
    await expect(page.getByTestId('payout-pause-warning')).toBeVisible();
    const propose = page.getByTestId('flag-propose-PAYOUT_DISPATCH_PAUSE');
    if ((await propose.count()) > 0) {
      await propose.click();
      await page.getByTestId('ceremony-reason').fill('E2E reauth probe — do not mutate yet');
      await page.getByTestId('ceremony-prepare').click();
      const dialog = page.locator('dialog.admin-dialog');
      if (await dialog.isVisible().catch(() => false)) {
        await completeReauthDialogPasswordTotp(page);
      }
      await expect(page.getByTestId('ceremony-phrase')).toBeVisible({ timeout: 60_000 });
    }
  });
});
