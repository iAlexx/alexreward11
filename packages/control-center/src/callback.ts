import type { Pool } from 'pg';
import type { WithdrawalEngineConfig } from '@alex-rewards/withdrawals';

import { findAdminActionTokenByRaw } from './action-tokens.js';
import type { ControlCenterRuntimeConfig } from './config.js';
import { ControlCenterError, safeTelegramMessage } from './errors.js';
import {
  WITHDRAWAL_ACTION_TYPES,
  type ControlCenterCallbackResult,
  type ControlCenterCallbackUpdate,
} from './types.js';
import { executeWithdrawalDecisionFromToken } from './withdrawal-actions.js';

function isWithdrawalAction(actionType: string): boolean {
  return (
    actionType === WITHDRAWAL_ACTION_TYPES.APPROVE ||
    actionType === WITHDRAWAL_ACTION_TYPES.HOLD ||
    actionType === WITHDRAWAL_ACTION_TYPES.REJECT
  );
}

/**
 * Opaque callback_data = raw action token only (no trusted financial fields).
 */
export async function handleControlCenterCallback(
  pool: Pool,
  config: ControlCenterRuntimeConfig,
  engineConfig: WithdrawalEngineConfig,
  update: ControlCenterCallbackUpdate,
): Promise<ControlCenterCallbackResult> {
  try {
    const rawToken = update.callbackData.trim();
    if (rawToken.length < 16 || rawToken.length > 64) {
      throw new ControlCenterError('VALIDATION');
    }
    // Peek action type without consuming — hash lookup only.
    const peeked = await findAdminActionTokenByRaw(pool, rawToken);
    if (peeked === null) {
      throw new ControlCenterError('NOT_AUTHORIZED');
    }

    if (isWithdrawalAction(peeked.actionType)) {
      const result = await executeWithdrawalDecisionFromToken(pool, config, engineConfig, {
        rawToken,
        telegramUserId: update.telegramUserId,
        chatId: update.chatId,
        topicThreadId: update.topicThreadId,
        environment: config.deploymentEnvironment,
      });
      if (result.alreadyProcessed) {
        return {
          ok: true,
          telegramText: safeTelegramMessage('ALREADY_PROCESSED'),
          alreadyProcessed: true,
          actionType: peeked.actionType,
          resourceId: peeked.resourceId,
        };
      }
      return {
        ok: true,
        telegramText: `Decision ${result.decision ?? ''} accepted.`,
        actionType: peeked.actionType,
        resourceId: peeked.resourceId,
        alreadyProcessed: false,
      };
    }

    throw new ControlCenterError('ACTION_UNAVAILABLE', undefined, {
      details: { reason: 'UNSUPPORTED_ACTION_TYPE', actionType: peeked.actionType },
    });
  } catch (error) {
    if (error instanceof ControlCenterError) {
      return { ok: false, telegramText: error.toTelegramMessage() };
    }
    return { ok: false, telegramText: safeTelegramMessage('INTERNAL') };
  }
}
