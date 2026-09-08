import { createHmac, timingSafeEqual } from 'node:crypto';

import { InitDataValidationError } from './errors.js';

export interface ValidatedTelegramUser {
  /** Decimal string of Telegram numeric user id. Never a JS Number. */
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly languageCode: string | null;
  readonly isPremium: boolean | null;
  readonly authDate: Date;
  readonly authDateUnix: number;
}

export interface ValidateInitDataOptions {
  readonly botToken: string;
  /** Maximum age of auth_date in seconds. */
  readonly maxAgeSeconds: number;
  /** Clock override for tests (unix seconds). */
  readonly nowUnixSeconds?: number;
}

function parseQueryPairs(raw: string): Map<string, string> {
  const pairs = new Map<string, string>();
  if (raw.trim() === '') {
    throw new InitDataValidationError('MALFORMED', 'initData is empty');
  }
  for (const part of raw.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq <= 0) {
      throw new InitDataValidationError('MALFORMED', 'initData contains a malformed pair');
    }
    const key = decodeURIComponent(part.slice(0, eq));
    const value = decodeURIComponent(part.slice(eq + 1).replaceAll('+', ' '));
    if (pairs.has(key)) {
      throw new InitDataValidationError('MALFORMED', `initData duplicates key ${key}`);
    }
    pairs.set(key, value);
  }
  return pairs;
}

function safeEqualHex(expectedHex: string, actualHex: string): boolean {
  try {
    const expected = Buffer.from(expectedHex, 'hex');
    const actual = Buffer.from(actualHex, 'hex');
    if (expected.length === 0 || expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function assertSafeTelegramUserId(raw: unknown): string {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new InitDataValidationError('INVALID_USER', 'Telegram user id is missing');
  }
  const asString =
    typeof raw === 'number'
      ? Number.isSafeInteger(raw)
        ? String(raw)
        : (() => {
            throw new InitDataValidationError(
              'UNSAFE_TELEGRAM_ID',
              'Telegram user id exceeds safe integer range for Number',
            );
          })()
      : raw.trim();
  if (!/^[1-9][0-9]{0,18}$/.test(asString)) {
    throw new InitDataValidationError('INVALID_USER', 'Telegram user id is not a positive integer');
  }
  // BIGINT signed max is 9223372036854775807
  if (asString.length === 19 && asString > '9223372036854775807') {
    throw new InitDataValidationError(
      'UNSAFE_TELEGRAM_ID',
      'Telegram user id exceeds BIGINT range',
    );
  }
  return asString;
}

/**
 * Validates Telegram Mini App `initData` using the official WebApp HMAC procedure.
 * Never accepts or reads `initDataUnsafe`.
 */
export function validateTelegramInitData(
  rawInitData: string,
  options: ValidateInitDataOptions,
): ValidatedTelegramUser {
  if (typeof rawInitData !== 'string') {
    throw new InitDataValidationError('MALFORMED', 'initData must be a string');
  }
  if (options.botToken.trim() === '') {
    throw new InitDataValidationError('INVALID_SIGNATURE', 'bot token is required');
  }

  const pairs = parseQueryPairs(rawInitData);
  const hash = pairs.get('hash');
  if (hash === undefined || hash === '') {
    throw new InitDataValidationError('MISSING_HASH', 'initData hash is required');
  }
  pairs.delete('hash');

  const authDateRaw = pairs.get('auth_date');
  if (authDateRaw === undefined || authDateRaw === '') {
    throw new InitDataValidationError('MISSING_AUTH_DATE', 'initData auth_date is required');
  }
  if (!/^[0-9]+$/.test(authDateRaw)) {
    throw new InitDataValidationError('MALFORMED', 'initData auth_date is not an integer');
  }
  const authDateUnix = Number(authDateRaw);
  if (!Number.isSafeInteger(authDateUnix) || authDateUnix <= 0) {
    throw new InitDataValidationError('MALFORMED', 'initData auth_date is invalid');
  }

  const now = options.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (authDateUnix > now + 60) {
    throw new InitDataValidationError('STALE_AUTH_DATE', 'initData auth_date is in the future');
  }
  if (now - authDateUnix > options.maxAgeSeconds) {
    throw new InitDataValidationError('STALE_AUTH_DATE', 'initData auth_date is stale');
  }

  const dataCheckString = [...pairs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = createHmac('sha256', 'WebAppData').update(options.botToken).digest();
  const calculatedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (!safeEqualHex(calculatedHash, hash)) {
    throw new InitDataValidationError('INVALID_SIGNATURE', 'initData signature is invalid');
  }

  const userRaw = pairs.get('user');
  if (userRaw === undefined || userRaw === '') {
    throw new InitDataValidationError('MISSING_USER', 'initData user is required');
  }

  let userJson: unknown;
  try {
    userJson = JSON.parse(userRaw) as unknown;
  } catch {
    throw new InitDataValidationError('INVALID_USER', 'initData user is not valid JSON');
  }
  if (userJson === null || typeof userJson !== 'object' || Array.isArray(userJson)) {
    throw new InitDataValidationError('INVALID_USER', 'initData user must be an object');
  }

  const user = userJson as Record<string, unknown>;
  const telegramUserId = assertSafeTelegramUserId(user.id);

  return {
    telegramUserId,
    username: typeof user.username === 'string' ? user.username : null,
    firstName: typeof user.first_name === 'string' ? user.first_name : null,
    lastName: typeof user.last_name === 'string' ? user.last_name : null,
    languageCode: typeof user.language_code === 'string' ? user.language_code : null,
    isPremium: typeof user.is_premium === 'boolean' ? user.is_premium : null,
    authDate: new Date(authDateUnix * 1000),
    authDateUnix,
  };
}

/** Test helper: build a signed initData string for a known bot token. */
export function buildSignedInitDataForTests(
  botToken: string,
  fields: Record<string, string>,
): string {
  const pairs = new Map(Object.entries(fields));
  const dataCheckString = [...pairs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const encoded = [...pairs.entries()]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${encoded}&hash=${hash}`;
}
