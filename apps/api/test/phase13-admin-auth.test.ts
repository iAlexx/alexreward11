import { describe, expect, it } from 'vitest';

import { looksLikeTelegramUserAccessToken } from '@alex-rewards/auth';

import {
  assertAdminCookieCsrf,
  extractAdminSessionToken,
} from '../src/admin-auth/admin-session.guard.js';

describe('Phase 13 AdminSession isolation', () => {
  it('Telegram user access JWT shape is detected and must not pass as admin opaque token', () => {
    expect(looksLikeTelegramUserAccessToken('aaa.bbb.ccc')).toBe(true);
    expect(looksLikeTelegramUserAccessToken('opaque-admin-token')).toBe(false);
  });

  it('extractAdminSessionToken prefers Bearer over cookie', () => {
    const bearer = extractAdminSessionToken({
      headers: {
        authorization: 'Bearer admin-opaque-token',
        cookie: 'admin_session=from-cookie',
      },
    } as never);
    expect(bearer).toEqual({ token: 'admin-opaque-token', source: 'bearer' });

    const cookieOnly = extractAdminSessionToken({
      headers: { cookie: 'admin_session=from-cookie' },
    } as never);
    expect(cookieOnly).toEqual({ token: 'from-cookie', source: 'cookie' });
  });

  it('cookie CSRF requires matching Origin; Bearer mode skips', () => {
    expect(() =>
      assertAdminCookieCsrf(
        { headers: { origin: 'https://evil.example' } } as never,
        ['https://admin.example.com'],
        true,
      ),
    ).toThrow();
    expect(() =>
      assertAdminCookieCsrf(
        { headers: { origin: 'https://admin.example.com' } } as never,
        ['https://admin.example.com'],
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertAdminCookieCsrf({ headers: {} } as never, ['https://admin.example.com'], false),
    ).not.toThrow();
  });
});
