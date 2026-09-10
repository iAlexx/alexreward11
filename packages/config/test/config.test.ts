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

const remoteAuthPolicy = {
  SESSION_ACCESS_TTL_SECONDS: '900',
  SESSION_REFRESH_TTL_SECONDS: '2592000',
  INITDATA_MAX_AGE_SECONDS: '86400',
  CORS_ORIGINS: 'https://miniapp.example.com',
  AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
  AUTH_RATE_LIMIT_MAX: '30',
  CLAIM_RATE_LIMIT_WINDOW_SECONDS: '300',
  CLAIM_RATE_LIMIT_MAX: '10',
  WITHDRAWAL_QUOTE_TTL_SECONDS: '600',
  WITHDRAWAL_RISK_POLICY_VERSION: '2',
  WITHDRAWAL_NETWORK_CODE: 'TON',
  WITHDRAWAL_ASSET_SYMBOL: 'USDT',
  WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
} as const;

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

  it('applies local auth-policy defaults when unset', () => {
    const config = loadApiConfig({
      ...common,
      ...apiAuth,
      DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      TEMPORAL_ADDRESS: 'localhost:7233',
    });
    expect(config.SESSION_ACCESS_TTL_SECONDS).toBe(900);
    expect(config.SESSION_REFRESH_TTL_SECONDS).toBe(2_592_000);
    expect(config.INITDATA_MAX_AGE_SECONDS).toBe(86_400);
    expect(config.AUTH_RATE_LIMIT_MAX).toBe(30);
    expect(config.CLAIM_RATE_LIMIT_MAX).toBe(10);
    expect(config.CORS_ORIGINS).toEqual([]);
    expect(config.WITHDRAWAL_QUOTE_TTL_SECONDS).toBe(300);
    expect(config.WITHDRAWAL_RISK_POLICY_VERSION).toBe(1);
    expect(config.WITHDRAWAL_NETWORK_CODE).toBe('TON_TESTNET');
    expect(config.WITHDRAWAL_ASSET_SYMBOL).toBe('USDT');
    expect(config.WITHDRAWAL_FAKE_CHAIN_ENABLED).toBe(true);
  });

  it('requires a Telegram token only when transport is enabled', () => {
    expect(() => loadBotConfig({ ...common, BOT_TRANSPORT_MODE: 'polling' })).toThrow(
      /TELEGRAM_BOT_TOKEN/,
    );
    expect(loadBotConfig({ ...common, BOT_TRANSPORT_MODE: 'disabled' }).BOT_TRANSPORT_MODE).toBe(
      'disabled',
    );
  });

  it('accepts Phase 9 local_ephemeral signer config and rejects AWS/plaintext signer env', () => {
    const config = loadSignerConfig({
      ...common,
      SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
    });
    expect(config.SIGNER_KEY_MODE).toBe('local_ephemeral');
    expect(config.SIGNER_NETWORK_GLOBAL_ID).toBe(-3);
    expect(() =>
      loadSignerConfig({
        ...common,
        SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
        SIGNER_KMS_KEY_ARN: 'kms-key-must-not-exist-in-phase-one',
      }),
    ).toThrow(/SIGNER_KMS_KEY_ARN/);
    expect(() =>
      loadSignerConfig({
        ...common,
        SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
        SIGNER_PRIVATE_KEY: 'forbidden',
      }),
    ).toThrow(/SIGNER_PRIVATE_KEY/);
  });

  it('forbids AWS_KMS_KEY_ID alias at the signer boundary', () => {
    expect(() =>
      loadSignerConfig({
        ...common,
        SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
        AWS_KMS_KEY_ID: 'alias-forbidden',
      }),
    ).toThrow(/AWS_KMS_KEY_ID/);
  });

  it('requires bundle path for self_hosted_encrypted and rejects plaintext passphrase env', () => {
    expect(() =>
      loadSignerConfig({
        ...common,
        SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
        SIGNER_KEY_MODE: 'self_hosted_encrypted',
      }),
    ).toThrow(/SIGNER_KEY_BUNDLE_PATH/);
    expect(() =>
      loadSignerConfig({
        ...common,
        SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
        SIGNER_KEY_PASSPHRASE: 'never-store-passphrase-in-env',
      }),
    ).toThrow(/SIGNER_KEY_PASSPHRASE/);
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
        ...remoteAuthPolicy,
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it('fails closed when production omits auth-policy values', () => {
    expect(() =>
      loadApiConfig({
        DEPLOYMENT_ENV: 'production',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'production-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'production-grade-session-access-secret',
      }),
    ).toThrow(/SESSION_ACCESS_TTL_SECONDS|INITDATA_MAX_AGE_SECONDS|CORS_ORIGINS|AUTH_RATE_LIMIT/);
  });

  it('fails closed when staging omits auth-policy values', () => {
    expect(() =>
      loadApiConfig({
        DEPLOYMENT_ENV: 'staging',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'staging-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'staging-grade-session-access-secret!!',
      }),
    ).toThrow(/SESSION_ACCESS_TTL_SECONDS|INITDATA_MAX_AGE_SECONDS|CORS_ORIGINS|AUTH_RATE_LIMIT/);
  });

  it('rejects empty CORS_ORIGINS outside local/test', () => {
    expect(() =>
      loadApiConfig({
        DEPLOYMENT_ENV: 'production',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'production-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'production-grade-session-access-secret',
        ...remoteAuthPolicy,
        CORS_ORIGINS: '',
      }),
    ).toThrow(/CORS_ORIGINS/);
  });

  it('accepts explicit synthetic staging/production auth-policy values', () => {
    const config = loadApiConfig({
      DEPLOYMENT_ENV: 'staging',
      NODE_ENV: 'production',
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
      SENTRY_DSN: 'https://public@example.com/1',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
      REDIS_URL: 'rediss://redis.example.com:6379',
      TEMPORAL_ADDRESS: 'temporal.example.com:7233',
      TELEGRAM_BOT_TOKEN: 'staging-grade-telegram-bot-token-value',
      SESSION_ACCESS_SECRET: 'staging-grade-session-access-secret!!',
      ...remoteAuthPolicy,
    });
    expect(config.SESSION_ACCESS_TTL_SECONDS).toBe(900);
    expect(config.CORS_ORIGINS).toEqual(['https://miniapp.example.com']);
    expect(config.WITHDRAWAL_NETWORK_CODE).toBe('TON');
    expect(config.WITHDRAWAL_QUOTE_TTL_SECONDS).toBe(600);
    expect(config.WITHDRAWAL_FAKE_CHAIN_ENABLED).toBe(false);
  });

  it('fails closed when staging omits withdrawal keys', () => {
    expect(() =>
      loadApiConfig({
        DEPLOYMENT_ENV: 'staging',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'staging-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'staging-grade-session-access-secret!!',
        SESSION_ACCESS_TTL_SECONDS: '900',
        SESSION_REFRESH_TTL_SECONDS: '2592000',
        INITDATA_MAX_AGE_SECONDS: '86400',
        CORS_ORIGINS: 'https://miniapp.example.com',
        AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
        AUTH_RATE_LIMIT_MAX: '30',
        CLAIM_RATE_LIMIT_WINDOW_SECONDS: '300',
        CLAIM_RATE_LIMIT_MAX: '10',
      }),
    ).toThrow(/WITHDRAWAL_/);
  });

  it('fails closed when production omits withdrawal keys', () => {
    expect(() =>
      loadApiConfig({
        DEPLOYMENT_ENV: 'production',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'production-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'production-grade-session-access-secret',
        SESSION_ACCESS_TTL_SECONDS: '900',
        SESSION_REFRESH_TTL_SECONDS: '2592000',
        INITDATA_MAX_AGE_SECONDS: '86400',
        CORS_ORIGINS: 'https://miniapp.example.com',
        AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
        AUTH_RATE_LIMIT_MAX: '30',
        CLAIM_RATE_LIMIT_WINDOW_SECONDS: '300',
        CLAIM_RATE_LIMIT_MAX: '10',
      }),
    ).toThrow(/WITHDRAWAL_/);
  });

  it('rejects production inheriting TON_TESTNET withdrawal network', () => {
    expect(() =>
      loadApiConfig({
        DEPLOYMENT_ENV: 'production',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'production-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'production-grade-session-access-secret',
        ...remoteAuthPolicy,
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
      }),
    ).toThrow(/WITHDRAWAL_NETWORK_CODE|TON_TESTNET/);
  });

  it('rejects fake chain enabled in staging/production', () => {
    expect(() =>
      loadApiConfig({
        DEPLOYMENT_ENV: 'staging',
        NODE_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
        REDIS_URL: 'rediss://redis.example.com:6379',
        TEMPORAL_ADDRESS: 'temporal.example.com:7233',
        TELEGRAM_BOT_TOKEN: 'staging-grade-telegram-bot-token-value',
        SESSION_ACCESS_SECRET: 'staging-grade-session-access-secret!!',
        ...remoteAuthPolicy,
        WITHDRAWAL_FAKE_CHAIN_ENABLED: 'true',
      }),
    ).toThrow(/WITHDRAWAL_FAKE_CHAIN_ENABLED|fake payout/);
  });

  it('accepts only explicitly public web configuration', () => {
    const config = loadWebConfig({
      NODE_ENV: 'test',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
    });
    expect(Object.keys(config).sort()).toEqual(['NEXT_PUBLIC_API_BASE_URL', 'NODE_ENV']);
  });
});
