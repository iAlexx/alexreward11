import { describe, expect, it } from 'vitest';

import { loadBotConfig } from '@alex-rewards/config';

import { controlCenterConfigFromBot, localControlCenterFixtureConfig } from '../src/index.js';

const common = {
  DEPLOYMENT_ENV: 'local',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  OTEL_ENABLED: 'false',
};

const withdrawalLocal = {
  WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
  WITHDRAWAL_RISK_POLICY_VERSION: '1',
  WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
  WITHDRAWAL_ASSET_SYMBOL: 'USDT',
  WITHDRAWAL_FAKE_CHAIN_ENABLED: 'true',
} as const;

describe('Phase 8 bot / control-center config', () => {
  it('applies local Control Center TTL and allowlist defaults', () => {
    const bot = loadBotConfig({ ...common, BOT_TRANSPORT_MODE: 'disabled' });
    expect(bot.CONTROL_CENTER_ACTION_TOKEN_TTL_SECONDS).toBe(900);
    expect(bot.CONTROL_CENTER_CONFIRM_TOKEN_TTL_SECONDS).toBe(300);
    expect(bot.CONTROL_CENTER_RATE_LIMIT_WINDOW_SECONDS).toBe(60);
    expect(bot.CONTROL_CENTER_RATE_LIMIT_MAX).toBe(30);
    expect(bot.ownerTelegramUserIds).toEqual(['900001']);
    expect(bot.DATABASE_URL).toBeUndefined();
  });

  it('requires DATABASE_URL when transport enabled', () => {
    expect(() =>
      loadBotConfig({
        ...common,
        BOT_TRANSPORT_MODE: 'polling',
        TELEGRAM_BOT_TOKEN: 'local-only-telegram-bot-token-for-tests',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('requires Owner allowlist outside local/test', () => {
    expect(() =>
      loadBotConfig({
        ...common,
        DEPLOYMENT_ENV: 'staging',
        BOT_TRANSPORT_MODE: 'polling',
        TELEGRAM_BOT_TOKEN: 'staging-telegram-bot-token-long-enough',
        DATABASE_URL: 'postgresql://alex:secret@db.example.com:5432/alex',
        CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS: '',
        CONTROL_CENTER_ACTION_TOKEN_TTL_SECONDS: '600',
        CONTROL_CENTER_CONFIRM_TOKEN_TTL_SECONDS: '120',
        CONTROL_CENTER_RATE_LIMIT_WINDOW_SECONDS: '60',
        CONTROL_CENTER_RATE_LIMIT_MAX: '20',
        WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
        WITHDRAWAL_RISK_POLICY_VERSION: '1',
        WITHDRAWAL_NETWORK_CODE: 'TON',
        WITHDRAWAL_ASSET_SYMBOL: 'USDT',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://sentry.example.com/1',
      }),
    ).toThrow(/Owner Telegram allowlist|CONTROL_CENTER_OWNER/);
  });

  it('fails closed staging without TTL defaults (explicit required)', () => {
    expect(() =>
      loadBotConfig({
        ...common,
        DEPLOYMENT_ENV: 'production',
        BOT_TRANSPORT_MODE: 'polling',
        TELEGRAM_BOT_TOKEN: 'production-telegram-bot-token-long',
        DATABASE_URL: 'postgresql://alex:secret@db.example.com:5432/alex',
        CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS: '123456789',
        ...withdrawalLocal,
        WITHDRAWAL_NETWORK_CODE: 'TON',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://sentry.example.com/1',
      }),
    ).toThrow(/CONTROL_CENTER_ACTION_TOKEN_TTL_SECONDS|Invalid environment/);
  });

  it('maps bot config into ControlCenterRuntimeConfig', () => {
    const bot = loadBotConfig({
      ...common,
      BOT_TRANSPORT_MODE: 'disabled',
      DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
    });
    const runtime = controlCenterConfigFromBot(bot);
    expect(runtime.ownerTelegramUserIds.has('900001')).toBe(true);
    expect(runtime.actionTokenTtlSeconds).toBe(900);
    expect(runtime.deploymentEnvironment).toBe('LOCAL');
    expect(localControlCenterFixtureConfig(['1']).ownerTelegramUserIds.has('1')).toBe(true);
  });
});
