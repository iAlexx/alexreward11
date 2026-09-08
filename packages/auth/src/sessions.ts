import type { Pool, PoolClient } from 'pg';

import { AuthDomainError } from './errors.js';
import {
  generateOpaqueToken,
  hashIp,
  hashRefreshToken,
  hashSessionSecret,
  summarizeUserAgent,
} from './crypto.js';
import { issueAccessToken } from './access-token.js';

export type SessionRevocationReason =
  'USER_LOGOUT' | 'ROTATED' | 'EXPIRED' | 'ADMIN_REVOKED' | 'SECURITY_EVENT';

export interface SessionTokens {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly sessionId: string;
  readonly refreshExpiresAt: Date;
}

export interface SessionConfig {
  readonly accessSecret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}

export interface RequestMeta {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly deviceSummary?: string | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string | null;
  expires_at: Date;
  revoked_at: Date | null;
}

async function withClient<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function buildTokens(
  config: SessionConfig,
  userId: string,
  sessionId: string,
  refreshToken: string,
  refreshExpiresAt: Date,
): SessionTokens {
  const access = issueAccessToken({
    userId,
    sessionId,
    secret: config.accessSecret,
    ttlSeconds: config.accessTtlSeconds,
  });
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken,
    sessionId,
    refreshExpiresAt,
  };
}

export async function createUserSession(
  pool: Pool,
  config: SessionConfig,
  userId: string,
  meta: RequestMeta = {},
): Promise<SessionTokens> {
  const sessionSecret = generateOpaqueToken();
  const refreshToken = generateOpaqueToken();
  const refreshExpiresAt = new Date(Date.now() + config.refreshTtlSeconds * 1000);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO user_sessions (
       user_id, session_secret_hash, refresh_token_hash, ip_hash,
       user_agent_summary, device_summary, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      userId,
      hashSessionSecret(sessionSecret),
      hashRefreshToken(refreshToken),
      hashIp(meta.ip),
      summarizeUserAgent(meta.userAgent),
      meta.deviceSummary ?? null,
      refreshExpiresAt.toISOString(),
    ],
  );
  const sessionId = result.rows[0]?.id;
  if (sessionId === undefined) {
    throw new AuthDomainError('INTERNAL', 'Failed to create session');
  }
  return buildTokens(config, userId, sessionId, refreshToken, refreshExpiresAt);
}

export async function rotateRefreshSession(
  pool: Pool,
  config: SessionConfig,
  presentedRefreshToken: string,
  meta: RequestMeta = {},
): Promise<SessionTokens> {
  const presentedHash = hashRefreshToken(presentedRefreshToken);
  return withClient(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const existing = await client.query<SessionRow>(
        `SELECT id, user_id, refresh_token_hash, expires_at, revoked_at
         FROM user_sessions
         WHERE refresh_token_hash = $1
         FOR UPDATE`,
        [presentedHash],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new AuthDomainError('REFRESH_REPLAY', 'Refresh credential is invalid');
      }
      if (row.revoked_at !== null) {
        throw new AuthDomainError('REFRESH_REPLAY', 'Refresh credential is invalid');
      }
      if (row.expires_at.getTime() <= Date.now()) {
        await client.query(
          `UPDATE user_sessions
           SET revoked_at = now(), revoked_reason = 'EXPIRED'
           WHERE id = $1 AND revoked_at IS NULL`,
          [row.id],
        );
        throw new AuthDomainError('SESSION_EXPIRED', 'Session expired');
      }

      const revoke = await client.query(
        `UPDATE user_sessions
         SET revoked_at = now(), revoked_reason = 'ROTATED'
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [row.id],
      );
      if (revoke.rowCount !== 1) {
        throw new AuthDomainError('REFRESH_RACE', 'Refresh credential is invalid');
      }

      const sessionSecret = generateOpaqueToken();
      const refreshToken = generateOpaqueToken();
      const refreshExpiresAt = new Date(Date.now() + config.refreshTtlSeconds * 1000);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO user_sessions (
           user_id, session_secret_hash, refresh_token_hash, ip_hash,
           user_agent_summary, device_summary, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          row.user_id,
          hashSessionSecret(sessionSecret),
          hashRefreshToken(refreshToken),
          hashIp(meta.ip),
          summarizeUserAgent(meta.userAgent),
          meta.deviceSummary ?? null,
          refreshExpiresAt.toISOString(),
        ],
      );
      const sessionId = inserted.rows[0]?.id;
      if (sessionId === undefined) {
        throw new AuthDomainError('INTERNAL', 'Failed to rotate session');
      }
      await client.query('COMMIT');
      return buildTokens(config, row.user_id, sessionId, refreshToken, refreshExpiresAt);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function revokeSession(
  pool: Pool,
  sessionId: string,
  userId: string,
  reason: SessionRevocationReason,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE user_sessions
     SET revoked_at = now(), revoked_reason = $3
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sessionId, userId, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function revokeAllUserSessions(
  pool: Pool,
  userId: string,
  reason: SessionRevocationReason = 'SECURITY_EVENT',
): Promise<number> {
  const result = await pool.query(
    `UPDATE user_sessions
     SET revoked_at = now(), revoked_reason = $2
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return result.rowCount ?? 0;
}

export async function assertSessionActive(
  pool: Pool,
  sessionId: string,
  userId: string,
): Promise<void> {
  const result = await pool.query<SessionRow>(
    `SELECT id, user_id, refresh_token_hash, expires_at, revoked_at
     FROM user_sessions
     WHERE id = $1 AND user_id = $2`,
    [sessionId, userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AuthDomainError('UNAUTHENTICATED', 'Authentication required');
  }
  if (row.revoked_at !== null) {
    throw new AuthDomainError('SESSION_REVOKED', 'Session revoked');
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw new AuthDomainError('SESSION_EXPIRED', 'Session expired');
  }
  await pool.query(`UPDATE user_sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]);
}

export async function listActiveSessions(
  pool: Pool,
  userId: string,
): Promise<
  ReadonlyArray<{
    id: string;
    createdAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
    userAgentSummary: string | null;
    deviceSummary: string | null;
  }>
> {
  const result = await pool.query<{
    id: string;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
    user_agent_summary: string | null;
    device_summary: string | null;
  }>(
    `SELECT id, created_at, last_seen_at, expires_at, user_agent_summary, device_summary
     FROM user_sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY last_seen_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    userAgentSummary: row.user_agent_summary,
    deviceSummary: row.device_summary,
  }));
}
