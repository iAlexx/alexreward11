/**
 * Telegram polling and Owner-review delivery start only when transport is polling
 * and a bot token is present. Disabled transport never arms that path.
 */
export function shouldStartTelegramControlCenter(
  transportMode: 'disabled' | 'polling',
  telegramBotToken: string | undefined,
): telegramBotToken is string {
  return transportMode === 'polling' && telegramBotToken !== undefined;
}
