import {
  getFounderHistory,
  grantFounderMembership,
  issueFounderClaimCode,
  reassignFounderMembership,
  searchFounderMember,
} from '@alex-rewards/auth';
import type { Pool } from 'pg';

import { authorizeOwnerAction } from './authorize.js';
import type { ControlCenterRuntimeConfig } from './config.js';
import { ControlCenterError } from './errors.js';
import { CONTROL_CENTER_PERMISSIONS } from './permissions.js';
import type { ControlCenterEnvironment } from './types.js';

export async function ownerSearchFounderMember(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly topicThreadId: string | null;
    readonly environment: ControlCenterEnvironment;
    readonly query: {
      readonly founderNumber?: number;
      readonly userId?: string;
      readonly telegramUserId?: string;
      readonly membershipId?: string;
    };
  },
) {
  await authorizeOwnerAction(pool, config, {
    telegramUserId: input.telegramUserId,
    permissionCode: CONTROL_CENTER_PERMISSIONS.FOUNDER_SEARCH,
    chatId: input.chatId,
    topicThreadId: input.topicThreadId,
    environment: input.environment,
  });
  return searchFounderMember(pool, input.query);
}

export async function ownerGetFounderHistory(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly topicThreadId: string | null;
    readonly environment: ControlCenterEnvironment;
    readonly userId?: string;
    readonly founderNumber?: number;
  },
) {
  await authorizeOwnerAction(pool, config, {
    telegramUserId: input.telegramUserId,
    permissionCode: CONTROL_CENTER_PERMISSIONS.FOUNDER_HISTORY_VIEW,
    chatId: input.chatId,
    topicThreadId: input.topicThreadId,
    environment: input.environment,
  });
  return getFounderHistory(pool, {
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.founderNumber !== undefined ? { founderNumber: input.founderNumber } : {}),
  });
}

export async function ownerGrantFounderMembership(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly topicThreadId: string | null;
    readonly environment: ControlCenterEnvironment;
    readonly targetUserId: string;
    readonly reason: string;
    readonly paymentReferenceRedacted: string;
    readonly idempotencyKey?: string;
    readonly traceId?: string;
  },
) {
  const owner = await authorizeOwnerAction(pool, config, {
    telegramUserId: input.telegramUserId,
    permissionCode: CONTROL_CENTER_PERMISSIONS.FOUNDER_GRANT,
    chatId: input.chatId,
    topicThreadId: input.topicThreadId,
    environment: input.environment,
  });
  return grantFounderMembership(pool, {
    adminUserId: owner.adminUserId,
    userId: input.targetUserId,
    reason: input.reason,
    paymentReferenceRedacted: input.paymentReferenceRedacted,
    actorSource: 'TELEGRAM',
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  });
}

export async function ownerIssueFounderClaimCode(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  input: {
    readonly telegramUserId: string;
    readonly chatId: string;
    readonly topicThreadId: string | null;
    readonly environment: ControlCenterEnvironment;
    readonly expiresAt?: Date | null;
    readonly issuedForReference?: string;
    readonly reserveFounderNumber?: boolean;
    readonly traceId?: string;
  },
) {
  const owner = await authorizeOwnerAction(pool, config, {
    telegramUserId: input.telegramUserId,
    permissionCode: CONTROL_CENTER_PERMISSIONS.FOUNDER_CLAIM_CODE_ISSUE,
    chatId: input.chatId,
    topicThreadId: input.topicThreadId,
    environment: input.environment,
  });
  return issueFounderClaimCode(pool, {
    adminUserId: owner.adminUserId,
    actorSource: 'TELEGRAM',
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.issuedForReference !== undefined
      ? { issuedForReference: input.issuedForReference }
      : {}),
    ...(input.reserveFounderNumber !== undefined
      ? { reserveFounderNumber: input.reserveFounderNumber }
      : {}),
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
  });
}

/** Reassignment mutation unavailable until Owner reauthentication exists on Telegram boundary. */
export async function ownerReassignFounderMembership(): Promise<never> {
  try {
    await reassignFounderMembership();
  } catch (error) {
    throw new ControlCenterError('ACTION_UNAVAILABLE', undefined, {
      cause: error,
      details: { reason: 'FOUNDER_REASSIGNMENT_UNAVAILABLE' },
    });
  }
  throw new ControlCenterError('ACTION_UNAVAILABLE');
}
