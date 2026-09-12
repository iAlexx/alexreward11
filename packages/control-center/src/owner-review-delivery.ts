/**
 * Bot/Control Center deliverer for withdrawal.owner_review_required Outbox events.
 * Issues Owner decision tokens, sends Approvals card, marks publication PUBLISHED.
 * Raw tokens never leave the immediate Telegram-send path (never logged/audited).
 *
 * Critical expire→issue is serialized on the Approvals telegram_publications row
 * (SELECT … FOR UPDATE). The DB transaction is released before Telegram sendMessage.
 * Post-send finalization re-locks the publication and fences on exact token generation IDs.
 */
import type { Pool, PoolClient } from 'pg';

import {
  claimPendingOwnerReviewRequiredEvents,
  insertWithdrawalAuditLog,
  markOutboxDispatched,
  markOutboxRetry,
  redactOutboxError,
  withWithdrawalTransaction,
  type WithdrawalEngineConfig,
} from '@alex-rewards/withdrawals';

import { expireOpenWithdrawalDecisionTokens } from './action-tokens.js';
import { authorizeOwnerAction } from './authorize.js';
import type { ControlCenterRuntimeConfig } from './config.js';
import { resolveDestination } from './destinations.js';
import { ControlCenterError } from './errors.js';
import { CONTROL_CENTER_PERMISSIONS } from './permissions.js';
import { enqueueTelegramPublication, markPublicationPublished } from './publications.js';
import type { ControlCenterEnvironment, WithdrawalTelegramDecision } from './types.js';
import {
  buildWithdrawalApprovalsCard,
  issueWithdrawalDecisionTokens,
} from './withdrawal-actions.js';

export interface ApprovalsTelegramSendInput {
  readonly chatId: string;
  readonly topicThreadId: string | null;
  readonly text: string;
  /** Raw tokens only for callback_data construction — caller must not log. */
  readonly buttons: ReadonlyArray<{
    readonly decision: WithdrawalTelegramDecision;
    readonly rawToken: string;
  }>;
}

export interface ApprovalsTelegramSender {
  sendApprovalsCard(input: ApprovalsTelegramSendInput): Promise<{ telegramMessageId: string }>;
}

export interface ProcessOwnerReviewRequiredBatchResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly superseded: number;
  readonly retried: number;
}

/**
 * Test-only barriers for forcing expire→issue / send interleaving across deliverers.
 * Production callers must omit these.
 */
export interface OwnerReviewSerializationHooks {
  readonly afterExpire?: () => Promise<void>;
  readonly beforeIssue?: () => Promise<void>;
  /** Invoked immediately before Telegram send (DB lock already released). */
  readonly beforeTelegramSend?: () => Promise<void>;
}

export interface OwnerReviewOutboxEventInput {
  readonly id: string;
  readonly aggregateId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

function resolveWithdrawalId(payload: Readonly<Record<string, unknown>>, aggregateId: string | null): string {
  const fromPayload = payload.withdrawalId;
  if (typeof fromPayload === 'string' && fromPayload.trim() !== '') {
    return fromPayload;
  }
  if (aggregateId !== null && aggregateId.trim() !== '') {
    return aggregateId;
  }
  throw new ControlCenterError('VALIDATION', undefined, {
    details: { reason: 'OWNER_REVIEW_MISSING_WITHDRAWAL_ID' },
  });
}

function resolveExpectedState(payload: Readonly<Record<string, unknown>>): 'MANUAL_REVIEW' {
  const expected = payload.expectedState;
  if (expected === 'MANUAL_REVIEW') {
    return expected;
  }
  throw new ControlCenterError('VALIDATION', undefined, {
    details: { reason: 'OWNER_REVIEW_UNEXPECTED_EXPECTED_STATE', expected },
  });
}

async function resolveAuthorizedOwnerForApprovals(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  destination: { readonly chatId: string; readonly topicThreadId: string | null },
): Promise<{ adminUserId: string; telegramUserId: string }> {
  const candidates = [...config.ownerTelegramUserIds].sort();
  if (candidates.length === 0) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'OWNER_ALLOWLIST_EMPTY' },
    });
  }
  const errors: string[] = [];
  for (const telegramUserId of candidates) {
    try {
      const owner = await authorizeOwnerAction(pool, config, {
        telegramUserId,
        permissionCode: CONTROL_CENTER_PERMISSIONS.WITHDRAWAL_REVIEW_DECIDE,
        chatId: destination.chatId,
        topicThreadId: destination.topicThreadId,
        environment: config.deploymentEnvironment,
      });
      return { adminUserId: owner.adminUserId, telegramUserId };
    } catch (error) {
      if (error instanceof ControlCenterError) {
        errors.push(String(error.details?.reason ?? error.code));
        continue;
      }
      throw error;
    }
  }
  throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
    details: { reason: 'NO_AUTHORIZED_OWNER_FOR_APPROVALS', errors },
  });
}

