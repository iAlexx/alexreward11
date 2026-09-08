import { describe, expect, it } from 'vitest';

import { loadApiConfig, loadBotConfig, loadSignerConfig, loadWebConfig } from '../src/index.js';

const common = {
  DEPLOYMENT_ENV: 'local',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  OTEL_ENABLED: 'false',
};

const apiAuth = {
  TELEGRAM_BOT_TOKEN: 'local-only-telegram-bot-token-for-tests',
  SESSION_ACCESS_SECRET: 'local-only-session-access-secret-32b',
};

describe('environment validation', () => {
  it('fails fast when an API dependency is missing', () => {
    expect(() =>
      loadApiConfig({
        ...common,
        ...apiAuth,
        REDIS_URL: 'redis://localhost:6379',
        TEMPORAL_ADDRESS: 'localhost:7233',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('requires Telegram bot token and session access secret for the API', () => {
    expect(() =>
      loadApiConfig({
        ...common,
        DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        TEMPORAL_ADDRESS: 'localhost:7233',
      }),
    ).toThrow(/TELEGRAM_BOT_TOKEN|SESSION_ACCESS_SECRET/);
  });

  it('requires a Telegram token only when transport is enabled', () => {
    expect(() => loadBotConfig({ ...common, BOT_TRANSPORT_MODE: 'polling' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    expect(loadBotConfig({ ...common, BOT_TRANSPORT_MODE: 'disabled' }).BOT_TRANSPORT_MODE).toBe(
      'disabled',
    );
  });

  it('forbids every Phase 1 KMS key input at the signer boundary', () => {
    expect(() =>
      loadSignerConfig({
        ...common,
        SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
        SIGNER_KMS_KEY_ARN: 'kms-key-must-not-exist-in-phase-one',
      }),
    ).toThrow(/SIGNER_KMS_KEY_ARN/);
  });

  it('rejects local dependency endpoints in production', () => {
    expect(() =>
      loadApiConfig({
        ...common,
        DEPLOYMENT_ENV: 'production',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'production-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'production-grade-session-access-secret',
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('accepts only explicitly public web configuration', () => {
    const config = loadWebConfig({
      NODE_ENV: 'test',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
    });
    expect(Object.keys(config).sort()).toEqual(['NEXT_PUBLIC_API_BASE_URL', 'NODE_ENV']);
  });
});
