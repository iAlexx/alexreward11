/**
 * Phase 10 isolated Testnet first-Owner bootstrap (practical V1.3 path).
 *
 * Trust model (isolated only):
 *   1. Explicitly configured Owner Telegram user id
 *   2. Cryptographically verified Telegram Mini App initData (bot token HMAC)
 *   3. Password + TOTP (existing Owner admin factors)
 *
 * Telegram username is display-only and never authorizes.
 * No Option C ceremony, witnesses, paper Channel B, or Ed25519 grant PoP.
 *
 * Hard target: alex_rewards_isolated_payout_test @ 127.0.0.1:55440.
 * Operational alex_rewards / port 55432 / production env always refused.
 */
import { createHash } from 'node:crypto';

import {
  assertConnectedDestructiveTestDatabase,
  isApprovedDestructiveTestDatabaseName,
} from '@alex-rewards/db';
import { validateTelegramInitData } from '@alex-rewards/telegram';
import type { Pool, PoolClient } from 'pg';

import {
  assertPasswordPolicy,
  generateTotpSecretBytes,
  hashAdminPassword,
  sealTotpSecret,
} from '../admin-password.js';
import {
  assertTotpCodeFormat,
  generateTotpCode,
  verifyTotpCode,
} from '../admin-totp.js';
import {
  assertOwnerAuthOperationalDefaultDeny,
  withPoolOwnedOwnerAuthTransaction,
} from '../admin-auth.js';
import { AuthDomainError } from '../errors.js';

export const ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET = {
  databaseName: 'alex_rewards_isolated_payout_test',
  host: '127.0.0.1',
  port: 55440,
  trustClass: 'isolated_telegram_owner_bootstrap_v1',
} as const;

const TELEGRAM_ID_RE = /^[1-9][0-9]{0,18}$/;

export interface IsolatedTelegramOwnerBootstrapUrlFacts {
  readonly host: string;
  readonly port: number;
  readonly database: string;
}

export function parseIsolatedOwnerBootstrapUrl(
  connectionString: string,
): IsolatedTelegramOwnerBootstrapUrlFacts {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new AuthDomainError('VALIDATION', 'DATABASE_URL parse failed');
  }
  if (!/^postgres(ql)?:$/i.test(url.protocol)) {
    throw new AuthDomainError('FORBIDDEN', 'isolated Owner bootstrap requires postgresql URL');
  }
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated Owner bootstrap requires numeric loopback host 127.0.0.1',
    );
  }
  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port === 55432) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated Owner bootstrap refuses operational port 55432 / invalid port',
    );
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] ?? '');
  if (database === '' || database === 'alex_rewards') {
    throw new AuthDomainError('FORBIDDEN', 'isolated Owner bootstrap refuses alex_rewards');
  }
  if (!isApprovedDestructiveTestDatabaseName(database)) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated Owner bootstrap requires approved *_test / *_phaseN database name',
    );
  }
  return {
    host: host === '::1' ? '127.0.0.1' : host,
    port,
    database,
  };
}

/**
 * Live target gate. Production path requires the exact isolated payout DB.
 * Disposable suites may opt in via ALEX_ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TEST_HOOKS=1.
 */
export function assertIsolatedTelegramOwnerBootstrapTarget(
  facts: IsolatedTelegramOwnerBootstrapUrlFacts,
  expectedDatabase: string,
): void {
  if (expectedDatabase.trim() === '' || expectedDatabase === 'alex_rewards') {
    throw new AuthDomainError('FORBIDDEN', 'expectedDatabase refuses operational alex_rewards');
  }
  if (facts.database !== expectedDatabase) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'cross-DB rejection: URL database does not match expectedDatabase',
    );
  }
  assertOwnerAuthOperationalDefaultDeny(facts.database);

  const deploymentEnv = (process.env.DEPLOYMENT_ENV ?? '').trim().toLowerCase();
  if (deploymentEnv === 'production' || deploymentEnv === 'prod') {
    throw new AuthDomainError(
      'FORBIDDEN',
      'isolated Owner bootstrap refuses DEPLOYMENT_ENV=production',
    );
  }

  const isCanonical =
    facts.database === ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.databaseName &&
    facts.host === ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.host &&
    facts.port === ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.port;

  if (isCanonical) return;

  if (process.env.ALEX_ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TEST_HOOKS === '1') {
    // Disposable *_test on loopback only — never 55432 / alex_rewards.
    return;
  }

  throw new AuthDomainError(
    'FORBIDDEN',
    `isolated Owner bootstrap restricted to ${ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.databaseName}@${ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.host}:${ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.port}`,
  );
}

