import type { Api } from 'grammy';
import { InlineKeyboard } from 'grammy';

import type { ApprovalsTelegramSendInput, ApprovalsTelegramSender } from '@alex-rewards/control-center';

/**
 * Grammy-backed Approvals card sender. Does not log callback_data / raw tokens.
 */
export function createGrammyApprovalsSender(api: Api): ApprovalsTelegramSender {
  return {
    async sendApprovalsCard(input: ApprovalsTelegramSendInput) {
      const keyboard = new InlineKeyboard();
      for (const button of input.buttons) {
        keyboard.text(button.decision, button.rawToken).row();
      }
      const message = await api.sendMessage(input.chatId, input.text, {
        ...(input.topicThreadId !== null
          ? { message_thread_id: Number(input.topicThreadId) }
          : {}),
        reply_markup: keyboard,
      });
      return { telegramMessageId: String(message.message_id) };
    },
  };
}
