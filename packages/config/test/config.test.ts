import { describe, expect, it } from 'vitest';

import {
  loadApiConfig,
  loadBotConfig,
  loadPhase10TestnetProvisionConfig,
  loadSignerConfig,
  loadWebConfig,
  loadWorkerConfig,
} from '../src/index.js';

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
  WALLET_TON_PROOF_DOMAIN: 'miniapp.example.com',
  WALLET_CHALLENGE_TTL_SECONDS: '300',
  WALLET_PROOF_MAX_AGE_SECONDS: '900',
  WALLET_PROOF_MAX_FUTURE_SKEW_SECONDS: '60',
  WALLET_PROOF_RATE_LIMIT_WINDOW_SECONDS: '300',
  WALLET_PROOF_RATE_LIMIT_MAX: '10',
  ADMIN_WEBAUTHN_RP_ID: 'admin.example.com',
  ADMIN_WEBAUTHN_ORIGIN: 'https://admin.example.com',
  ADMIN_WEBAUTHN_RP_NAME: 'ALEx Rewards Owner Admin',
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

  it('accepts optional SIGNER_LISTEN_HOST for Docker-published signer ports', () => {
    const config = loadSignerConfig({
      ...common,
      SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
      SIGNER_KEY_MODE: 'self_hosted_encrypted',
      SIGNER_KEY_BUNDLE_PATH: '/run/alex-rewards/signer/hot-wallet.enc',
      SIGNER_LISTEN_HOST: '0.0.0.0',
    });
    expect(config.SIGNER_LISTEN_HOST).toBe('0.0.0.0');
    expect(() =>
      loadSignerConfig({
        ...common,
        SIGNER_SERVICE_TOKEN: 'a-secure-local-token-that-is-long-enough',
        SIGNER_LISTEN_HOST: '1.2.3.4',
      }),
    ).toThrow(/SIGNER_LISTEN_HOST/);
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
    expect(config.WALLET_TON_PROOF_DOMAIN).toBe('miniapp.example.com');
    expect(config.WALLET_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(config.ADMIN_WEBAUTHN_RP_ID).toBe('admin.example.com');
    expect(config.ADMIN_WEBAUTHN_ORIGIN).toBe('https://admin.example.com');
  });

  it('applies local wallet ownership defaults when unset', () => {
    const config = loadApiConfig({
      ...common,
      ...apiAuth,
      DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      TEMPORAL_ADDRESS: 'localhost:7233',
    });
    expect(config.WALLET_TON_PROOF_DOMAIN).toBe('alex-rewards.local.test');
    expect(config.WALLET_CHALLENGE_TTL_SECONDS).toBe(300);
    expect(config.WALLET_PROOF_MAX_AGE_SECONDS).toBe(900);
    expect(config.ADMIN_WEBAUTHN_RP_ID).toBe('localhost');
    expect(config.ADMIN_WEBAUTHN_ORIGIN).toBe('http://localhost:3001');
  });

  it('fails closed when production omits ADMIN_WEBAUTHN_RP_ID', () => {
    const { ADMIN_WEBAUTHN_RP_ID: _rp, ADMIN_WEBAUTHN_ORIGIN: _origin, ...withoutWebauthn } =
      remoteAuthPolicy;
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
        ...withoutWebauthn,
      }),
    ).toThrow(/ADMIN_WEBAUTHN/);
  });

  it('rejects a local ton_proof domain outside local/test', () => {
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
        TELEGRAM_BOT_TOKEN: 'production-grade-telegram-bot-token',
        SESSION_ACCESS_SECRET: 'production-grade-session-access-secret',
        ...remoteAuthPolicy,
        WITHDRAWAL_NETWORK_CODE: 'TON',
        WALLET_TON_PROOF_DOMAIN: 'alex-rewards.local.test',
      }),
    ).toThrow(/WALLET_TON_PROOF_DOMAIN|local ton_proof domains/);
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

  describe('STAGING_INTEGRATION_MODE', () => {
    const stagingBase = {
      DEPLOYMENT_ENV: 'staging',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
      REDIS_URL: 'rediss://redis.example.com:6379',
      TEMPORAL_ADDRESS: 'temporal.example.com:7233',
      TELEGRAM_BOT_TOKEN: 'staging-grade-telegram-bot-token-value',
      SESSION_ACCESS_SECRET: 'staging-grade-session-access-secret!!',
      ...remoteAuthPolicy,
      WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
      WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
    } as const;

    it('defaults STAGING_INTEGRATION_MODE to false', () => {
      const config = loadApiConfig({
        ...common,
        ...apiAuth,
        DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        TEMPORAL_ADDRESS: 'localhost:7233',
      });
      expect(config.STAGING_INTEGRATION_MODE).toBe(false);
    });

    it('refuses production with STAGING_INTEGRATION_MODE=true', () => {
      expect(() =>
        loadApiConfig({
          ...stagingBase,
          DEPLOYMENT_ENV: 'production',
          STAGING_INTEGRATION_MODE: 'true',
          OTEL_ENABLED: 'true',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
          SENTRY_DSN: 'https://public@example.com/1',
          WITHDRAWAL_NETWORK_CODE: 'TON',
        }),
      ).toThrow(/STAGING_INTEGRATION_MODE|DEPLOYMENT_ENV=staging/);
    });

    it('refuses local with STAGING_INTEGRATION_MODE=true', () => {
      expect(() =>
        loadApiConfig({
          ...common,
          ...apiAuth,
          STAGING_INTEGRATION_MODE: 'true',
          DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          TEMPORAL_ADDRESS: 'localhost:7233',
        }),
      ).toThrow(/STAGING_INTEGRATION_MODE|DEPLOYMENT_ENV=staging/);
    });

    it('refuses test with STAGING_INTEGRATION_MODE=true', () => {
      expect(() =>
        loadApiConfig({
          ...common,
          DEPLOYMENT_ENV: 'test',
          ...apiAuth,
          STAGING_INTEGRATION_MODE: 'true',
          DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          TEMPORAL_ADDRESS: 'localhost:7233',
        }),
      ).toThrow(/STAGING_INTEGRATION_MODE|DEPLOYMENT_ENV=staging/);
    });

    it('accepts staging + mode=true + TON_TESTNET + fake=false without OTEL/Sentry', () => {
      const config = loadApiConfig({
        ...stagingBase,
        STAGING_INTEGRATION_MODE: 'true',
        OTEL_ENABLED: 'false',
      });
      expect(config.STAGING_INTEGRATION_MODE).toBe(true);
      expect(config.DEPLOYMENT_ENV).toBe('staging');
      expect(config.WITHDRAWAL_NETWORK_CODE).toBe('TON_TESTNET');
      expect(config.WITHDRAWAL_FAKE_CHAIN_ENABLED).toBe(false);
      expect(config.OTEL_ENABLED).toBe(false);
      expect(config.SENTRY_DSN).toBeUndefined();
    });

    it('refuses staging + mode=true + MAINNET', () => {
      expect(() =>
        loadApiConfig({
          ...stagingBase,
          STAGING_INTEGRATION_MODE: 'true',
          OTEL_ENABLED: 'false',
          WITHDRAWAL_NETWORK_CODE: 'TON_MAINNET',
        }),
      ).toThrow(/MAINNET|TON_TESTNET/);
    });

    it('refuses staging + mode=true + fake chain enabled', () => {
      expect(() =>
        loadApiConfig({
          ...stagingBase,
          STAGING_INTEGRATION_MODE: 'true',
          OTEL_ENABLED: 'false',
          WITHDRAWAL_FAKE_CHAIN_ENABLED: 'true',
        }),
      ).toThrow(/WITHDRAWAL_FAKE_CHAIN_ENABLED|fake/);
    });

    it('keeps fail-closed staging + mode=false + TON_TESTNET', () => {
      expect(() =>
        loadApiConfig({
          ...stagingBase,
          STAGING_INTEGRATION_MODE: 'false',
          OTEL_ENABLED: 'true',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
          SENTRY_DSN: 'https://public@example.com/1',
          WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
        }),
      ).toThrow(/WITHDRAWAL_NETWORK_CODE|TON_TESTNET/);
    });

    it('still requires OTEL + Sentry in production', () => {
      expect(() =>
        loadApiConfig({
          ...stagingBase,
          DEPLOYMENT_ENV: 'production',
          STAGING_INTEGRATION_MODE: 'false',
          OTEL_ENABLED: 'false',
          WITHDRAWAL_NETWORK_CODE: 'TON',
        }),
      ).toThrow(/OTLP|SENTRY/);
    });

    it('still refuses local-only secrets under staging integration mode', () => {
      expect(() =>
        loadApiConfig({
          ...stagingBase,
          STAGING_INTEGRATION_MODE: 'true',
          OTEL_ENABLED: 'false',
          TELEGRAM_BOT_TOKEN: 'local-only-telegram-bot-token-for-tests',
          SESSION_ACCESS_SECRET: 'local-only-session-access-secret-32b',
        }),
      ).toThrow(/local-only/);
    });

    it('still refuses localhost Wallet/WebAuthn under staging integration mode', () => {
      expect(() =>
        loadApiConfig({
          ...stagingBase,
          STAGING_INTEGRATION_MODE: 'true',
          OTEL_ENABLED: 'false',
          WALLET_TON_PROOF_DOMAIN: 'localhost',
          ADMIN_WEBAUTHN_RP_ID: 'localhost',
          ADMIN_WEBAUTHN_ORIGIN: 'http://localhost:3001',
        }),
      ).toThrow(/WALLET_TON_PROOF_DOMAIN|ADMIN_WEBAUTHN/);
    });

    it('defaults API_LISTEN_HOST to 0.0.0.0 for local', () => {
      const config = loadApiConfig({
        ...common,
        ...apiAuth,
        DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        TEMPORAL_ADDRESS: 'localhost:7233',
      });
      expect(config.API_LISTEN_HOST).toBe('0.0.0.0');
    });

    it('defaults API_LISTEN_HOST to :: under staging integration mode', () => {
      const config = loadApiConfig({
        ...stagingBase,
        STAGING_INTEGRATION_MODE: 'true',
        OTEL_ENABLED: 'false',
      });
      expect(config.API_LISTEN_HOST).toBe('::');
    });

    it('accepts explicit API_LISTEN_HOST=:: under staging integration', () => {
      const config = loadApiConfig({
        ...stagingBase,
        STAGING_INTEGRATION_MODE: 'true',
        OTEL_ENABLED: 'false',
        API_LISTEN_HOST: '::',
      });
      expect(config.API_LISTEN_HOST).toBe('::');
    });

    it('refuses invalid API_LISTEN_HOST', () => {
      expect(() =>
        loadApiConfig({
          ...common,
          ...apiAuth,
          DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
          REDIS_URL: 'redis://localhost:6379',
          TEMPORAL_ADDRESS: 'localhost:7233',
          API_LISTEN_HOST: '127.0.0.1',
        }),
      ).toThrow(/API_LISTEN_HOST/);
    });

    it('keeps production default API_LISTEN_HOST at 0.0.0.0 when unset', () => {
      const config = loadApiConfig({
        ...stagingBase,
        DEPLOYMENT_ENV: 'production',
        STAGING_INTEGRATION_MODE: 'false',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        WITHDRAWAL_NETWORK_CODE: 'TON',
      });
      expect(config.API_LISTEN_HOST).toBe('0.0.0.0');
    });
  });

  it('accepts only explicitly public web configuration', () => {
    const config = loadWebConfig({
      NODE_ENV: 'test',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
    });
    expect(Object.keys(config).sort()).toEqual(['NEXT_PUBLIC_API_BASE_URL', 'NODE_ENV']);
    expect(config.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL).toBeUndefined();
  });

  it('accepts optional TonConnect manifest URL without inventing one', () => {
    const config = loadWebConfig({
      NODE_ENV: 'test',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
      NEXT_PUBLIC_TONCONNECT_MANIFEST_URL: 'https://app.example.com/tonconnect-manifest.json',
    });
    expect(config.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL).toBe(
      'https://app.example.com/tonconnect-manifest.json',
    );
    const empty = loadWebConfig({
      NODE_ENV: 'test',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
      NEXT_PUBLIC_TONCONNECT_MANIFEST_URL: '',
    });
    expect(empty.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL).toBeUndefined();
  });

  it('accepts optional Terms/Privacy URLs without inventing legal destinations', () => {
    const config = loadWebConfig({
      NODE_ENV: 'test',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
      NEXT_PUBLIC_TERMS_URL: 'https://legal.test/terms',
      NEXT_PUBLIC_PRIVACY_URL: 'https://legal.test/privacy',
    });
    expect(config.NEXT_PUBLIC_TERMS_URL).toBe('https://legal.test/terms');
    expect(config.NEXT_PUBLIC_PRIVACY_URL).toBe('https://legal.test/privacy');
    const empty = loadWebConfig({
      NODE_ENV: 'test',
      NEXT_PUBLIC_API_BASE_URL: 'https://api.example.com',
      NEXT_PUBLIC_TERMS_URL: '',
      NEXT_PUBLIC_PRIVACY_URL: '',
    });
    expect(empty.NEXT_PUBLIC_TERMS_URL).toBeUndefined();
    expect(empty.NEXT_PUBLIC_PRIVACY_URL).toBeUndefined();
  });

  it('worker local defaults keep real chain off', () => {
    const config = loadWorkerConfig({
      ...common,
      DATABASE_URL: 'postgresql://alex_rewards:local-alex-rewards-only@localhost:5432/alex_rewards',
      REDIS_URL: 'redis://localhost:6379/0',
      TEMPORAL_ADDRESS: 'localhost:7233',
      TEMPORAL_TASK_QUEUE: 'alex-rewards-foundation',
    });
    expect(config.WITHDRAWAL_REAL_CHAIN_ENABLED).toBe(false);
    expect(config.WITHDRAWAL_FAKE_CHAIN_ENABLED).toBe(true);
    expect(config.SIGNER_BASE_URL).toBe('http://127.0.0.1:3005');
    expect(config.TON_TESTNET_JETTON_MASTER).toBe('');
    expect(config.WORKER_LISTEN_HOST).toBe('0.0.0.0');
  });

  it('worker rejects real chain without Owner Jetton master', () => {
    expect(() =>
      loadWorkerConfig({
        ...common,
        DATABASE_URL:
          'postgresql://alex_rewards:local-alex-rewards-only@localhost:5432/alex_rewards',
        REDIS_URL: 'redis://localhost:6379/0',
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_TASK_QUEUE: 'alex-rewards-foundation',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
        WITHDRAWAL_REAL_CHAIN_ENABLED: 'true',
        TON_TESTNET_JETTON_MASTER: '',
      }),
    ).toThrow(/TON_TESTNET_JETTON_MASTER/);
  });

  it('worker rejects MAINNET withdrawal network code', () => {
    expect(() =>
      loadWorkerConfig({
        ...common,
        DATABASE_URL:
          'postgresql://alex_rewards:local-alex-rewards-only@localhost:5432/alex_rewards',
        REDIS_URL: 'redis://localhost:6379/0',
        TEMPORAL_ADDRESS: 'localhost:7233',
        TEMPORAL_TASK_QUEUE: 'alex-rewards-foundation',
        WITHDRAWAL_NETWORK_CODE: 'TON_MAINNET',
      }),
    ).toThrow(/MAINNET/);
  });

  describe('WORKER_LISTEN_HOST', () => {
    const workerLocal = {
      ...common,
      DATABASE_URL: 'postgresql://alex_rewards:local-alex-rewards-only@localhost:5432/alex_rewards',
      REDIS_URL: 'redis://localhost:6379/0',
      TEMPORAL_ADDRESS: 'localhost:7233',
      TEMPORAL_TASK_QUEUE: 'alex-rewards-foundation',
    };

    const workerRemote = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
      REDIS_URL: 'rediss://redis.example.com:6379',
      TEMPORAL_ADDRESS: 'temporal.example.com:7233',
      TEMPORAL_TASK_QUEUE: 'alex-rewards-foundation',
      WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
      WITHDRAWAL_RISK_POLICY_VERSION: '1',
      WITHDRAWAL_ASSET_SYMBOL: 'USDT',
      WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
      WITHDRAWAL_REAL_CHAIN_ENABLED: 'false',
      SIGNER_BASE_URL: 'https://signer.example.com',
    };

    it('defaults local and test to 0.0.0.0', () => {
      expect(loadWorkerConfig(workerLocal).WORKER_LISTEN_HOST).toBe('0.0.0.0');
      expect(loadWorkerConfig({ ...workerLocal, DEPLOYMENT_ENV: 'test' }).WORKER_LISTEN_HOST).toBe(
        '0.0.0.0',
      );
    });

    it('defaults staging integration mode to :: when unset', () => {
      const config = loadWorkerConfig({
        ...workerRemote,
        DEPLOYMENT_ENV: 'staging',
        STAGING_INTEGRATION_MODE: 'true',
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
      });
      expect(config.WORKER_LISTEN_HOST).toBe('::');
    });

    it('accepts explicit 0.0.0.0 and ::', () => {
      expect(
        loadWorkerConfig({ ...workerLocal, WORKER_LISTEN_HOST: '0.0.0.0' }).WORKER_LISTEN_HOST,
      ).toBe('0.0.0.0');
      expect(
        loadWorkerConfig({ ...workerLocal, WORKER_LISTEN_HOST: '::' }).WORKER_LISTEN_HOST,
      ).toBe('::');
    });

    it('rejects an invalid listen host', () => {
      expect(() => loadWorkerConfig({ ...workerLocal, WORKER_LISTEN_HOST: '127.0.0.1' })).toThrow(
        /WORKER_LISTEN_HOST/,
      );
    });

    it('keeps production default 0.0.0.0 when unset', () => {
      const config = loadWorkerConfig({
        ...workerRemote,
        DEPLOYMENT_ENV: 'production',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        WITHDRAWAL_NETWORK_CODE: 'TON',
      });
      expect(config.WORKER_LISTEN_HOST).toBe('0.0.0.0');
      expect(config.WITHDRAWAL_FAKE_CHAIN_ENABLED).toBe(false);
      expect(config.WITHDRAWAL_REAL_CHAIN_ENABLED).toBe(false);
    });

    it('keeps normal staging default 0.0.0.0 when integration mode is off', () => {
      const config = loadWorkerConfig({
        ...workerRemote,
        DEPLOYMENT_ENV: 'staging',
        STAGING_INTEGRATION_MODE: 'false',
        OTEL_ENABLED: 'true',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example.com',
        SENTRY_DSN: 'https://public@example.com/1',
        WITHDRAWAL_NETWORK_CODE: 'TON',
      });
      expect(config.WORKER_LISTEN_HOST).toBe('0.0.0.0');
    });
  });
});