export function assertConfiguredOwnerTelegramUserId(raw: string): string {
  const id = raw.trim();
  if (!TELEGRAM_ID_RE.test(id)) {
    throw new AuthDomainError(
      'VALIDATION',
      'configured Owner Telegram user id must be a positive decimal string',
    );
  }
  if (id.length === 19 && id > '9223372036854775807') {
    throw new AuthDomainError('VALIDATION', 'configured Owner Telegram user id exceeds BIGINT');
  }
  return id;
}

export function verifyOwnerTelegramIdentityForBootstrap(input: {
  readonly rawInitData: string;
  readonly botToken: string;
  readonly configuredOwnerTelegramUserId: string;
  readonly maxAgeSeconds?: number;
  readonly nowUnixSeconds?: number;
}): {
  readonly telegramUserId: string;
  readonly displayUsername: string | null;
  readonly displayName: string;
  readonly authDateUnix: number;
} {
  const configured = assertConfiguredOwnerTelegramUserId(input.configuredOwnerTelegramUserId);
  let validated;
  try {
    validated = validateTelegramInitData(input.rawInitData, {
      botToken: input.botToken,
      maxAgeSeconds: input.maxAgeSeconds ?? 600,
      ...(input.nowUnixSeconds !== undefined ? { nowUnixSeconds: input.nowUnixSeconds } : {}),
    });
  } catch (err) {
    throw new AuthDomainError(
      'UNAUTHENTICATED',
      'Telegram initData verification failed',
      { cause: err },
    );
  }

  if (validated.telegramUserId !== configured) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'verified Telegram user id does not match configured Owner Telegram id',
    );
  }

  // Username is never compared for authorization — display only.
  const displayName =
    [validated.firstName, validated.lastName].filter((p) => p && p.trim() !== '').join(' ').trim() ||
    'Owner';

  return {
    telegramUserId: validated.telegramUserId,
    displayUsername: validated.username,
    displayName,
    authDateUnix: validated.authDateUnix,
  };
}