async function loadPublicationStatus(
  client: PoolClient,
  destinationId: string,
  withdrawalId: string,
): Promise<{ id: string; status: string } | null> {
  const result = await client.query<{ id: string; status: string }>(
    `SELECT id, status::text AS status
     FROM telegram_publications
     WHERE destination_id = $1::uuid
       AND subject_type = 'withdrawal'
       AND subject_id = $2::uuid
       AND message_kind = 'approvals_card'
     LIMIT 1`,
    [destinationId, withdrawalId],
  );
  return result.rows[0] ?? null;
}

type IssuedDecisionToken = {
  readonly decision: WithdrawalTelegramDecision;
  readonly rawToken: string;
  readonly tokenId: string;
};

type SerializedIssueResult =
  | {
      readonly kind: 'superseded';
      readonly reason: 'expected_state_mismatch' | 'already_published';
      readonly actualState: string | null;
    }
  | {
      readonly kind: 'issued';
      readonly publicationId: string;
      readonly expiredCount: number;
      readonly issued: ReadonlyArray<IssuedDecisionToken>;
    };

type FinalizeAfterSendResult =
  | { readonly kind: 'finalized' }
  | { readonly kind: 'already_published' }
  | { readonly kind: 'stale_generation' };

/**
 * True when this exact issued generation is still the current Approvals decision set.
 *
 * Requires the generation to contain exactly one each of APPROVE / HOLD / REJECT
 * for the same withdrawal / expectedState / Owner / destination, and no foreign
 * open decide tokens in that scope.
 *
 * Undecided generation (no consumed rows):
 *   all three must still be unconsumed and unexpired.
 *
 * Already-decided generation (exactly one consumed from this set):
 *   remains finalizable even if sibling tokens were expired by sibling cleanup.
 *
 * An entirely expired/unconsumed generation is never current (fail closed).
 * Multiple consumed decide tokens in one generation is inconsistent → fail closed.
 */
