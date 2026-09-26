import { adminPost, errorCode } from '../src/helpers/api.js';
import {
  completeReauthDialogPasswordTotp,
  loginViaPasswordTotpUi,
} from '../src/helpers/auth-ui.js';
import { expect, test } from './fixtures.js';

test.describe('D. Server confirmation ceremony', () => {
  test('prepare → confirm → mutate once; replay and altered payload fail', async ({
    page,
    seed,
  }) => {
    await loginViaPasswordTotpUi(page, seed.email);
    await page.goto('/feature-flags');
    await expect(page.getByTestId('payout-pause-warning')).toBeVisible();

    const flagsRes = await page.context().request.get(
      `${seed.apiBaseUrl}/v1/admin/feature-flags`,
      {
        headers: {
          Origin: seed.adminBaseUrl,
          Referer: `${seed.adminBaseUrl}/`,
          Accept: 'application/json',
        },
      },
    );
    expect(flagsRes.ok()).toBeTruthy();
    const flagsBody = (await flagsRes.json()) as {
      items?: Array<{
        flagKey: string;
        environment: string;
        enabled: boolean;
        version: number;
      }>;
    };
    const pause = flagsBody.items?.find(
      (f) => f.flagKey === 'PAYOUT_DISPATCH_PAUSE' && f.environment === 'LOCAL',
    );
    expect(pause, 'PAYOUT_DISPATCH_PAUSE LOCAL fixture required').toBeTruthy();

    await page.getByTestId('flag-propose-PAYOUT_DISPATCH_PAUSE').click();
    const reason = 'Phase13 E2E ceremony — toggle PAYOUT_DISPATCH_PAUSE once';
    await page.getByTestId('ceremony-reason').fill(reason);
    await page.getByTestId('ceremony-prepare').click();
    await completeReauthDialogPasswordTotp(page);
    await expect(page.getByTestId('ceremony-phrase')).toBeVisible({ timeout: 60_000 });
    const phrase = (await page.getByTestId('ceremony-phrase').innerText()).trim();
    expect(phrase.length).toBeGreaterThan(3);

    await page.getByTestId('ceremony-confirm-input').fill(phrase);
    await page.getByTestId('ceremony-submit').click();
    const dialog = page.locator('dialog.admin-dialog');
    if (await dialog.isVisible().catch(() => false)) {
      await completeReauthDialogPasswordTotp(page);
    }

    await expect(page.getByTestId('ceremony-reason')).toHaveCount(0, { timeout: 60_000 });

    const afterFlags = await page.context().request.get(
      `${seed.apiBaseUrl}/v1/admin/feature-flags`,
      {
        headers: {
          Origin: seed.adminBaseUrl,
          Referer: `${seed.adminBaseUrl}/`,
          Accept: 'application/json',
        },
      },
    );
    const afterBody = (await afterFlags.json()) as {
      items?: Array<{
        flagKey: string;
        environment: string;
        enabled: boolean;
        version: number;
      }>;
    };
    const pauseAfter = afterBody.items?.find(
      (f) => f.flagKey === 'PAYOUT_DISPATCH_PAUSE' && f.environment === 'LOCAL',
    );
    expect(pauseAfter).toBeTruthy();
    expect(pauseAfter!.enabled).toBe(!pause!.enabled);
    expect(pauseAfter!.version).toBe(pause!.version + 1);

    const reason2 = 'Phase13 E2E replay/alter proof';
    const payload = {
      flagKey: 'PAYOUT_DISPATCH_PAUSE',
      environment: 'LOCAL',
      enabled: !pauseAfter!.enabled,
      reason: reason2,
    };
    const prepared = await adminPost(page, '/v1/admin/confirmations/prepare', {
      actionType: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: String(pauseAfter!.version),
      payload,
    });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const preparedBody = prepared.body as {
      confirmationId: string;
      confirmationPhrase: string;
    };

    const confirmed = await adminPost(
      page,
      `/v1/admin/confirmations/${preparedBody.confirmationId}/confirm`,
      { confirmationPhrase: preparedBody.confirmationPhrase },
    );
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);

    const mutateOk = await adminPost(page, '/v1/admin/feature-flags', {
      ...payload,
      expectedVersion: String(pauseAfter!.version),
      confirmationId: preparedBody.confirmationId,
    });
    expect(mutateOk.status, JSON.stringify(mutateOk.body)).toBe(200);

    const replay = await adminPost(page, '/v1/admin/feature-flags', {
      ...payload,
      expectedVersion: String(pauseAfter!.version + 1),
      confirmationId: preparedBody.confirmationId,
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(replay.body)).toMatch(/CONFIRMATION|FORBIDDEN|VALIDATION/);

    const prepared2 = await adminPost(page, '/v1/admin/confirmations/prepare', {
      actionType: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: String(pauseAfter!.version + 1),
      payload,
    });
    expect(prepared2.status).toBe(200);
    const prepared2Body = prepared2.body as {
      confirmationId: string;
      confirmationPhrase: string;
    };
    await adminPost(page, `/v1/admin/confirmations/${prepared2Body.confirmationId}/confirm`, {
      confirmationPhrase: prepared2Body.confirmationPhrase,
    });
    const altered = await adminPost(page, '/v1/admin/feature-flags', {
      flagKey: 'PAYOUT_DISPATCH_PAUSE',
      environment: 'LOCAL',
      enabled: !payload.enabled,
      reason: reason2,
      expectedVersion: String(pauseAfter!.version + 1),
      confirmationId: prepared2Body.confirmationId,
    });
    expect(altered.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(altered.body)).toMatch(/CONFIRMATION|FORBIDDEN|VALIDATION/);
  });
});
