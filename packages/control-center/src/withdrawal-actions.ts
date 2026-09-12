import type { Pool, PoolClient } from 'pg';
import {
  decideWithdrawal,
  type WithdrawalDecision,
  type WithdrawalEngineConfig,
} from '@alex-rewards/withdrawals';

import {
  issueAdminActionToken,
  markAdminActionTokenConsumed,
  validateAdminActionToken,
  expireOpenWithdrawalDecisionTokens,
} from './action-tokens.js';
import { authorizeOwnerAction } from './authorize.js';
import type { ControlCenterRuntimeConfig } from './config.js';
import { resolveDestination } from './destinations.js';
import { ControlCenterError } from './errors.js';
import { CONTROL_CENTER_PERMISSIONS } from './permissions.js';
import { enqueueTelegramPublication } from './publications.js';
import { ensureReviewCase, resolveReviewCaseAfterDomainSuccess } from './review-queue.js';
import {
  WITHDRAWAL_ACTION_TYPES,
  type ControlCenterEnvironment,
  type WithdrawalTelegramDecision,
} from './types.js';

type Db = Pool | PoolClient;

function truncateWallet(address: string | null | undefined): string | null {
  if (address === undefined || address === null || address.length < 10) return address ?? null;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export interface WithdrawalApprovalsCard {
  readonly withdrawalId: string;
  readonly userId: string;
  readonly state: string;
  readonly grossAtomic: string;
  readonly feeAtomic: string;
  readonly netAtomic: string;
  readonly networkCode: string | null;
  readonly walletTruncated: string | null;
  readonly accountAgeDays: number | null;
  readonly previousConfirmedWithdrawals: number | null;
  readonly riskTier: string | null;
  readonly requestedAt: string;
  readonly text: string;
}

export async function buildWithdrawalApprovalsCard(
  db: Db,
  withdrawalId: string,
): Promise<WithdrawalApprovalsCard> {
  const result = await db.query<{
    id: string;
    user_id: string;
    state: string;
    gross_atomic: string;
    platform_fee_atomic: string;
    net_atomic: string;
    network_code: string | null;
    destination_address: string | null;
    risk_tier: string | null;
    created_at: Date;
    user_created_at: Date;
  }>(
    `SELECT w.id, w.user_id, w.state,
            w.requested_amount_atomic::text AS gross_atomic,
            w.fee_amount_atomic::text AS platform_fee_atomic,
            w.net_amount_atomic::text AS net_atomic,
            n.code AS network_code,
            uw.friendly_address AS destination_address,
            u.risk_tier::text AS risk_tier,
            w.requested_at AS created_at,
            u.created_at AS user_created_at
     FROM withdrawals w
     INNER JOIN users u ON u.id = w.user_id
     INNER JOIN networks n ON n.id = w.network_id
     INNER JOIN user_wallets uw ON uw.id = w.wallet_id
     WHERE w.id = $1::uuid`,
    [withdrawalId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'WITHDRAWAL_NOT_FOUND' },
    });
  }

  const confirmed = await db.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM withdrawals
     WHERE user_id = $1::uuid AND state = 'CONFIRMED'`,
    [row.user_id],
  );

  const ageMs = Date.now() - row.user_created_at.getTime();
  const accountAgeDays = Math.max(0, Math.floor(ageMs / 86_400_000));

  const base = {
    withdrawalId: row.id,
    userId: row.user_id,
    state: row.state,
    grossAtomic: row.gross_atomic,
    feeAtomic: row.platform_fee_atomic,
    netAtomic: row.net_atomic,
    networkCode: row.network_code,
    walletTruncated: truncateWallet(row.destination_address),
    accountAgeDays,
    previousConfirmedWithdrawals: confirmed.rows[0]?.c ?? 0,
    riskTier: row.risk_tier,
    requestedAt: row.created_at.toISOString(),
  };

  const text = [
    'Withdrawal review',
    `ID: ${base.withdrawalId}`,
    `User: ${base.userId}`,
    `Gross: ${base.grossAtomic}`,
    `Fee: ${base.feeAtomic}`,
    `Net: ${base.netAtomic}`,
    `Network: ${base.networkCode ?? 'unavailable'}`,
    `Wallet: ${base.walletTruncated ?? 'unavailable'}`,
    `Account age (days): ${String(base.accountAgeDays)}`,
    `Prior confirmed: ${String(base.previousConfirmedWithdrawals)}`,
    `Risk: ${base.riskTier ?? 'unavailable'}`,
    `Requested: ${base.requestedAt}`,
    `State: ${base.state}`,
  ].join('\n');

  return { ...base, text };
}

export async function issueWithdrawalDecisionTokens(
  db: Db,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly adminUserId: string;
    readonly withdrawalId: string;
    readonly expectedState: string;
    readonly environment: ControlCenterEnvironment;
    /**
     * When provided, skip destination resolve (caller already authorized against it).
     */
    readonly destination?: {
      readonly id: string;
      readonly chatId: string;
      readonly topicThreadId: string | null;
    };
    /**
     * When false, caller already ensured the Approvals publication under lock.
     * Default true preserves prior enqueue behavior for direct callers/tests.
     */
    readonly ensurePublication?: boolean;
  },
): Promise<
  ReadonlyArray<{ decision: WithdrawalTelegramDecision; rawToken: string; tokenId: string }>
> {
  const destination =
    input.destination ??
    (await resolveDestination(db, {
      environment: input.environment,
      purpose: 'CONTROL_CENTER_APPROVALS',
    }));
  const decisions: WithdrawalTelegramDecision[] = ['APPROVE', 'HOLD', 'REJECT'];
  const issued: Array<{
    decision: WithdrawalTelegramDecision;
    rawToken: string;
    tokenId: string;
  }> = [];
  for (const decision of decisions) {
    const actionType = WITHDRAWAL_ACTION_TYPES[decision];
    const { rawToken, token } = await issueAdminActionToken(db, config, {
      adminUserId: input.adminUserId,
      actionType,
      resourceType: 'withdrawal',
      resourceId: input.withdrawalId,
      expectedState: input.expectedState,
      destinationId: destination.id,
      boundChatId: destination.chatId,
      boundTopicThreadId: destination.topicThreadId,
      requiresSecondConfirmation: false,
    });
    issued.push({ decision, rawToken, tokenId: token.id });
  }

  await ensureReviewCase(db, {
    caseType: 'WITHDRAWAL_REVIEW',
    resourceType: 'withdrawal',
    resourceId: input.withdrawalId,
    summary: `Withdrawal ${input.withdrawalId} awaiting Owner decision`,
    adminUserId: input.adminUserId,
  });

  if (input.ensurePublication !== false) {
    await enqueueTelegramPublication(db, {
      destinationId: destination.id,
      subjectType: 'withdrawal',
      subjectId: input.withdrawalId,
      messageKind: 'approvals_card',
    });
  }

  return issued;
}

function decisionFromActionType(actionType: string): WithdrawalDecision {
  if (actionType === WITHDRAWAL_ACTION_TYPES.APPROVE) return 'APPROVE';
  if (actionType === WITHDRAWAL_ACTION_TYPES.HOLD) return 'HOLD';
  if (actionType === WITHDRAWAL_ACTION_TYPES.REJECT) return 'REJECT';
  throw new ControlCenterError('VALIDATION', undefined, {
    details: { reason: 'UNKNOWN_WITHDRAWAL_ACTION' },
  });
}

export async function executeWithdrawalDecisionFromToken(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  engineConfig: WithdrawalEngineConfig,
  input: {
    readonly rawToken: string;
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly topicThreadId: string | null;
    readonly environment: ControlCenterEnvironment;
    readonly reason?: string;
  },
): Promise<{
  readonly alreadyProcessed: boolean;
  readonly decision?: WithdrawalDecision;
  readonly withdrawalId?: string;
  readonly state?: string;
}> {
  const owner = await authorizeOwnerAction(pool, config, {
    telegramUserId: input.telegramUserId,
    permissionCode: CONTROL_CENTER_PERMISSIONS.WITHDRAWAL_REVIEW_DECIDE,
    chatId: input.chatId,
    topicThreadId: input.topicThreadId,
    environment: input.environment,
  });

  // Validate without consuming so a failed domain command does not burn the token.
  const validated = await validateAdminActionToken(pool, {
    rawToken: input.rawToken,
    actorAdminUserId: owner.adminUserId,
    chatId: input.chatId,
    topicThreadId: input.topicThreadId,
  });

  if (validated.alreadyProcessed) {
    return { alreadyProcessed: true };
  }

  const token = validated.token;
  if (token.resourceType !== 'withdrawal' || token.resourceId === null) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'NOT_WITHDRAWAL_TOKEN' },
    });
  }
  if (token.expectedState === null) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'MISSING_EXPECTED_STATE' },
    });
  }

  // Compare expected_state from stored token against authoritative withdrawal row.
  const live = await pool.query<{ state: string }>(
    `SELECT state FROM withdrawals WHERE id = $1::uuid`,
    [token.resourceId],
  );
  const liveState = live.rows[0]?.state;
  if (liveState === undefined) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'WITHDRAWAL_NOT_FOUND' },
    });
  }
  if (liveState !== token.expectedState) {
    throw new ControlCenterError('STATE_CHANGED', undefined, {
      details: { expected: token.expectedState, actual: liveState },
    });
  }

  const decision = decisionFromActionType(token.actionType);

  // Phase 7 owns its transaction. Idempotency key binds to action-token id so
  // retries after Telegram timeout cannot duplicate Outbox/workflow.
  const decided = await decideWithdrawal(pool, engineConfig, {
    withdrawalId: token.resourceId,
    expectedState: token.expectedState as never,
    decision,
    reason: input.reason ?? `telegram:${decision}`,
    idempotencyKey: `aat:${token.id}`,
    trustedOwnerActorContext: { adminUserId: owner.adminUserId },
    decisionSource: 'TELEGRAM',
  });

  await markAdminActionTokenConsumed(pool, {
    tokenId: token.id,
    adminUserId: owner.adminUserId,
  });

  // Sibling Approve/Hold/Reject buttons must no longer be actionable.
  await expireOpenWithdrawalDecisionTokens(pool, {
    withdrawalId: token.resourceId,
    expectedState: token.expectedState,
    adminUserId: owner.adminUserId,
    destinationId: token.destinationId,
    excludeTokenId: token.id,
  });

  const review = await ensureReviewCase(pool, {
    caseType: 'WITHDRAWAL_REVIEW',
    resourceType: 'withdrawal',
    resourceId: token.resourceId,
    adminUserId: owner.adminUserId,
  });

  await resolveReviewCaseAfterDomainSuccess(pool, {
    reviewCaseId: review.id,
    adminUserId: owner.adminUserId,
    disposition: 'RESOLVED',
    resolutionNotes: `Decision ${decision}`,
    domainSucceeded: true,
    actionInvoked: token.actionType,
  });

  return {
    alreadyProcessed: false,
    decision: decided.decision,
    withdrawalId: decided.withdrawalId,
    state: decided.state,
  };
}
