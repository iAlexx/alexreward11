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
  const existing = await pool.query<{
    id: string;
    telegram_user_id: string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    preferred_locale: PreferredLocale;
    status: string;
    withdrawal_status: string;
  }>(
    `SELECT id, telegram_user_id::text AS telegram_user_id, username, first_name, last_name,
            preferred_locale, status, withdrawal_status
     FROM users
     WHERE telegram_user_id = $1::bigint`,
    [validated.telegramUserId],
  );

  let user: AuthenticatedUser;
  let created = false;

  if (existing.rows[0] === undefined) {
    const inserted = await pool.query<{
      id: string;
      telegram_user_id: string;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
      preferred_locale: PreferredLocale;
      status: string;
      withdrawal_status: string;
    }>(
      `INSERT INTO users (
         telegram_user_id, username, first_name, last_name, telegram_language_code,
         preferred_locale, last_active_at
       ) VALUES ($1::bigint, $2, $3, $4, $5, $6, now())
       RETURNING id, telegram_user_id::text AS telegram_user_id, username, first_name, last_name,
                 preferred_locale, status, withdrawal_status`,
      [
        validated.telegramUserId,
        validated.username,
        validated.firstName,
        validated.lastName,
        validated.languageCode,
        preferredLocale,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new AuthDomainError('INTERNAL', 'Failed to create user');
    await pool.query(
      `INSERT INTO user_profiles (user_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [row.id, validated.firstName ?? validated.username ?? null],
    );
    await pool.query(
      `INSERT INTO user_settings (user_id, locale)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [row.id, preferredLocale],
    );
    created = true;
    user = {
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
  } else {
    const current = existing.rows[0];
    // Profile metadata may update; identity key and security/account state must not.
    const updated = await pool.query<{
      id: string;
      telegram_user_id: string;
      username: string | null;
      first_name: string | null;
      last_name: string | null;
      preferred_locale: PreferredLocale;
      status: string;
      withdrawal_status: string;
    }>(
      `UPDATE users
       SET username = $2,
           first_name = $3,
           last_name = $4,
           telegram_language_code = $5,
           last_active_at = now()
       WHERE id = $1
       RETURNING id, telegram_user_id::text AS telegram_user_id, username, first_name, last_name,
                 preferred_locale, status, withdrawal_status`,
      [
        current.id,
        validated.username,
        validated.firstName,
        validated.lastName,
        validated.languageCode,
      ],
    );
    const row = updated.rows[0] ?? current;
    await pool.query(
      `INSERT INTO user_profiles (user_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE
         SET display_name = COALESCE(EXCLUDED.display_name, user_profiles.display_name)`,
      [row.id, validated.firstName ?? validated.username ?? null],
    );
    user = {
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
  }

  const session = await createUserSession(pool, input.session, user.id, input.meta ?? {});
  return { user, session, telegram: validated };
}
