/**
 * Server-authoritative Admin Web high-impact confirmations (P13-01).
 *
 * Flow: prepare (issue phrase + digest) → confirm (phrase match) → consume (one-time).
 * Client HighImpactConfirmationBinding helpers must never authorize mutations.
 */
import { randomBytes } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { AuthDomainError } from './errors.js';
import { generateOpaqueToken, safeEqualString, sha256Hex } from './crypto.js';
import {
  assertRecentReauth,
  assertAdminOwnerRole,
  type VerifiedAdminSession,
} from './admin-http.js';

export const ADMIN_WEB_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Allowlisted action-type prefixes for Admin Web high-impact confirmations. */
export const ADMIN_WEB_CONFIRMATION_ACTION_PREFIXES = [
  'ads.',
  'providers.',
  'policy.',
  'feature_flags.',
  'memberships.',
  'entitlements.',
  'reward_rules.',
  'withdrawal.',
  'review_queue.',
] as const;

export function isAllowedAdminWebConfirmationAction(actionType: string): boolean {
  const trimmed = actionType.trim();
  if (trimmed === '') return false;
  return ADMIN_WEB_CONFIRMATION_ACTION_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

export function canonicalizeAdminWebPayload(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeAdminWebPayload(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalizeAdminWebPayload(record[key])}`)
    .join(',')}}`;
}

export function digestAdminWebPayload(payload: unknown): string {
  return sha256Hex(`admin-web-confirm-payload:${canonicalizeAdminWebPayload(payload)}`);
}

function hashConfirmationPhrase(phrase: string): string {
  return sha256Hex(`admin-web-confirm-phrase:${phrase}`);
}

function generateConfirmationPhrase(actionType: string): string {
  const short = actionType.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24) || 'ACTION';
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  return `CONFIRM ${short} ${suffix}`;
}