async function isCurrentDecisionTokenGeneration(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly expectedState: string;
    readonly adminUserId: string;
    readonly destinationId: string;
    readonly generationTokenIds: ReadonlyArray<string>;
  },
): Promise<boolean> {
  if (input.generationTokenIds.length !== 3) {
    return false;
  }

  const generation = await client.query<{
    id: string;
    action_type: string;
    resource_id: string | null;
    expected_state: string | null;
    admin_user_id: string;
    destination_id: string;
    consumed_at: Date | null;
    expires_at: Date;
    is_open: boolean;
  }>(
    `SELECT id, action_type, resource_id, expected_state, admin_user_id, destination_id,
            consumed_at, expires_at,
            (consumed_at IS NULL AND expires_at > now()) AS is_open
     FROM admin_action_tokens
     WHERE id = ANY($1::uuid[])
       AND resource_type = 'withdrawal'
       AND action_type IN (
         'withdrawal.decide.APPROVE',
         'withdrawal.decide.HOLD',
         'withdrawal.decide.REJECT'
       )`,
    [input.generationTokenIds],
  );
  if (generation.rowCount !== 3) {
    return false;
  }

  const seenActions = new Set<string>();
  for (const row of generation.rows) {
    if (
      row.resource_id !== input.withdrawalId ||
      row.expected_state !== input.expectedState ||
      row.admin_user_id !== input.adminUserId ||
      row.destination_id !== input.destinationId
    ) {
      return false;
    }
    if (seenActions.has(row.action_type)) {
      return false;
    }
    seenActions.add(row.action_type);
  }
  if (
    !seenActions.has('withdrawal.decide.APPROVE') ||
    !seenActions.has('withdrawal.decide.HOLD') ||
    !seenActions.has('withdrawal.decide.REJECT')
  ) {
    return false;
  }

  const consumedCount = generation.rows.filter((row) => row.consumed_at !== null).length;
  if (consumedCount > 1) {
    // Inconsistent: at most one decision token should ever be consumed.
    return false;
  }

  if (consumedCount === 0) {
    // Undecided generation must still be fully open/actionable.
    if (!generation.rows.every((row) => row.is_open === true)) {
      return false;
    }
  }
  // consumedCount === 1: already-decided generation remains finalizable even if
  // sibling tokens were expired by sibling cleanup.

  // Newer deliverer left open tokens outside this generation → we are stale.
  const foreignOpen = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_action_tokens
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
       AND NOT (id = ANY($5::uuid[]))`,
    [
      input.withdrawalId,
      input.expectedState,
      input.adminUserId,
      input.destinationId,
      input.generationTokenIds,
    ],
  );
  return (foreignOpen.rows[0]?.c ?? 0) === 0;
}

/**
 * Ensure Approvals publication exists, lock it, then expire→issue under that lock.
 * Commits before returning so Telegram I/O never holds the transaction.
 */
async function replaceDecisionTokensUnderPublicationLock(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly withdrawalId: string;
    readonly expectedState: 'MANUAL_REVIEW';
    readonly environment: ControlCenterEnvironment;
    readonly destination: {
      readonly id: string;
      readonly chatId: string;
      readonly topicThreadId: string | null;
    };
    readonly adminUserId: string;
    readonly hooks?: OwnerReviewSerializationHooks;
  },
): Promise<SerializedIssueResult> {
  return withWithdrawalTransaction(pool, async (client) => {
    // 1) Idempotent publication identity must exist before issuance.
    const enqueued = await enqueueTelegramPublication(client, {
      destinationId: input.destination.id,
      subjectType: 'withdrawal',
      subjectId: input.withdrawalId,
      messageKind: 'approvals_card',
    });

    // 2) Row-level mutex across bot processes/replicas.
    await client.query(
      `SELECT id FROM telegram_publications WHERE id = $1::uuid FOR UPDATE`,
      [enqueued.publication.id],
    );

    // 3) Re-check authoritative withdrawal state under the lock.
    const live = await client.query<{ state: string }>(
      `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
      [input.withdrawalId],
    );
    const liveState = live.rows[0]?.state ?? null;
    if (liveState !== input.expectedState) {
      return {
        kind: 'superseded',
        reason: 'expected_state_mismatch',
        actualState: liveState,
      };
    }

    // 4) Re-read publication; already PUBLISHED → no reissue.
    const locked = await loadPublicationStatus(client, input.destination.id, input.withdrawalId);
    if (locked === null) {
      throw new ControlCenterError('INTERNAL', undefined, {
        details: { reason: 'APPROVALS_PUBLICATION_MISSING_UNDER_LOCK' },
      });
    }
    if (locked.status === 'PUBLISHED') {
      return {
        kind: 'superseded',
        reason: 'already_published',
        actualState: liveState,
      };
    }

    // 5) Expire prior open decide tokens, then issue exactly one fresh set.
    const expired = await expireOpenWithdrawalDecisionTokens(client, {
      withdrawalId: input.withdrawalId,
      expectedState: input.expectedState,
      adminUserId: input.adminUserId,
      destinationId: input.destination.id,
    });
    if (input.hooks?.afterExpire !== undefined) {
      await input.hooks.afterExpire();
    }
    if (input.hooks?.beforeIssue !== undefined) {
      await input.hooks.beforeIssue();
    }

    const issued = await issueWithdrawalDecisionTokens(client, config, {
      adminUserId: input.adminUserId,
      withdrawalId: input.withdrawalId,
      expectedState: input.expectedState,
      environment: input.environment,
      destination: input.destination,
      ensurePublication: false,
    });

    if (expired.expiredCount > 0) {
      await insertWithdrawalAuditLog(client, {
        actionType: 'OWNER_REVIEW_TOKENS_SUPERSEDED',
        resourceType: 'withdrawal',
        resourceId: input.withdrawalId,
        actorType: 'SYSTEM',
        reason: 'retry_or_resend_invalidated_open_tokens',
        afterSnapshot: {
          expiredCount: expired.expiredCount,
          expectedState: input.expectedState,
          destinationId: input.destination.id,
        },
      });
    }

    return {
      kind: 'issued',
      publicationId: locked.id,
      expiredCount: expired.expiredCount,
      issued,
    };
  });
}

