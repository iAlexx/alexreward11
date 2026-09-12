import { generateOpaqueToken, sha256Hex } from '@alex-rewards/auth';
import type { Pool, PoolClient } from 'pg';

import type { ControlCenterRuntimeConfig } from './config.js';
import { ControlCenterError } from './errors.js';
import type { AdminActionTokenRow } from './types.js';

type Db = Pool | PoolClient;

export function hashActionToken(rawToken: string): string {
  return sha256Hex(`action:${rawToken}`);
}

function mapToken(row: {
  id: string;
  admin_user_id: string;
  action_type: string;
  resource_type: string;
  resource_id: string | null;
  token_hash: string;
  source: AdminActionTokenRow['source'];
  requires_second_confirmation: boolean;
  issued_at: Date;
  expires_at: Date;
  confirmed_at: Date | null;
  consumed_at: Date | null;
  consumed_by_admin_id: string | null;
  expected_state: string | null;
  destination_id: string;
  bound_chat_id: string;
  bound_topic_thread_id: string | null;
  nonce: string;
  confirmation_of_token_id: string | null;
}): AdminActionTokenRow {
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    actionType: row.action_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    tokenHash: row.token_hash,
    source: row.source,
    requiresSecondConfirmation: row.requires_second_confirmation,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    confirmedAt: row.confirmed_at,
    consumedAt: row.consumed_at,
    consumedByAdminId: row.consumed_by_admin_id,
    expectedState: row.expected_state,
    destinationId: row.destination_id,
    boundChatId: row.bound_chat_id,
    boundTopicThreadId: row.bound_topic_thread_id,
    nonce: row.nonce,
    confirmationOfTokenId: row.confirmation_of_token_id,
  };
}

const TOKEN_SELECT = `id, admin_user_id, action_type, resource_type, resource_id, token_hash, source,
  requires_second_confirmation, issued_at, expires_at, confirmed_at, consumed_at,
  consumed_by_admin_id, expected_state, destination_id,
  bound_chat_id::text AS bound_chat_id,
  bound_topic_thread_id::text AS bound_topic_thread_id,
  nonce, confirmation_of_token_id`;

export interface IssueAdminActionTokenInput {
  readonly adminUserId: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly expectedState: string | null;
  readonly destinationId: string;
  readonly boundChatId: string;
  readonly boundTopicThreadId: string | null;
  readonly requiresSecondConfirmation?: boolean;
  readonly confirmationOfTokenId?: string | null;
  readonly ttlSeconds?: number;
  readonly source?: AdminActionTokenRow['source'];
}

export interface IssuedAdminActionToken {
  readonly token: AdminActionTokenRow;
  /** Opaque raw secret for Telegram callback_data only. Never log or audit. */
  readonly rawToken: string;
}

