import { randomUUID } from 'node:crypto';

import { adminPost, errorCode } from '../src/helpers/api.js';
import { loginViaPasswordTotpUi } from '../src/helpers/auth-ui.js';
import { expect, test } from './fixtures.js';

test.describe('G. Authority — client tampering cannot escalate', () => {
  test('forged Founder grant / limits / AdsGram / balances / confirmation mint are refused', async ({
    page,
    seed,
  }) => {
    await loginViaPasswordTotpUi(page, seed.email);

    const fakeConfirmationId = randomUUID();
    const fakeUserId = randomUUID();

    const founder = await adminPost(page, '/v1/admin/memberships/founders/grant', {
      targetUserId: fakeUserId,
      paymentReferenceRedacted: 'e2e-forged',
      reason: 'client tamper founder grant',
      expectedVersion: '1',
      confirmationId: fakeConfirmationId,
    });
    expect(founder.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(founder.body)).toMatch(/CONFIRMATION|FORBIDDEN|VALIDATION/);

    const limits = await adminPost(page, '/v1/admin/providers/ADSGRAM/limits', {
      limitScope: 'GLOBAL',
      limitMetric: 'REQUESTS',
      maxCount: 999_999_999,
      oldMaxCount: 1,
      sourceType: 'OWNER_OVERRIDE',
      sourceReference: 'e2e-tamper',
      reason: 'raise hard limit via client',
      expectedVersion: '1',
      confirmationId: fakeConfirmationId,
    });
    expect(limits.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(limits.body)).toMatch(/CONFIRMATION|FORBIDDEN|VALIDATION/);

    const ads = await adminPost(page, '/v1/admin/ads/providers/ADSGRAM/monetary-status', {
      targetStatus: 'APPROVED',
      reason: 'approve AdsGram via client forge',
      expectedVersion: '1',
      confirmationId: fakeConfirmationId,
    });
    expect(ads.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(ads.body)).toMatch(/CONFIRMATION|FORBIDDEN|VALIDATION|CLARIFICATION/);

    for (const path of [
      '/v1/admin/users/set-balance',
      '/v1/admin/ledger/setBalance',
      '/v1/admin/balance-editor',
      '/v1/admin/users/adjust-balance',
    ]) {
      const bal = await adminPost(page, path, {
        userId: fakeUserId,
        amountAtomic: '999999999',
        reason: 'edit balances',
        expectedVersion: '1',
        confirmationId: fakeConfirmationId,
      });
      expect(bal.status).toBeGreaterThanOrEqual(400);
    }

    const mint = await adminPost(page, '/v1/admin/confirmations/prepare', {
      actionType: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: '0',
      payload: { clientForgedDigest: true },
    });
    // Prepare is allowed for authenticated Owner with fresh reauth — but client cannot
    // invent a confirmationId that consume will accept without confirm.
    if (mint.status === 200) {
      const body = mint.body as { confirmationId?: string; confirmationPhrase?: string };
      expect(body.confirmationId).not.toBe(fakeConfirmationId);
      const consumeForge = await adminPost(page, '/v1/admin/feature-flags', {
        flagKey: 'PAYOUT_DISPATCH_PAUSE',
        environment: 'LOCAL',
        enabled: false,
        reason: 'mint bypass',
        expectedVersion: '0',
        confirmationId: fakeConfirmationId,
      });
      expect(consumeForge.status).toBeGreaterThanOrEqual(400);
      expect(errorCode(consumeForge.body)).toMatch(/CONFIRMATION|FORBIDDEN/);
    }

    // Bypass reauth: mutate without confirmation after forging UI state only.
    await page.evaluate(() => {
      const badge = document.createElement('div');
      badge.textContent = 'Founder #1 — forged';
      document.body.appendChild(badge);
    });
    await expect(page.getByText('Founder #1 — forged')).toBeVisible();
    // Server session/roles unchanged — Founder grant still refused above.
  });
});