async function insertConfirmationAudit(
  client: PoolClient,
  input: {
    readonly adminUserId: string;
    readonly actionType: string;
    readonly confirmationId: string;
    readonly reason: string;
    readonly afterSnapshot: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (
       admin_user_id, actor_type, action_type, resource_type, resource_id,
       after_snapshot, reason, source
     ) VALUES (
       $1::uuid, 'ADMIN', $2, 'admin_web_confirmation', $3::uuid, $4::jsonb, $5, 'WEB'
     )`,
    [
      input.adminUserId,
      input.actionType,
      input.confirmationId,
      JSON.stringify(input.afterSnapshot),
      input.reason,
    ],
  );
}

export interface PrepareAdminWebConfirmationInput {
  readonly session: VerifiedAdminSession;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly payload: unknown;
  readonly ttlMs?: number;
  readonly nowMs?: number;
}

export interface PrepareAdminWebConfirmationResult {
  readonly confirmationId: string;
  readonly expiresAt: string;
  readonly payloadDigest: string;
  /** Plaintext phrase — returned once; never stored. */
  readonly confirmationPhrase: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
}

export async function prepareAdminWebConfirmation(
  pool: Pool,
  input: PrepareAdminWebConfirmationInput,
): Promise<PrepareAdminWebConfirmationResult> {
  assertAdminOwnerRole(input.session);
  assertRecentReauth(input.session);

  const actionType = input.actionType.trim();
  const resourceType = input.resourceType.trim();
  const resourceId = input.resourceId.trim();
  const expectedVersion = input.expectedVersion.trim();
  if (!isAllowedAdminWebConfirmationAction(actionType)) {
    throw new AuthDomainError('VALIDATION', 'confirmation action_type is not allowlisted');
  }
  if (resourceType === '' || resourceId === '' || expectedVersion === '') {
    throw new AuthDomainError('VALIDATION', 'confirmation resource binding is required');
  }

  const payloadDigest = digestAdminWebPayload(input.payload);
  const confirmationPhrase = generateConfirmationPhrase(actionType);
  const phraseHash = hashConfirmationPhrase(confirmationPhrase);
  const nonce = generateOpaqueToken(24);
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = input.ttlMs ?? ADMIN_WEB_CONFIRMATION_TTL_MS;
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO admin_web_confirmations (
         admin_user_id, admin_session_id, action_type, resource_type, resource_id,
         expected_version, payload_digest, nonce, phrase_hash, issued_at, expires_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4, $5,
         $6, $7, $8, $9, to_timestamp($10::double precision / 1000.0), $11::timestamptz
       )
       RETURNING id::text`,
      [
        input.session.adminUserId,
        input.session.sessionId,
        actionType,
        resourceType,
        resourceId,
        expectedVersion,
        payloadDigest,
        nonce,
        phraseHash,
        nowMs,
        expiresAt,
      ],
    );
    const confirmationId = inserted.rows[0]?.id;
    if (confirmationId === undefined) {
      throw new AuthDomainError('INTERNAL', 'failed to prepare admin web confirmation');
    }
    await insertConfirmationAudit(client, {
      adminUserId: input.session.adminUserId,
      actionType: 'admin_web_confirmation.prepare',
      confirmationId,
      reason: 'high-impact confirmation prepared',
      afterSnapshot: {
        actionType,
        resourceType,
        resourceId,
        expectedVersion,
        payloadDigest,
        expiresAt,
      },
    });
    await client.query('COMMIT');
    return {
      confirmationId,
      expiresAt,
      payloadDigest,
      confirmationPhrase,
      actionType,
      resourceType,
      resourceId,
      expectedVersion,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface ConfirmAdminWebConfirmationInput {
  readonly session: VerifiedAdminSession;
  readonly confirmationId: string;
  readonly confirmationPhrase: string;
  readonly nowMs?: number;
}

export interface ConfirmAdminWebConfirmationResult {
  readonly confirmationId: string;
  readonly confirmedAt: string;
  readonly expiresAt: string;
  readonly payloadDigest: string;
}

export async function confirmAdminWebConfirmation(
  pool: Pool,
  input: ConfirmAdminWebConfirmationInput,
): Promise<ConfirmAdminWebConfirmationResult> {
  assertAdminOwnerRole(input.session);
  assertRecentReauth(input.session);

  const confirmationId = input.confirmationId.trim();
  const phrase = input.confirmationPhrase.trim();
  if (confirmationId === '' || phrase === '') {
    throw new AuthDomainError('VALIDATION', 'confirmationId and confirmationPhrase are required');
  }
  const phraseHash = hashConfirmationPhrase(phrase);
  const nowMs = input.nowMs ?? Date.now();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{
      id: string;
      admin_user_id: string;
      admin_session_id: string;
      phrase_hash: string;
      payload_digest: string;
      expires_at: Date;
      confirmed_at: Date | null;
      consumed_at: Date | null;
    }>(
      `SELECT id::text, admin_user_id::text, admin_session_id::text,
              phrase_hash, payload_digest, expires_at, confirmed_at, consumed_at
       FROM admin_web_confirmations
       WHERE id = $1::uuid
       FOR UPDATE`,
      [confirmationId],
    );
    const row = locked.rows[0];
    if (row === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation not found');
    }
    if (row.admin_user_id !== input.session.adminUserId) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation admin mismatch');
    }
    if (row.admin_session_id !== input.session.sessionId) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation session mismatch');
    }
    if (row.consumed_at !== null) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation already consumed');
    }
    if (row.expires_at.getTime() <= nowMs) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation expired');
    }
    if (!safeEqualString(row.phrase_hash, phraseHash)) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation phrase mismatch');
    }
    if (row.confirmed_at !== null) {
      // Idempotent re-confirm of the same open ticket is allowed (same session/phrase).
      await client.query('COMMIT');
      return {
        confirmationId: row.id,
        confirmedAt: row.confirmed_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        payloadDigest: row.payload_digest,
      };
    }

    const updated = await client.query<{ confirmed_at: Date }>(
      `UPDATE admin_web_confirmations
       SET confirmed_at = to_timestamp($2::double precision / 1000.0)
       WHERE id = $1::uuid
         AND confirmed_at IS NULL
         AND consumed_at IS NULL
       RETURNING confirmed_at`,
      [confirmationId, nowMs],
    );
    const confirmedAt = updated.rows[0]?.confirmed_at;
    if (confirmedAt === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation confirm race');
    }
    await insertConfirmationAudit(client, {
      adminUserId: input.session.adminUserId,
      actionType: 'admin_web_confirmation.confirm',
      confirmationId,
      reason: 'high-impact confirmation phrase accepted',
      afterSnapshot: { confirmedAt: confirmedAt.toISOString() },
    });
    await client.query('COMMIT');
    return {
      confirmationId,
      confirmedAt: confirmedAt.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      payloadDigest: row.payload_digest,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export interface ConsumeAdminWebConfirmationInput {
  readonly session: VerifiedAdminSession;
  readonly confirmationId: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly expectedVersion: string;
  readonly payload: unknown;
  readonly nowMs?: number;
  /** Optional client already holding a transaction. */
  readonly client?: PoolClient;
}

export interface ConsumeAdminWebConfirmationResult {
  readonly confirmationId: string;
  readonly consumedAt: string;
}

/**
 * One-time consume of a confirmed, unexpired, session-bound confirmation.
 * Prefer calling inside the same domain transaction when possible.
 */
export async function consumeAdminWebConfirmation(
  pool: Pool,
  input: ConsumeAdminWebConfirmationInput,
): Promise<ConsumeAdminWebConfirmationResult> {
  assertAdminOwnerRole(input.session);
  assertRecentReauth(input.session);

  const confirmationId = input.confirmationId.trim();
  if (confirmationId === '') {
    throw new AuthDomainError('FORBIDDEN', 'confirmationId is required');
  }

  const expectedDigest = digestAdminWebPayload(input.payload);
  const nowMs = input.nowMs ?? Date.now();
  const ownsClient = input.client === undefined;
  const client = input.client ?? (await pool.connect());

  const run = async (): Promise<ConsumeAdminWebConfirmationResult> => {
    const locked = await client.query<{
      id: string;
      admin_user_id: string;
      admin_session_id: string;
      action_type: string;
      resource_type: string;
      resource_id: string;
      expected_version: string;
      payload_digest: string;
      expires_at: Date;
      confirmed_at: Date | null;
      consumed_at: Date | null;
    }>(
      `SELECT id::text, admin_user_id::text, admin_session_id::text,
              action_type, resource_type, resource_id, expected_version,
              payload_digest, expires_at, confirmed_at, consumed_at
       FROM admin_web_confirmations
       WHERE id = $1::uuid
       FOR UPDATE`,
      [confirmationId],
    );
    const row = locked.rows[0];
    if (row === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation not found');
    }
    if (row.admin_user_id !== input.session.adminUserId) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation admin mismatch');
    }
    if (row.admin_session_id !== input.session.sessionId) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation session mismatch');
    }
    if (row.consumed_at !== null) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation already consumed');
    }
    if (row.confirmed_at === null) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation not confirmed');
    }
    if (row.expires_at.getTime() <= nowMs) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation expired');
    }
    if (row.action_type !== input.actionType) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation action mismatch');
    }
    if (
      row.resource_type !== input.resourceType ||
      row.resource_id !== input.resourceId
    ) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation resource mismatch');
    }
    if (row.expected_version !== input.expectedVersion) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation version mismatch');
    }
    if (!safeEqualString(row.payload_digest, expectedDigest)) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation payload digest mismatch');
    }

    const updated = await client.query<{ consumed_at: Date }>(
      `UPDATE admin_web_confirmations
       SET consumed_at = to_timestamp($2::double precision / 1000.0)
       WHERE id = $1::uuid
         AND confirmed_at IS NOT NULL
         AND consumed_at IS NULL
       RETURNING consumed_at`,
      [confirmationId, nowMs],
    );
    const consumedAt = updated.rows[0]?.consumed_at;
    if (consumedAt === undefined) {
      throw new AuthDomainError('FORBIDDEN', 'confirmation already consumed');
    }
    await insertConfirmationAudit(client, {
      adminUserId: input.session.adminUserId,
      actionType: 'admin_web_confirmation.consume',
      confirmationId,
      reason: 'high-impact confirmation consumed',
      afterSnapshot: {
        actionType: input.actionType,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        expectedVersion: input.expectedVersion,
        payloadDigest: expectedDigest,
        consumedAt: consumedAt.toISOString(),
      },
    });
    return { confirmationId, consumedAt: consumedAt.toISOString() };
  };

  if (!ownsClient) {
    return run();
  }
  try {
    await client.query('BEGIN');
    const result = await run();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
