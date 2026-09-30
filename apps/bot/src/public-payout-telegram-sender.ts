import type { Api } from 'grammy';
import { GrammyError, HttpError, InlineKeyboard } from 'grammy';

import {
  PublicPayoutDefiniteFailureError,
  type PublicPayoutTelegramSender,
} from '@alex-rewards/withdrawals';

/**
 * Classify grammY/Telegram send failures for public payout delivery.
 * GrammyError = Telegram API definite rejection. HttpError / unknown = ambiguous.
 */
export function classifyPublicPayoutSenderError(
  error: unknown,
): 'DEFINITE_FAILURE' | 'AMBIGUOUS' {
  if (error instanceof PublicPayoutDefiniteFailureError) {
    return 'DEFINITE_FAILURE';
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'classification' in error &&
    (error as { classification?: unknown }).classification === 'DEFINITE_FAILURE'
  ) {
    return 'DEFINITE_FAILURE';
  }
  if (error instanceof GrammyError) {
    return 'DEFINITE_FAILURE';
  }
  if (error instanceof HttpError) {
    return 'AMBIGUOUS';
  }
  return 'AMBIGUOUS';
}

/**
 * Grammy-backed public payout sender.
 * Plain text only (no parse_mode). Inline keyboard: View Transaction URL.
 * Converts definite Telegram API rejections to PublicPayoutDefiniteFailureError.
 */
export function createGrammyPublicPayoutSender(api: Api): PublicPayoutTelegramSender {
  return {
    async sendPublicPayout(input) {
      const keyboard = new InlineKeyboard().url('View Transaction', input.explorerUrl);
      try {
        const message = await api.sendMessage(input.chatId, input.text, {
          ...(input.topicThreadId !== null
            ? { message_thread_id: input.topicThreadId }
            : {}),
          reply_markup: keyboard,
        });
        return { telegramMessageId: String(message.message_id) };
      } catch (error: unknown) {
        if (classifyPublicPayoutSenderError(error) === 'DEFINITE_FAILURE') {
          const detail =
            error instanceof GrammyError
              ? error.description
              : error instanceof Error
                ? error.message
                : 'telegram definite failure';
          throw new PublicPayoutDefiniteFailureError(detail);
        }
        throw error;
      }
    },
  };
}