async function assertM0SeatVacant(client: PoolClient): Promise<void> {
  const seat = await client.query<{ holder_admin_user_id: string | null }>(
    `SELECT holder_admin_user_id::text FROM admin_owner_authority WHERE seat = 1 FOR UPDATE`,
  );
  if ((seat.rows[0]?.holder_admin_user_id ?? null) !== null) {
    throw new AuthDomainError('FORBIDDEN', 'OWNER seat already held — refuse bootstrap');
  }
  const history = await client.query<{ c: number }>(
    `SELECT count(DISTINCT b.admin_user_id)::int AS c
       FROM admin_role_bindings b
       INNER JOIN admin_roles r ON r.id = b.role_id
      WHERE r.code = 'OWNER'`,
  );
  if ((history.rows[0]?.c ?? 0) > 0) {
    throw new AuthDomainError(
      'FORBIDDEN',
      'OWNER binding history exists — refuse silent reclaim/transfer',
    );
  }
  const active = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
       FROM admin_role_bindings b
       INNER JOIN admin_roles r ON r.id = b.role_id
      WHERE r.code = 'OWNER' AND b.revoked_at IS NULL`,
  );
  if ((active.rows[0]?.c ?? 0) > 0) {
    throw new AuthDomainError('FORBIDDEN', 'active OWNER binding present');
  }
}

export interface IsolatedTelegramOwnerBootstrapResult {
  readonly adminUserId: string;
  readonly telegramUserId: string;
  readonly email: string;
  readonly displayUsername: string | null;
}

/**
 * Create the first Owner on the isolated Testnet DB.
 * Caller supplies verified initData + configured Telegram id + password/TOTP.
 */
export async function enrollIsolatedTelegramOwner(input: {
  readonly pool: Pool;
  readonly connectionString: string;
  readonly expectedDatabase: string;
  readonly configuredOwnerTelegramUserId: string;
  readonly rawInitData: string;
  readonly botToken: string;
  readonly password: string;
  readonly email: string;
  readonly totpSecretBytes?: Uint8Array;
  readonly totpConfirmCode?: string;
  readonly maxAgeSeconds?: number;
  readonly nowUnixSeconds?: number;
}): Promise<IsolatedTelegramOwnerBootstrapResult> {
  const urlFacts = parseIsolatedOwnerBootstrapUrl(input.connectionString);
  assertIsolatedTelegramOwnerBootstrapTarget(urlFacts, input.expectedDatabase);

  const identity = verifyOwnerTelegramIdentityForBootstrap({
    rawInitData: input.rawInitData,
    botToken: input.botToken,
    configuredOwnerTelegramUserId: input.configuredOwnerTelegramUserId,
    ...(input.maxAgeSeconds !== undefined ? { maxAgeSeconds: input.maxAgeSeconds } : {}),
    ...(input.nowUnixSeconds !== undefined ? { nowUnixSeconds: input.nowUnixSeconds } : {}),
  });

  assertPasswordPolicy(input.password);
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new AuthDomainError('VALIDATION', 'email invalid');
  }

  const totpSecret = input.totpSecretBytes ?? generateTotpSecretBytes();
  const totpCode = input.totpConfirmCode ?? generateTotpCode(totpSecret);
  assertTotpCodeFormat(totpCode);
  if (!verifyTotpCode(totpSecret, totpCode)) {
    throw new AuthDomainError('VALIDATION', 'TOTP confirm code invalid');
  }

  // Slow crypto outside the seat-locked TX.
  const passwordVerifier = await hashAdminPassword(input.password);
  const totpSeal = sealTotpSecret(input.password, totpSecret);

  // Live identity check before mutation.
  const clientProbe = await input.pool.connect();
  try {
    await assertConnectedDestructiveTestDatabase(clientProbe);
    const live = await clientProbe.query<{ current_database: string }>(
      `SELECT current_database()`,
    );
    const current = live.rows[0]?.current_database ?? '';
    if (current !== input.expectedDatabase) {
      throw new AuthDomainError('FORBIDDEN', 'live current_database mismatch');
    }
    assertOwnerAuthOperationalDefaultDeny(current);
  } finally {
    clientProbe.release();
  }

  return withPoolOwnedOwnerAuthTransaction(input.pool, async (client) => {
    await assertM0SeatVacant(client);

    const existingTg = await client.query<{ id: string }>(
      `SELECT id::text FROM admin_users WHERE telegram_user_id = $1::bigint`,
      [identity.telegramUserId],
    );
    if (existingTg.rows[0] !== undefined) {
      throw new AuthDomainError(
        'FORBIDDEN',
        'admin_users already bound to this Telegram user id — refuse replay',
      );
    }

    const adminIns = await client.query<{ id: string }>(
      `INSERT INTO admin_users (email, display_name, status, telegram_user_id)
       VALUES ($1, $2, 'ACTIVE', $3::bigint)
       RETURNING id::text`,
      [email, identity.displayName, identity.telegramUserId],
    );
    const adminUserId = adminIns.rows[0]?.id;
    if (adminUserId === undefined) {
      throw new AuthDomainError('INTERNAL', 'admin_users insert failed');
    }

    const role = await client.query<{ id: string }>(
      `SELECT id::text FROM admin_roles WHERE code = 'OWNER' FOR UPDATE`,
    );
    const roleId = role.rows[0]?.id;
    if (roleId === undefined) {
      throw new AuthDomainError('INTERNAL', 'OWNER role missing');
    }
    await client.query(`UPDATE admin_roles SET status = 'ACTIVE' WHERE id = $1::uuid`, [roleId]);
    await client.query(
      `INSERT INTO admin_role_bindings (admin_user_id, role_id)
       VALUES ($1::uuid, $2::uuid)`,
      [adminUserId, roleId],
    );

    await client.query(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, password_verifier, status
       ) VALUES ($1::uuid, 'PASSWORD', $2, 'ACTIVE')`,
      [adminUserId, passwordVerifier],
    );
    await client.query(
      `INSERT INTO admin_credentials (
         admin_user_id, credential_type, totp_secret_reference, status, totp_last_accepted_step
       ) VALUES ($1::uuid, 'TOTP', $2, 'ACTIVE', NULL)`,
      [adminUserId, totpSeal],
    );

    const initDataFingerprint = createHash('sha256')
      .update(input.rawInitData, 'utf8')
      .digest('hex');

    await client.query(
      `INSERT INTO audit_logs (
         admin_user_id, actor_type, action_type, resource_type, resource_id,
         after_snapshot, reason, source
       ) VALUES (
         $1::uuid, 'ADMIN', 'ISOLATED_TELEGRAM_OWNER_BOOTSTRAP', 'admin_users', $1::uuid,
         $2::jsonb, 'first Owner via isolated Telegram bootstrap', 'API'
       )`,
      [
        adminUserId,
        JSON.stringify({
          trust_class: ISOLATED_TELEGRAM_OWNER_BOOTSTRAP_TARGET.trustClass,
          telegram_user_id: identity.telegramUserId,
          // Username never used for auth — recorded for display/audit only.
          telegram_username_display_only: identity.displayUsername,
          auth_date_unix: identity.authDateUnix,
          init_data_sha256_hex: initDataFingerprint,
          database: input.expectedDatabase,
          // Explicitly no secrets / initData body
        }),
      ],
    );

    return {
      status: 'ok' as const,
      value: {
        adminUserId,
        telegramUserId: identity.telegramUserId,
        email,
        displayUsername: identity.displayUsername,
      },
    };
  });
}
