import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildSignedInitDataForTests,
  InitDataValidationError,
  validateTelegramInitData,
} from '../src/index.js';

const BOT = '123456:ABC-DEF_local-only-telegram-bot-token';

function signedUser(
  overrides: Record<string, unknown> = {},
  authDate = Math.floor(Date.now() / 1000),
) {
  const user = {
    id: 4242424242,
    first_name: 'Alex',
    username: 'alex_founder',
    language_code: 'en',
    ...overrides,
  };
  return buildSignedInitDataForTests(BOT, {
    user: JSON.stringify(user),
    auth_date: String(authDate),
    query_id: 'AAEAAAE',
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.fail('expected validation error');
  } catch (error) {
    expect(error).toBeInstanceOf(InitDataValidationError);
    expect((error as InitDataValidationError).code).toBe(code);
  }
}

describe('validateTelegramInitData', () => {
  it('accepts valid signed initData and returns string-safe Telegram id', () => {
    const result = validateTelegramInitData(signedUser(), {
      botToken: BOT,
      maxAgeSeconds: 86_400,
    });
    expect(result.telegramUserId).toBe('4242424242');
    expect(typeof result.telegramUserId).toBe('string');
    expect(result.username).toBe('alex_founder');
  });

  it('rejects an invalid signature', () => {
    const raw = `${signedUser().split('&hash=')[0]}&hash=${'ab'.repeat(32)}`;
    expectCode(
      () => validateTelegramInitData(raw, { botToken: BOT, maxAgeSeconds: 86_400 }),
      'INVALID_SIGNATURE',
    );
  });

  it('rejects a changed Telegram user field after signing', () => {
    const valid = signedUser();
    const hash = valid.split('&hash=')[1] ?? '';
    const tamperedBody = buildSignedInitDataForTests(BOT, {
      user: JSON.stringify({
        id: 9999999999,
        first_name: 'Alex',
        username: 'alex_founder',
        language_code: 'en',
      }),
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'AAEAAAE',
    }).split('&hash=')[0];
    expectCode(
      () =>
        validateTelegramInitData(`${tamperedBody}&hash=${hash}`, {
          botToken: BOT,
          maxAgeSeconds: 86_400,
        }),
      'INVALID_SIGNATURE',
    );
  });

  it('rejects a changed arbitrary signed field', () => {
    const valid = signedUser();
    const hash = valid.split('&hash=')[1] ?? '';
    const tamperedBody = buildSignedInitDataForTests(BOT, {
      user: JSON.stringify({
        id: 4242424242,
        first_name: 'Alex',
        username: 'alex_founder',
        language_code: 'en',
      }),
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'CHANGED',
    }).split('&hash=')[0];
    expectCode(
      () =>
        validateTelegramInitData(`${tamperedBody}&hash=${hash}`, {
          botToken: BOT,
          maxAgeSeconds: 86_400,
        }),
      'INVALID_SIGNATURE',
    );
  });

  it('rejects stale auth_date', () => {
    const stale = Math.floor(Date.now() / 1000) - 100_000;
    expectCode(
      () =>
        validateTelegramInitData(signedUser({}, stale), {
          botToken: BOT,
          maxAgeSeconds: 3600,
        }),
      'STALE_AUTH_DATE',
    );
  });

  it('rejects malformed initData', () => {
    expectCode(
      () => validateTelegramInitData('not-valid', { botToken: BOT, maxAgeSeconds: 86_400 }),
      'MALFORMED',
    );
  });

  it('rejects missing required fields', () => {
    const secretKey = createHmac('sha256', 'WebAppData').update(BOT).digest();
    const dataCheckString = 'auth_date=1700000000';
    const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    expectCode(
      () =>
        validateTelegramInitData(`auth_date=1700000000&hash=${hash}`, {
          botToken: BOT,
          maxAgeSeconds: 86_400,
          nowUnixSeconds: 1_700_000_000,
        }),
      'MISSING_USER',
    );
  });

  it('never treats initDataUnsafe as an input API', () => {
    expect(typeof validateTelegramInitData).toBe('function');
    expect('validateInitDataUnsafe' in globalThis).toBe(false);
  });
});
