/**
 * Phase 13 Admin browser E2E environment constants.
 * Isolated DB only — never operational alex_rewards / production.
 */

export const PHASE13_ADMIN_E2E_FLAG = 'PHASE13_ADMIN_E2E';

export const DEFAULT_PHASE13_DATABASE_URL =
  'postgresql://alex_rewards:local-alex-rewards-only@127.0.0.1:55432/alex_rewards_phase13_e2e';

/** Local-only HMAC bot token — matches .env.example / CI e2e job. */
export const E2E_TELEGRAM_BOT_TOKEN = 'local-only-telegram-bot-token-for-dev';

export const E2E_SESSION_ACCESS_SECRET = 'local-only-session-access-secret-32b';

export const E2E_API_PORT = Number(process.env.PHASE13_ADMIN_E2E_API_PORT ?? '3032');
export const E2E_ADMIN_PORT = Number(process.env.PHASE13_ADMIN_E2E_ADMIN_PORT ?? '3031');

/**
 * Prefer localhost (not 127.0.0.1) so WebAuthn RP ID `localhost` matches the Admin origin.
 */
export const E2E_API_BASE_URL =
  process.env.PHASE13_ADMIN_E2E_API_BASE_URL ?? `http://localhost:${E2E_API_PORT}`;
export const E2E_ADMIN_BASE_URL =
  process.env.PHASE13_ADMIN_E2E_ADMIN_BASE_URL ?? `http://localhost:${E2E_ADMIN_PORT}`;

export const E2E_REDIS_URL = process.env.PHASE13_ADMIN_E2E_REDIS_URL ?? 'redis://127.0.0.1:6379/13';

export const E2E_OWNER_EMAIL = 'owner-phase13-e2e@local.test';
export const E2E_OWNER_PASSWORD = 'Owner-E2E-Password-13';

export const E2E_WEBAUTHN_RP_ID = 'localhost';
export const E2E_WEBAUTHN_ORIGIN = E2E_ADMIN_BASE_URL;
export const E2E_WEBAUTHN_RP_NAME = 'ALEx Rewards Owner Admin';

export function resolvePhase13DatabaseUrlFromEnv(): string {
  const explicit =
    process.env.PHASE13_ADMIN_E2E_DATABASE_URL?.trim() ||
    process.env.PHASE13_DATABASE_URL?.trim() ||
    '';
  if (explicit !== '') return explicit;
  return DEFAULT_PHASE13_DATABASE_URL;
}