/**
 * Post-send linearization: only the still-current token generation may PUBLISH + DISPATCH.
 */
async function finalizeOwnerReviewDeliveryAfterSend(
  pool: Pool,
  input: {
    readonly publicationId: string;
    readonly outboxEventId: string;
    readonly withdrawalId: string;
    readonly expectedState: 'MANUAL_REVIEW';
    readonly adminUserId: string;
    readonly destinationId: string;
    readonly generationTokenIds: ReadonlyArray<string>;
    readonly telegramMessageId: string;
  },
): Promise<FinalizeAfterSendResult> {
  return withWithdrawalTransaction(pool, async (client) => {
    await client.query(
      `SELECT id FROM telegram_publications WHERE id = $1::uuid FOR UPDATE`,
      [input.publicationId],
    );

    const pub = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM telegram_publications WHERE id = $1::uuid`,
      [input.publicationId],
    );
    const status = pub.rows[0]?.status;
    if (status === undefined) {
      throw new ControlCenterError('INTERNAL', undefined, {
        details: { reason: 'APPROVALS_PUBLICATION_MISSING_AT_FINALIZE' },
      });
    }

    if (status === 'PUBLISHED') {
      // Another finalized generation already published — do not overwrite message id.
      await markOutboxDispatched(client, input.outboxEventId);
      return { kind: 'already_published' };
    }

    const current = await isCurrentDecisionTokenGeneration(client, {
      withdrawalId: input.withdrawalId,
      expectedState: input.expectedState,
      adminUserId: input.adminUserId,
      destinationId: input.destinationId,
      generationTokenIds: input.generationTokenIds,
    });
    if (!current) {
      // Stale Telegram success — leave publication/outbox retryable for the newer generation.
      return { kind: 'stale_generation' };
    }

    await markPublicationPublished(client, input.publicationId, input.telegramMessageId);
    await markOutboxDispatched(client, input.outboxEventId);
    await insertWithdrawalAuditLog(client, {
      actionType: 'OWNER_REVIEW_APPROVALS_DELIVERED',
      resourceType: 'withdrawal',
      resourceId: input.withdrawalId,
      actorType: 'SYSTEM',
      afterSnapshot: {
        outboxEventId: input.outboxEventId,
        publicationId: input.publicationId,
        telegramMessageId: input.telegramMessageId,
        expectedState: input.expectedState,
        generationTokenIds: input.generationTokenIds,
        // Never include raw tokens.
      },
    });
    return { kind: 'finalized' };
  });
}

/**
 * Claim and deliver PENDING withdrawal.owner_review_required events.
 */
export async function processOwnerReviewRequiredOutboxBatch(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  _engineConfig: WithdrawalEngineConfig,
  telegram: ApprovalsTelegramSender,
  options?: {
    readonly limit?: number;
    readonly environment?: ControlCenterEnvironment;
    /** Test-only: skip claim and process these events (lease-overlap simulation). */
    readonly claimedEvents?: ReadonlyArray<OwnerReviewOutboxEventInput>;
    /** Test-only serialization barriers. */
    readonly serializationHooks?: OwnerReviewSerializationHooks;
  },
): Promise<ProcessOwnerReviewRequiredBatchResult> {
  void _engineConfig;
  const environment = options?.environment ?? config.deploymentEnvironment;
  const limit = options?.limit ?? 20;
  let delivered = 0;
  let superseded = 0;
  let retried = 0;

  const claimedEvents =
    options?.claimedEvents !== undefined
      ? [...options.claimedEvents]
      : await withWithdrawalTransaction(pool, async (client) =>
          claimPendingOwnerReviewRequiredEvents(client, limit),
        );
  const claimed = claimedEvents.length;

  for (const event of claimedEvents) {
    try {
      const outcome = await deliverOneOwnerReviewEvent(
        pool,
        config,
        telegram,
        event,
        environment,
        options?.serializationHooks,
      );
      if (outcome === 'delivered') delivered += 1;
      else superseded += 1;
    } catch (error) {
      await withWithdrawalTransaction(pool, async (client) => {
        await markOutboxRetry(client, event.id, error);
      });
      retried += 1;
    }
  }

  return { claimed, delivered, superseded, retried };
}

async function deliverOneOwnerReviewEvent(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  telegram: ApprovalsTelegramSender,
  event: OwnerReviewOutboxEventInput,
  environment: ControlCenterEnvironment,
  hooks?: OwnerReviewSerializationHooks,
): Promise<'delivered' | 'superseded'> {
  const withdrawalId = resolveWithdrawalId(event.payload, event.aggregateId);
  const expectedState = resolveExpectedState(event.payload);

  const live = await pool.query<{ state: string }>(
    `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
    [withdrawalId],
  );
  const liveState = live.rows[0]?.state;
  if (liveState === undefined || liveState !== expectedState) {
    await withWithdrawalTransaction(pool, async (client) => {
      await markOutboxDispatched(client, event.id);
      await insertWithdrawalAuditLog(client, {
        actionType: 'OWNER_REVIEW_OUTBOX_SUPERSEDED',
        resourceType: 'withdrawal',
        resourceId: withdrawalId,
        actorType: 'SYSTEM',
        reason: 'expected_state_mismatch',
        afterSnapshot: {
          outboxEventId: event.id,
          expectedState,
          actualState: liveState ?? null,
        },
      });
    });
    return 'superseded';
  }

  const destination = await resolveDestination(pool, {
    environment,
    purpose: 'CONTROL_CENTER_APPROVALS',
  });
  if (!destination.enabled) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'DESTINATION_DISABLED', purpose: 'CONTROL_CENTER_APPROVALS' },
    });
  }

  const owner = await resolveAuthorizedOwnerForApprovals(pool, config, destination);

  const serialized = await replaceDecisionTokensUnderPublicationLock(pool, config, {
    withdrawalId,
    expectedState,
    environment,
    destination,
    adminUserId: owner.adminUserId,
    ...(hooks !== undefined ? { hooks } : {}),
  });

  if (serialized.kind === 'superseded') {
    await withWithdrawalTransaction(pool, async (client) => {
      await markOutboxDispatched(client, event.id);
      if (serialized.reason === 'expected_state_mismatch') {
        await insertWithdrawalAuditLog(client, {
          actionType: 'OWNER_REVIEW_OUTBOX_SUPERSEDED',
          resourceType: 'withdrawal',
          resourceId: withdrawalId,
          actorType: 'SYSTEM',
          reason: 'expected_state_mismatch',
          afterSnapshot: {
            outboxEventId: event.id,
            expectedState,
            actualState: serialized.actualState,
          },
        });
      }
    });
    return 'superseded';
  }

  const generationTokenIds = serialized.issued.map((row) => row.tokenId);
  const card = await buildWithdrawalApprovalsCard(pool, withdrawalId);
  // Pass a dedicated payload so scrubbing cannot affect caller-held references.
  const sendPayload: ApprovalsTelegramSendInput = {
    chatId: destination.chatId,
    topicThreadId: destination.topicThreadId,
    text: card.text,
    buttons: serialized.issued.map((row) => ({
      decision: row.decision,
      rawToken: row.rawToken,
    })),
  };
  let telegramMessageId: string;
  try {
    if (hooks?.beforeTelegramSend !== undefined) {
      await hooks.beforeTelegramSend();
    }
    const sent = await telegram.sendApprovalsCard(sendPayload);
    telegramMessageId = sent.telegramMessageId;
  } finally {
    for (const button of sendPayload.buttons) {
      (button as { rawToken: string }).rawToken = '';
    }
  }

  const finalized = await finalizeOwnerReviewDeliveryAfterSend(pool, {
    publicationId: serialized.publicationId,
    outboxEventId: event.id,
    withdrawalId,
    expectedState,
    adminUserId: owner.adminUserId,
    destinationId: destination.id,
    generationTokenIds,
    telegramMessageId,
  });

  if (finalized.kind === 'stale_generation') {
    // Stale card may exist in Telegram, but must not win publication/outbox finalization.
    return 'superseded';
  }

  return 'delivered';
}

export { redactOutboxError };
