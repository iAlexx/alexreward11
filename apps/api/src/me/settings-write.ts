/**
 * User settings persistence for PATCH /v1/me/settings (Phase 12 remediation P12-03).
 *
 * Security notifications remain non-disableable (schema CHECK + never accepted as input).
 */

import {
  isLocaleCode,
  isPublicPayoutIdentityMode,
  type LocaleCode,
  type PublicPayoutIdentityMode,
  type UserSettingsResponse,
} from '@alex-rewards/contracts';
import type { Pool, PoolClient } from 'pg';

export class SettingsWriteError extends Error {
  readonly code: 'UNAUTHORIZED' | 'VALIDATION' | 'NOT_FOUND' | 'INTERNAL';

  constructor(code: SettingsWriteError['code'], message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SettingsWriteError';
    this.code = code;
  }
}

export interface UserSettingsPatch {
  readonly preferredLocale?: LocaleCode;
  readonly publicPayoutIdentityMode?: PublicPayoutIdentityMode;
}


/**
 * Phase17 privacy lock contract:
 * Future public-payout sender must SELECT payout_publications ... FOR UPDATE
 * before final identity recheck/build. This settings downgrade UPDATE locks the
 * same non-terminal rows, so concurrent send vs HIDE serialize deterministically:
 *   A) HIDE commits first => sender later observes HIDE_IDENTITY
 *   B) sender holds FOR UPDATE first => HIDE blocks until send durable outcome
 * A committed HIDE must never be ignored by a send that had not yet serialized.
 */
async function downgradeNonTerminalPayoutPublicationsToHide(
  client: PoolClient,
  userId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE payout_publications pp
     SET identity_mode = 'HIDE_IDENTITY'::public_payout_identity_mode,
         username_snapshot = NULL,
         updated_at = now()
     FROM withdrawals w
     WHERE pp.withdrawal_id = w.id
       AND w.user_id = $1::uuid
       AND pp.identity_mode = 'SHOW_USERNAME'::public_payout_identity_mode
       AND pp.status::text IN ('PENDING', 'FAILED')`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export async function patchUserSettings(
  pool: Pool,
  input: { readonly userId: string; readonly patch: UserSettingsPatch },
): Promise<UserSettingsResponse> {
  const userId = input.userId.trim();
  if (userId === '') {
    throw new SettingsWriteError('UNAUTHORIZED', 'Authentication required');
  }

  const preferredLocale = input.patch.preferredLocale;
  const publicPayoutIdentityMode = input.patch.publicPayoutIdentityMode;

  if (preferredLocale === undefined && publicPayoutIdentityMode === undefined) {
    throw new SettingsWriteError('VALIDATION', 'No settings fields to update');
  }
  if (preferredLocale !== undefined && !isLocaleCode(preferredLocale)) {
    throw new SettingsWriteError('VALIDATION', 'Invalid preferredLocale');
  }
  if (
    publicPayoutIdentityMode !== undefined &&
    !isPublicPayoutIdentityMode(publicPayoutIdentityMode)
  ) {
    throw new SettingsWriteError('VALIDATION', 'Invalid publicPayoutIdentityMode');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (preferredLocale !== undefined) {
      const updated = await client.query(
        `UPDATE users SET preferred_locale = $2 WHERE id = $1::uuid`,
        [userId, preferredLocale],
      );
      if (updated.rowCount === 0) {
        throw new SettingsWriteError('NOT_FOUND', 'User not found');
      }
    } else {
      const exists = await client.query(`SELECT 1 FROM users WHERE id = $1::uuid`, [userId]);
      if (exists.rowCount === 0) {
        throw new SettingsWriteError('NOT_FOUND', 'User not found');
      }
    }

    if (preferredLocale !== undefined && publicPayoutIdentityMode !== undefined) {
      await client.query(
        `INSERT INTO user_settings (user_id, locale, public_payout_identity_mode)
         VALUES ($1::uuid, $2, $3::public_payout_identity_mode)
         ON CONFLICT (user_id) DO UPDATE SET
           locale = EXCLUDED.locale,
           public_payout_identity_mode = EXCLUDED.public_payout_identity_mode,
           updated_at = now()`,
        [userId, preferredLocale, publicPayoutIdentityMode],
      );
    } else if (preferredLocale !== undefined) {
      await client.query(
        `INSERT INTO user_settings (user_id, locale)
         VALUES ($1::uuid, $2)
         ON CONFLICT (user_id) DO UPDATE SET
           locale = EXCLUDED.locale,
           updated_at = now()`,
        [userId, preferredLocale],
      );
    } else if (publicPayoutIdentityMode !== undefined) {
      await client.query(
        `INSERT INTO user_settings (user_id, public_payout_identity_mode)
         VALUES ($1::uuid, $2::public_payout_identity_mode)
         ON CONFLICT (user_id) DO UPDATE SET
           public_payout_identity_mode = EXCLUDED.public_payout_identity_mode,
           updated_at = now()`,
        [userId, publicPayoutIdentityMode],
      );
    }

    if (publicPayoutIdentityMode === 'HIDE_IDENTITY') {
      await downgradeNonTerminalPayoutPublicationsToHide(client, userId);
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof SettingsWriteError) throw error;
    throw new SettingsWriteError('INTERNAL', 'Failed to update settings', { cause: error });
  } finally {
    client.release();
  }

  return readUserSettings(pool, userId);
}

export async function readUserSettings(pool: Pool, userId: string): Promise<UserSettingsResponse> {
  const result = await pool.query<{
    locale: LocaleCode;
    public_payout_identity_mode: PublicPayoutIdentityMode;
    marketing_notifications_enabled: boolean;
  }>(
    `SELECT COALESCE(s.locale, u.preferred_locale) AS locale,
            COALESCE(s.public_payout_identity_mode::text, 'HIDE_IDENTITY')
              AS public_payout_identity_mode,
            COALESCE(s.marketing_notifications_enabled, true)
              AS marketing_notifications_enabled
     FROM users u
     LEFT JOIN user_settings s ON s.user_id = u.id
     WHERE u.id = $1::uuid`,
    [userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SettingsWriteError('NOT_FOUND', 'User not found');
  }
  return {
    preferredLocale: row.locale,
    publicPayoutIdentityMode: row.public_payout_identity_mode,
    marketingNotificationsEnabled: row.marketing_notifications_enabled,
    securityNotificationsEnabled: true,
  };
}
