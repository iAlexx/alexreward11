import type { Pool, PoolClient } from 'pg';

import type { ControlCenterRuntimeConfig } from './config.js';
import { ControlCenterError } from './errors.js';
import type { AuthorizeOwnerActionInput, AuthorizedOwnerContext } from './types.js';

type Db = Pool | PoolClient;

/**
 * Fail-closed Owner authorization for Control Center actions.
 * Group membership alone grants nothing — allowlist + ACTIVE admin + OWNER binding
 * + named permission are all required.
 */
export async function authorizeOwnerAction(
  db: Db,
  config: ControlCenterRuntimeConfig,
  input: AuthorizeOwnerActionInput,
): Promise<AuthorizedOwnerContext> {
  const telegramUserId = input.telegramUserId.trim();
  if (telegramUserId === '' || !/^\d+$/.test(telegramUserId)) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'INVALID_TELEGRAM_USER_ID' },
    });
  }

  if (!config.ownerTelegramUserIds.has(telegramUserId)) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'NOT_ON_ALLOWLIST' },
    });
  }

  const admin = await db.query<{ id: string; status: string; telegram_user_id: string }>(
    `SELECT id, status, telegram_user_id::text AS telegram_user_id
     FROM admin_users
     WHERE telegram_user_id = $1::bigint
     LIMIT 1`,
    [telegramUserId],
  );
  const adminRow = admin.rows[0];
  if (adminRow === undefined || adminRow.status !== 'ACTIVE') {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'ADMIN_NOT_ACTIVE' },
    });
  }
  if (adminRow.telegram_user_id !== telegramUserId) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'TELEGRAM_USER_MISMATCH' },
    });
  }

  const binding = await db.query<{ role_code: string; revoked_at: Date | null }>(
    `SELECT r.code AS role_code, b.revoked_at
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE b.admin_user_id = $1::uuid
       AND r.code = 'OWNER'
       AND r.status = 'ACTIVE'
       AND b.revoked_at IS NULL
     LIMIT 1`,
    [adminRow.id],
  );
  if (binding.rows[0] === undefined) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'OWNER_BINDING_MISSING' },
    });
  }

  const permission = await db.query<{ code: string }>(
    `SELECT p.code
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     INNER JOIN admin_role_permissions rp ON rp.role_id = r.id
     INNER JOIN admin_permissions p ON p.id = rp.permission_id
     WHERE b.admin_user_id = $1::uuid
       AND b.revoked_at IS NULL
       AND r.code = 'OWNER'
       AND r.status = 'ACTIVE'
       AND p.code = $2
     LIMIT 1`,
    [adminRow.id, input.permissionCode],
  );
  if (permission.rows[0] === undefined) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'PERMISSION_DENIED', permission: input.permissionCode },
    });
  }

  // Destination environment/enabled checks happen at token issue/consume with destination binding.
  // Chat/topic presence is still required for Telegram-originated actions.
  if (input.chatId.trim() === '' || !/^-?\d+$/.test(input.chatId.trim())) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'INVALID_CHAT_ID' },
    });
  }
  if (
    input.topicThreadId !== null &&
    (input.topicThreadId.trim() === '' || !/^-?\d+$/.test(input.topicThreadId.trim()))
  ) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'INVALID_TOPIC_THREAD_ID' },
    });
  }

  void input.environment;

  return {
    adminUserId: adminRow.id,
    telegramUserId,
    permissionCode: input.permissionCode,
  };
}
