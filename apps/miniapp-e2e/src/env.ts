/**
 * Phase 12 browser E2E environment constants.
 * Isolated DB only — never operational alex_rewards / production.
 */

export const PHASE12_E2E_FLAG = 'PHASE12_E2E';

export const DEFAULT_PHASE12_DATABASE_URL =
  'postgresql://alex_rewards:local-alex-rewards-only@127.0.0.1:55432/alex_rewards_phase12_e2e';

/** Local-only HMAC bot token — matches .env.example / CI e2e job. */
export const E2E_TELEGRAM_BOT_TOKEN = 'local-only-telegram-bot-token-for-dev';

export const E2E_SESSION_ACCESS_SECRET = 'local-only-session-access-secret-32b';

export const E2E_API_PORT = Number(process.env.PHASE12_E2E_API_PORT ?? '3012');
export const E2E_MINIAPP_PORT = Number(process.env.PHASE12_E2E_MINIAPP_PORT ?? '3010');

export const E2E_API_BASE_URL =
  process.env.PHASE12_E2E_API_BASE_URL ?? `http://127.0.0.1:${E2E_API_PORT}`;
export const E2E_MINIAPP_BASE_URL =
  process.env.PHASE12_E2E_MINIAPP_BASE_URL ?? `http://127.0.0.1:${E2E_MINIAPP_PORT}`;

export const E2E_REDIS_URL = process.env.PHASE12_E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/12';

/** Telegram user ids used by fixtures (string-safe). */
export const TELEGRAM_IDS = {
  standard: '912120000001',
  founder: '912120000002',
  other: '912120000003',
} as const;

/** Ledger seed amounts (atomic USDT base units). */
export const SEED_BALANCES = {
  available: '500000',
  pending: '100000',
  reserved: '50000',
} as const;

/** Withdrawal quote expectations from LOCKED_INITIAL_WITHDRAWAL. */
export const SEED_QUOTE = {
  requested: '200000',
  fee: '10000',
  net: '190000',
} as const;

export const FOUNDER_NUMBER = 42;

export function resolvePhase12DatabaseUrlFromEnv(): string {
  const explicit = process.env.PHASE12_DATABASE_URL?.trim() ?? '';
  if (explicit !== '') return explicit;
  return DEFAULT_PHASE12_DATABASE_URL;
}
