import { defineConfig, devices } from '@playwright/test';

import {
  E2E_API_BASE_URL,
  E2E_API_PORT,
  E2E_MINIAPP_BASE_URL,
  E2E_MINIAPP_PORT,
  E2E_REDIS_URL,
  E2E_SESSION_ACCESS_SECRET,
  E2E_TELEGRAM_BOT_TOKEN,
  resolvePhase12DatabaseUrlFromEnv,
} from './src/env.js';

/**
 * Phase 12 browser E2E — Chromium against real API + Mini App + isolated Postgres.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  globalSetup: './src/global-setup.ts',
  use: {
    baseURL: E2E_MINIAPP_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @alex-rewards/api exec node dist/main.js`,
      url: `${E2E_API_BASE_URL}/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...process.env,
        DEPLOYMENT_ENV: 'test',
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        OTEL_ENABLED: 'false',
        DATABASE_URL: resolvePhase12DatabaseUrlFromEnv(),
        REDIS_URL: E2E_REDIS_URL,
        TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? '127.0.0.1:7233',
        API_PORT: String(E2E_API_PORT),
        TELEGRAM_BOT_TOKEN: E2E_TELEGRAM_BOT_TOKEN,
        SESSION_ACCESS_SECRET: E2E_SESSION_ACCESS_SECRET,
        SESSION_ACCESS_TTL_SECONDS: '900',
        SESSION_REFRESH_TTL_SECONDS: '2592000',
        INITDATA_MAX_AGE_SECONDS: '86400',
        CORS_ORIGINS: E2E_MINIAPP_BASE_URL,
        AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
        AUTH_RATE_LIMIT_MAX: '1000',
        CLAIM_RATE_LIMIT_WINDOW_SECONDS: '300',
        CLAIM_RATE_LIMIT_MAX: '100',
        WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
        WITHDRAWAL_RISK_POLICY_VERSION: '1',
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
        WITHDRAWAL_ASSET_SYMBOL: 'USDT',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: 'true',
        WALLET_TON_PROOF_DOMAIN: 'alex-rewards.local.test',
        WALLET_CHALLENGE_TTL_SECONDS: '300',
        WALLET_PROOF_MAX_AGE_SECONDS: '900',
        WALLET_PROOF_MAX_FUTURE_SKEW_SECONDS: '60',
        WALLET_PROOF_RATE_LIMIT_WINDOW_SECONDS: '300',
        WALLET_PROOF_RATE_LIMIT_MAX: '100',
        PHASE12_E2E: '1',
      },
    },
    {
      command: `pnpm --filter @alex-rewards/miniapp exec next start -p ${E2E_MINIAPP_PORT} -H 127.0.0.1`,
      url: `${E2E_MINIAPP_BASE_URL}/api/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(E2E_MINIAPP_PORT),
        NEXT_PUBLIC_API_BASE_URL: E2E_API_BASE_URL,
        PHASE12_E2E: '1',
      },
    },
  ],
});
