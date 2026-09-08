import type { Pool } from 'pg';
import {
  InitDataValidationError,
  validateTelegramInitData,
  type ValidatedTelegramUser,
} from '@alex-rewards/telegram';

import { AuthDomainError } from './errors.js';
import {
  createUserSession,
  type RequestMeta,
  type SessionConfig,
  type SessionTokens,
} from './sessions.js';

export type PreferredLocale = 'en' | 'ar' | 'ru';

export interface AuthenticatedUser {
  readonly id: string;
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly preferredLocale: PreferredLocale;
  readonly status: string;
  readonly withdrawalStatus: string;
  readonly created: boolean;
}

export interface TelegramLoginResult {
  readonly user: AuthenticatedUser;
  readonly session: SessionTokens;
  readonly telegram: ValidatedTelegramUser;
}

function mapLocale(languageCode: string | null): PreferredLocale {
  if (languageCode === null) return 'en';
  const base = languageCode.toLowerCase().slice(0, 2);
  if (base === 'ar' || base === 'ru' || base === 'en') return base;
  return 'en';
}

/**
 * Race-safe Telegram login. Concurrent first logins for the same telegram_user_id
 * resolve to one users row via UNIQUE(telegram_user_id) + ON CONFLICT DO UPDATE.
 * Security/account fields and user-chosen preferred_locale are never overwritten.
 */
export async function authenticateWithTelegramInitData(
  pool: Pool,
  input: {
    readonly rawInitData: string;
    readonly botToken: string;
    readonly maxAgeSeconds: number;
    readonly session: SessionConfig;
    readonly meta?: RequestMeta;
    readonly nowUnixSeconds?: number;
  },
): Promise<TelegramLoginResult> {
  let validated: ValidatedTelegramUser;
  try {
    validated = validateTelegramInitData(input.rawInitData, {
      botToken: input.botToken,
      maxAgeSeconds: input.maxAgeSeconds,
      ...(input.nowUnixSeconds === undefined ? {} : { nowUnixSeconds: input.nowUnixSeconds }),
    });
  } catch (error) {
    if (error instanceof InitDataValidationError) {
      throw new AuthDomainError('VALIDATION', 'Telegram authentication failed', {
        cause: error,
        details: { reason: error.code },
      });
    }
    throw error;
  }

  const preferredLocale = mapLocale(validated.languageCode);
  const upsert = await pool.query<{
    id: string;
    telegram_user_id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    preferred_locale: PreferredLocale;
    status: string;
    withdrawal_status: string;
    was_inserted: boolean;
  }>(
    `INSERT INTO users (
       telegram_user_id, username, first_name, last_name, telegram_language_code,
       preferred_locale, last_active_at
     ) VALUES ($1::bigint, $2, $3, $4, $5, $6, now())
     ON CONFLICT (telegram_user_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       telegram_language_code = EXCLUDED.telegram_language_code,
       last_active_at = now()
     RETURNING
       id,
       telegram_user_id::text AS telegram_user_id,
       username,
       first_name,
       last_name,
       preferred_locale,
       status,
       withdrawal_status,
       (xmax = 0) AS was_inserted`,
    [
      validated.telegramUserId,
      validated.username,
      validated.firstName,
      validated.lastName,
      validated.languageCode,
      preferredLocale,
    ],
  );

  const row = upsert.rows[0];
  if (row === undefined) throw new AuthDomainError('INTERNAL', 'Failed to create user');
  const created = row.was_inserted === true;

  await pool.query(
    `INSERT INTO user_profiles (user_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name)`,
    [row.id, validated.firstName ?? validated.username ?? null],
  );
  // Locale settings are created once; never overwrite a user-chosen locale on re-login.
  await pool.query(
    `INSERT INTO user_settings (user_id, locale)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING`,
    [row.id, preferredLocale],
  );

  const user: AuthenticatedUser = {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    preferredLocale: row.preferred_locale,
    status: row.status,
    withdrawalStatus: row.withdrawal_status,
    created,
  };

  const session = await createUserSession(pool, input.session, user.id, input.meta ?? {});
  return { user, session, telegram: validated };
}
