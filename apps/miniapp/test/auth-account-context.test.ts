/**
 * Telegram account-context boot decision - pure helpers only.
 * Untrusted user-id hints must never become authenticated identity or referral authority.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decideAuthBoot } from '../src/lib/auth/boot-decision';
import type { StoredAuth } from '../src/lib/auth/session-store';
import { readTelegramUserIdHint } from '../src/lib/auth/telegram-user-id-hint';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));

function storedAuth(telegramUserId: string): StoredAuth {
  return {
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      telegramUserId,
      username: 'alice',
      firstName: 'Alice',
      lastName: null,
      preferredLocale: 'en',
      status: 'ACTIVE',
      withdrawalStatus: 'ALLOWED',
      created: false,
    },
    session: {
      accessToken: 'access-a',
      accessExpiresAt: '2099-01-01T00:00:00.000Z',
      refreshToken: 'refresh-a',
      refreshExpiresAt: '2099-01-01T00:00:00.000Z',
      sessionId: '22222222-2222-4222-8222-222222222222',
    },
  };
}

function initDataWithUser(userJson: string): string {
  const params = new URLSearchParams();
  params.set('user', userJson);
  params.set('auth_date', '1700000000');
  params.set('hash', 'deadbeef');
  return params.toString();
}

describe('readTelegramUserIdHint', () => {
  it('extracts a numeric Telegram id as a decimal string hint', () => {
    expect(readTelegramUserIdHint(initDataWithUser('{"id":15300001,"first_name":"B"}'))).toBe(
      '15300001',
    );
    expect(readTelegramUserIdHint(initDataWithUser('{"id":"15300001"}'))).toBe('15300001');
  });

  it('returns null for missing/malformed user fields', () => {
    expect(readTelegramUserIdHint('')).toBeNull();
    expect(readTelegramUserIdHint('auth_date=1&hash=x')).toBeNull();
    expect(readTelegramUserIdHint(initDataWithUser('not-json'))).toBeNull();
    expect(readTelegramUserIdHint(initDataWithUser('{"id":0}'))).toBeNull();
    expect(readTelegramUserIdHint(initDataWithUser('{"id":-5}'))).toBeNull();
    expect(readTelegramUserIdHint(initDataWithUser('{"id":1.5}'))).toBeNull();
    expect(readTelegramUserIdHint(initDataWithUser('{"id":"0"}'))).toBeNull();
    expect(readTelegramUserIdHint(initDataWithUser('{"id":"abc"}'))).toBeNull();
    expect(readTelegramUserIdHint(initDataWithUser('{"first_name":"B"}'))).toBeNull();
  });

  it('never elevates a forged hint into authenticated identity by itself', () => {
    const forged = readTelegramUserIdHint(initDataWithUser('{"id":99999999}'));
    expect(forged).toBe('99999999');
    expect(typeof forged).toBe('string');
    expect(forged).not.toMatch(/accessToken|sessionId|Authorization/);
  });
});

describe('decideAuthBoot', () => {
  it('no stored auth + valid initData performs Telegram auth', () => {
    const initData = initDataWithUser('{"id":15300002}');
    expect(decideAuthBoot({ stored: null, initData })).toEqual({
      kind: 'AUTHENTICATE_TELEGRAM',
      initData,
      clearStoredFirst: false,
    });
  });

  it('matching stored telegramUserId + current hint reuses stored session', () => {
    const initData = initDataWithUser('{"id":15300003}');
    const stored = storedAuth('15300003');
    expect(decideAuthBoot({ stored, initData })).toEqual({
      kind: 'REUSE_STORED',
      stored,
    });
  });

  it('mismatched Telegram account context clears stored and authenticates CURRENT initData', () => {
    const initData = initDataWithUser('{"id":15300004}');
    const stored = storedAuth('15300003');
    expect(decideAuthBoot({ stored, initData })).toEqual({
      kind: 'AUTHENTICATE_TELEGRAM',
      initData,
      clearStoredFirst: true,
    });
  });

  it('present initData with unparseable user fails safe into reauthentication', () => {
    const initData = initDataWithUser('{"first_name":"NoId"}');
    const stored = storedAuth('15300003');
    expect(decideAuthBoot({ stored, initData })).toEqual({
      kind: 'AUTHENTICATE_TELEGRAM',
      initData,
      clearStoredFirst: true,
    });
  });

  it('no initData + stored session preserves non-Telegram session behavior', () => {
    const stored = storedAuth('15300003');
    expect(decideAuthBoot({ stored, initData: null })).toEqual({
      kind: 'REUSE_STORED',
      stored,
    });
  });

  it('no initData + no stored auth is UNAUTHORIZED', () => {
    expect(decideAuthBoot({ stored: null, initData: null })).toEqual({
      kind: 'UNAUTHORIZED',
    });
  });

  it('forged hint cannot invent an authenticated user object', () => {
    const forgedInit = initDataWithUser('{"id":42424242}');
    const decision = decideAuthBoot({ stored: null, initData: forgedInit });
    expect(decision.kind).toBe('AUTHENTICATE_TELEGRAM');
    if (decision.kind !== 'AUTHENTICATE_TELEGRAM') throw new Error('expected AUTHENTICATE_TELEGRAM');
    expect(decision).not.toHaveProperty('user');
    expect(decision).not.toHaveProperty('session');
    expect(decision.initData).toBe(forgedInit);
  });
});

describe('AuthProvider account-context wiring', () => {
  it('resolves initData before reusing stored auth and forces clear+authTelegram on mismatch', async () => {
    const auth = await readFile(join(srcRoot, 'providers/AuthProvider.tsx'), 'utf8');
    expect(auth).toMatch(/resolveAuthInitData\(\)/);
    expect(auth).toMatch(/decideAuthBoot/);
    expect(auth).toMatch(/clearStoredFirst/);
    expect(auth).toMatch(/authTelegram\(decision\.initData\)/);
    const bootBody = auth.slice(auth.indexOf('async function boot'));
    const initIdx = bootBody.indexOf('resolveAuthInitData()');
    const loadIdx = bootBody.indexOf('loadStoredAuth()');
    const decideIdx = bootBody.indexOf('decideAuthBoot(');
    expect(initIdx).toBeGreaterThan(-1);
    expect(loadIdx).toBeGreaterThan(initIdx);
    expect(decideIdx).toBeGreaterThan(loadIdx);
    expect(auth).not.toMatch(/start_param|startParam|tgWebAppStartParam|attributeReferral|ref_/);
  });

  it('keeps referral start_param out of the untrusted hint helper', async () => {
    const hint = await readFile(join(srcRoot, 'lib/auth/telegram-user-id-hint.ts'), 'utf8');
    const boot = await readFile(join(srcRoot, 'lib/auth/boot-decision.ts'), 'utf8');
    expect(hint).not.toMatch(/start_param|startParam|attributeReferral|referral_edges|referralDeepLink/);
    expect(boot).not.toMatch(/start_param|startParam|attributeReferral|referralDeepLink/);
    expect(hint).toMatch(/UNTRUSTED/);
  });
});