export async function issueAdminActionToken(
  db: Db,
  config: ControlCenterRuntimeConfig,
  input: IssueAdminActionTokenInput,
): Promise<IssuedAdminActionToken> {
  const rawToken = generateOpaqueToken(32);
  if (Buffer.byteLength(rawToken, 'utf8') > 64) {
    throw new ControlCenterError('INTERNAL', undefined, {
      details: { reason: 'TOKEN_TOO_LONG_FOR_TELEGRAM' },
    });
  }
  const tokenHash = hashActionToken(rawToken);
  const nonce = generateOpaqueToken(16);
  const ttl =
    input.ttlSeconds ??
    (input.requiresSecondConfirmation === true
      ? config.confirmTokenTtlSeconds
      : config.actionTokenTtlSeconds);
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'INVALID_TTL' },
    });
  }

  const result = await db.query<{
    id: string;
    admin_user_id: string;
    action_type: string;
    resource_type: string;
    resource_id: string | null;
    token_hash: string;
    source: AdminActionTokenRow['source'];
    requires_second_confirmation: boolean;
    issued_at: Date;
    expires_at: Date;
    confirmed_at: Date | null;
    consumed_at: Date | null;
    consumed_by_admin_id: string | null;
    expected_state: string | null;
    destination_id: string;
    bound_chat_id: string;
    bound_topic_thread_id: string | null;
    nonce: string;
    confirmation_of_token_id: string | null;
  }>(
    `INSERT INTO admin_action_tokens (
       admin_user_id, action_type, resource_type, resource_id, token_hash, source,
       requires_second_confirmation, expires_at, expected_state, destination_id,
       bound_chat_id, bound_topic_thread_id, nonce, confirmation_of_token_id
     ) VALUES (
       $1::uuid, $2, $3, $4::uuid, $5, $6::actor_source,
       $7, now() + ($8::text || ' seconds')::interval, $9, $10::uuid,
       $11::bigint, $12::bigint, $13, $14::uuid
     )
     RETURNING ${TOKEN_SELECT}`,
    [
      input.adminUserId,
      input.actionType,
      input.resourceType,
      input.resourceId,
      tokenHash,
      input.source ?? 'TELEGRAM',
      input.requiresSecondConfirmation ?? false,
      String(ttl),
      input.expectedState,
      input.destinationId,
      input.boundChatId,
      input.boundTopicThreadId,
      nonce,
      input.confirmationOfTokenId ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('INTERNAL', undefined, {
      details: { reason: 'TOKEN_ISSUE_FAILED' },
    });
  }
  return { token: mapToken(row), rawToken };
}

export interface ConsumeAdminActionTokenInput {
  readonly rawToken: string;
  readonly actorAdminUserId: string;
  readonly chatId: string;
  readonly topicThreadId: string | null;
  readonly actionType?: string;
  readonly resourceId?: string | null;
  readonly expectedState?: string | null;
  readonly requireConfirmationSatisfied?: boolean;
}

async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function validateLockedToken(
  token: AdminActionTokenRow,
  input: ConsumeAdminActionTokenInput,
): 'ok' | 'already_processed' {
  if (token.consumedAt !== null) {
    if (
      token.consumedByAdminId === input.actorAdminUserId ||
      token.adminUserId === input.actorAdminUserId
    ) {
      return 'already_processed';
    }
    throw new ControlCenterError('ALREADY_PROCESSED');
  }

  if (token.adminUserId !== input.actorAdminUserId) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'ACTOR_MISMATCH' },
    });
  }
  if (token.boundChatId !== input.chatId) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'CHAT_MISMATCH' },
    });
  }
  const boundTopic = token.boundTopicThreadId;
  const callbackTopic = input.topicThreadId;
  if (boundTopic !== callbackTopic) {
    if (boundTopic === null || callbackTopic === null || boundTopic !== callbackTopic) {
      throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
        details: { reason: 'TOPIC_MISMATCH' },
      });
    }
  }
  if (input.actionType !== undefined && token.actionType !== input.actionType) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'ACTION_TYPE_MISMATCH' },
    });
  }
  if (input.resourceId !== undefined && token.resourceId !== input.resourceId) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'RESOURCE_MISMATCH' },
    });
  }
  if (token.expiresAt.getTime() <= Date.now()) {
    throw new ControlCenterError('ACTION_EXPIRED');
  }
  if (
    input.expectedState !== undefined &&
    token.expectedState !== null &&
    token.expectedState !== input.expectedState
  ) {
    throw new ControlCenterError('STATE_CHANGED', undefined, {
      details: { expected: token.expectedState, provided: input.expectedState },
    });
  }
  if (token.requiresSecondConfirmation && input.requireConfirmationSatisfied !== true) {
    if (token.confirmedAt === null && token.confirmationOfTokenId === null) {
      // Parent high-impact token still awaiting second confirmation token path.
      // Consume of the confirmation child is handled separately.
    }
  }
  return 'ok';
}

export interface ConsumeAdminActionTokenResult<T> {
  readonly token: AdminActionTokenRow;
  readonly alreadyProcessed: boolean;
  readonly result: T | undefined;
}

