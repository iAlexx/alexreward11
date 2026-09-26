import { buildSignedInitDataForTests } from '@alex-rewards/telegram';
import type { Page } from '@playwright/test';

import { E2E_TELEGRAM_BOT_TOKEN } from '../env.js';

/**
 * Build a signed Telegram Mini App initData string for the E2E bot token.
 * Matches Phase 3 API-test pattern (`buildSignedInitDataForTests`).
 */
export function signedInitDataForTelegramUser(
  telegramUserId: string,
  overrides: Record<string, unknown> = {},
): string {
  return buildSignedInitDataForTests(E2E_TELEGRAM_BOT_TOKEN, {
    user: JSON.stringify({
      id: telegramUserId,
      first_name: 'Phase12',
      username: `u_${telegramUserId.slice(-6)}`,
      language_code: 'en',
      ...overrides,
    }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  });
}

/**
 * Install Telegram WebApp initData before any page script runs.
 *
 * The official `telegram-web-app.js` (loaded beforeInteractive) replaces
 * `window.Telegram` after Playwright init scripts. We therefore:
 * 1. seed an initial WebApp stub, and
 * 2. intercept `window.Telegram` assignment so initData is re-applied.
 *
 * AuthProvider → resolveAuthInitData → POST /v1/auth/telegram (real HMAC path).
 * No production security bypass.
 */
export async function installTelegramWebAppInitData(
  page: Page,
  telegramUserId: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const initData = signedInitDataForTelegramUser(telegramUserId, overrides);
  await page.addInitScript((payload: string) => {
    const applyInitData = (root: { WebApp?: Record<string, unknown> } | undefined): void => {
      if (root === undefined) return;
      const webApp = (root.WebApp ?? {}) as Record<string, unknown>;
      webApp['ready'] = typeof webApp['ready'] === 'function' ? webApp['ready'] : () => undefined;
      webApp['expand'] =
        typeof webApp['expand'] === 'function' ? webApp['expand'] : () => undefined;
      webApp['close'] = typeof webApp['close'] === 'function' ? webApp['close'] : () => undefined;
      try {
        Object.defineProperty(webApp, 'initData', {
          configurable: true,
          enumerable: true,
          get: () => payload,
        });
      } catch {
        webApp['initData'] = payload;
      }
      root.WebApp = webApp;
    };

    let telegramBag: { WebApp?: Record<string, unknown> } = { WebApp: {} };
    applyInitData(telegramBag);

    Object.defineProperty(window, 'Telegram', {
      configurable: true,
      enumerable: true,
      get: () => telegramBag,
      set: (value: { WebApp?: Record<string, unknown> }) => {
        telegramBag = value ?? { WebApp: {} };
        applyInitData(telegramBag);
      },
    });
  }, initData);
}

/**
 * Authenticate via the real API (signed initData HMAC) and plant the session
 * in sessionStorage before first paint. AuthProvider prefers an existing session.
 */
export async function loginViaApiAndStoreSession(
  page: Page,
  apiBaseUrl: string,
  telegramUserId: string,
): Promise<void> {
  const initData = signedInitDataForTelegramUser(telegramUserId);
  const response = await page.request.post(`${apiBaseUrl.replace(/\/+$/, '')}/v1/auth/telegram`, {
    data: { initData },
  });
  if (!response.ok()) {
    throw new Error(`auth telegram failed: HTTP ${response.status()}`);
  }
  const body = (await response.json()) as {
    user: unknown;
    session: unknown;
  };
  await page.addInitScript((stored) => {
    window.sessionStorage.setItem('alex.rewards.auth.v1', JSON.stringify(stored));
  }, body);
}