describe('Phase 10 Testnet provision config', () => {
  const base = {
    ...common,
    DATABASE_URL: 'postgresql://alex:local@127.0.0.1:55440/alex_rewards_isolated_payout_test',
  };
  const allowUser = '00000000-0000-4000-8000-0000000000a1';
  const ownerAdmin = '00000000-0000-4000-8000-0000000000a2';

  it('defaults remain disabled with USDT', () => {
    const config = loadPhase10TestnetProvisionConfig(base);
    expect(config.PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED).toBe(false);
    expect(config.WITHDRAWAL_ASSET_SYMBOL).toBe('USDT');
    expect(config.PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME).toBe('');
  });

  it('accepts aalex when enabled with isolated DB identity and capped max', () => {
    const config = loadPhase10TestnetProvisionConfig({
      ...base,
      PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED: 'true',
      WITHDRAWAL_ASSET_SYMBOL: 'aalex',
      PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID: allowUser,
      PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID: ownerAdmin,
      PHASE10_TESTNET_PROVISION_MAX_ATOMIC: '1000000000',
      PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME: 'alex_rewards_isolated_payout_test',
    });
    expect(config.WITHDRAWAL_ASSET_SYMBOL).toBe('aalex');
    expect(config.PHASE10_TESTNET_PROVISION_MAX_ATOMIC).toBe('1000000000');
  });

  it('rejects aalex enabled against operational DATABASE_URL', () => {
    expect(() =>
      loadPhase10TestnetProvisionConfig({
        ...base,
        DATABASE_URL: 'postgresql://alex:local@127.0.0.1:55432/alex_rewards',
        PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED: 'true',
        WITHDRAWAL_ASSET_SYMBOL: 'aalex',
        PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID: allowUser,
        PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID: ownerAdmin,
        PHASE10_TESTNET_PROVISION_MAX_ATOMIC: '1000000000',
        PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME: 'alex_rewards_isolated_payout_test',
      }),
    ).toThrow(/operational|alex_rewards@55432|DATABASE_URL/i);
  });

  it('rejects aalex without required database name', () => {
    expect(() =>
      loadPhase10TestnetProvisionConfig({
        ...base,
        PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED: 'true',
        WITHDRAWAL_ASSET_SYMBOL: 'aalex',
        PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID: allowUser,
        PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID: ownerAdmin,
        PHASE10_TESTNET_PROVISION_MAX_ATOMIC: '1000000000',
      }),
    ).toThrow(/REQUIRED_DATABASE_NAME|required when WITHDRAWAL_ASSET_SYMBOL=aalex/i);
  });

  it('rejects production when provisioning enabled', () => {
    expect(() =>
      loadPhase10TestnetProvisionConfig({
        ...base,
        DEPLOYMENT_ENV: 'production',
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
        WITHDRAWAL_ASSET_SYMBOL: 'USDT',
        PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED: 'true',
        PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID: allowUser,
        PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID: ownerAdmin,
        PHASE10_TESTNET_PROVISION_MAX_ATOMIC: '1000000',
        PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME: '',
      }),
    ).toThrow(/local\/test|cannot be enabled outside/i);
  });

  it('USDT enabled path unchanged (required DB name optional)', () => {
    const config = loadPhase10TestnetProvisionConfig({
      ...base,
      PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED: 'true',
      WITHDRAWAL_ASSET_SYMBOL: 'USDT',
      PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID: allowUser,
      PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID: ownerAdmin,
      PHASE10_TESTNET_PROVISION_MAX_ATOMIC: '1000000',
    });
    expect(config.WITHDRAWAL_ASSET_SYMBOL).toBe('USDT');
    expect(config.PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME).toBe('');
  });
});