/**
 * Lock token by hash, validate bindings, optionally run domain work in the same TX,
 * then mark consumed only on success. Duplicate consume after success → ALREADY_PROCESSED
 * without re-running domainFn.
 */
export async function consumeAdminActionToken<T = undefined>(
  pool: Pool,
  input: ConsumeAdminActionTokenInput,
  domainFn?: (client: PoolClient, token: AdminActionTokenRow) => Promise<T>,
): Promise<ConsumeAdminActionTokenResult<T>> {
  const raw = input.rawToken.trim();
  if (raw.length < 16 || raw.length > 64) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'INVALID_TOKEN_FORMAT' },
    });
  }
  const tokenHash = hashActionToken(raw);

  return withTransaction(pool, async (client) => {
    const locked = await client.query<{
      id: string;
      admin_user_id: string;
      action_type: string;
      resource_type: string;
      resource_id: string | null;
      token_hash: string;
      source: AdminActionTokenRow['source'];
      requires_second_confirmation: boolean;
      issued_at: Date;
      expires_at: Date;
      confirmed_at: Date | null;
      consumed_at: Date | null;
      consumed_by_admin_id: string | null;
      expected_state: string | null;
      destination_id: string;
      bound_chat_id: string;
      bound_topic_thread_id: string | null;
      nonce: string;
      confirmation_of_token_id: string | null;
    }>(
      `SELECT ${TOKEN_SELECT}
       FROM admin_action_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );
    const row = locked.rows[0];
    if (row === undefined) {
      throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
        details: { reason: 'TOKEN_NOT_FOUND' },
      });
    }
    const token = mapToken(row);
    const status = validateLockedToken(token, input);
    if (status === 'already_processed') {
      return { token, alreadyProcessed: true, result: undefined };
    }

    let result: T | undefined;
    if (domainFn !== undefined) {
      result = await domainFn(client, token);
    }

    const consume = await client.query(
      `UPDATE admin_action_tokens
       SET consumed_at = now(), consumed_by_admin_id = $2::uuid
       WHERE id = $1::uuid AND consumed_at IS NULL
       RETURNING id`,
      [token.id, input.actorAdminUserId],
    );
    if (consume.rowCount !== 1) {
      throw new ControlCenterError('ALREADY_PROCESSED');
    }

    return {
      token: { ...token, consumedAt: new Date(), consumedByAdminId: input.actorAdminUserId },
      alreadyProcessed: false,
      result,
    };
  });
}

/**
 * Validate token bindings without consuming. Used when the domain command owns
 * its own transaction and cannot share the token lock TX.
 */
export async function validateAdminActionToken(
  pool: Pool,
  input: ConsumeAdminActionTokenInput,
): Promise<{ readonly token: AdminActionTokenRow; readonly alreadyProcessed: boolean }> {
  const raw = input.rawToken.trim();
  if (raw.length < 16 || raw.length > 64) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'INVALID_TOKEN_FORMAT' },
    });
  }
  const tokenHash = hashActionToken(raw);

  return withTransaction(pool, async (client) => {
    const locked = await client.query<{
      id: string;
      admin_user_id: string;
      action_type: string;
      resource_type: string;
      resource_id: string | null;
      token_hash: string;
      source: AdminActionTokenRow['source'];
      requires_second_confirmation: boolean;
      issued_at: Date;
      expires_at: Date;
      confirmed_at: Date | null;
      consumed_at: Date | null;
      consumed_by_admin_id: string | null;
      expected_state: string | null;
      destination_id: string;
      bound_chat_id: string;
      bound_topic_thread_id: string | null;
      nonce: string;
      confirmation_of_token_id: string | null;
    }>(
      `SELECT ${TOKEN_SELECT}
       FROM admin_action_tokens
       WHERE token_hash = $1
       FOR UPDATE`,
      [tokenHash],
    );
    const row = locked.rows[0];
    if (row === undefined) {
      throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
        details: { reason: 'TOKEN_NOT_FOUND' },
      });
    }
    const token = mapToken(row);
    const status = validateLockedToken(token, input);
    if (status === 'already_processed') {
      return { token, alreadyProcessed: true };
    }
    return { token, alreadyProcessed: false };
  });
}

/** Mark token consumed after authoritative domain success. Idempotent. */
export async function markAdminActionTokenConsumed(
  pool: Pool,
  input: { readonly tokenId: string; readonly adminUserId: string },
): Promise<{ readonly alreadyProcessed: boolean }> {
  const result = await pool.query<{ id: string }>(
    `UPDATE admin_action_tokens
     SET consumed_at = now(), consumed_by_admin_id = $2::uuid
     WHERE id = $1::uuid AND consumed_at IS NULL
     RETURNING id`,
    [input.tokenId, input.adminUserId],
  );
  if (result.rowCount === 1) {
    return { alreadyProcessed: false };
  }
  const existing = await pool.query<{ consumed_at: Date | null }>(
    `SELECT consumed_at FROM admin_action_tokens WHERE id = $1::uuid`,
    [input.tokenId],
  );
  if (existing.rows[0]?.consumed_at != null) {
    return { alreadyProcessed: true };
  }
  throw new ControlCenterError('INTERNAL', undefined, {
    details: { reason: 'TOKEN_CONSUME_FAILED' },
  });
}

/**
 * Make open withdrawal.decide.* tokens non-actionable without recording a decision.
 * Uses expires_at only (no schema migration; not a successful Owner decision).
 */
export async function expireOpenWithdrawalDecisionTokens(
  db: Db,
  input: {
    readonly withdrawalId: string;
    readonly expectedState: string;
    readonly adminUserId: string;
    readonly destinationId: string;
    /** When set, leave this token alone (already consumed / executing). */
    readonly excludeTokenId?: string;
  },
): Promise<{ readonly expiredCount: number }> {
  const result = await db.query<{ id: string }>(
    `UPDATE admin_action_tokens
     SET expires_at = LEAST(expires_at, now())
     WHERE resource_type = 'withdrawal'
       AND resource_id = $1::uuid
       AND expected_state = $2
       AND admin_user_id = $3::uuid
       AND destination_id = $4::uuid
       AND action_type IN (
         'withdrawal.decide.APPROVE',
         'withdrawal.decide.HOLD',
         'withdrawal.decide.REJECT'
       )
       AND consumed_at IS NULL
       AND expires_at > now()
       AND ($5::uuid IS NULL OR id <> $5::uuid)
     RETURNING id`,
    [
      input.withdrawalId,
      input.expectedState,
      input.adminUserId,
      input.destinationId,
      input.excludeTokenId ?? null,
    ],
  );
  return { expiredCount: result.rowCount ?? 0 };
}

/** Lookup open token by hash without consuming (tests / diagnostics). Never log raw. */
export async function findAdminActionTokenByRaw(
  db: Db,
  rawToken: string,
): Promise<AdminActionTokenRow | null> {
  const result = await db.query<{
    id: string;
    admin_user_id: string;
    action_type: string;
    resource_type: string;
    resource_id: string | null;
    token_hash: string;
    source: AdminActionTokenRow['source'];
    requires_second_confirmation: boolean;
    issued_at: Date;
    expires_at: Date;
    confirmed_at: Date | null;
    consumed_at: Date | null;
    consumed_by_admin_id: string | null;
    expected_state: string | null;
    destination_id: string;
    bound_chat_id: string;
    bound_topic_thread_id: string | null;
    nonce: string;
    confirmation_of_token_id: string | null;
  }>(`SELECT ${TOKEN_SELECT} FROM admin_action_tokens WHERE token_hash = $1`, [
    hashActionToken(rawToken),
  ]);
  const row = result.rows[0];
  return row === undefined ? null : mapToken(row);
}
