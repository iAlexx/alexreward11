/**
 * API Referral deep-link building uses typed TELEGRAM_PUBLIC_BOT_USERNAME
 * and Telegram-safe payload helpers (no hardcoded bot username).
 */
import { describe, expect, it } from 'vitest';

import { loadApiConfig } from '@alex-rewards/config';
import { buildReferralBotStartLink } from '@alex-rewards/referrals';

const localApiBase = {
  DEPLOYMENT_ENV: 'local',
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  OTEL_ENABLED: 'false',
  TELEGRAM_BOT_TOKEN: 'local-only-telegram-bot-token-for-tests',
  SESSION_ACCESS_SECRET: 'local-only-session-access-secret-32b',
  DATABASE_URL: 'postgresql://alex:local@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  TEMPORAL_ADDRESS: 'localhost:7233',
} as const;

describe('API referral deep-link transport', () => {
  it('typed username + safe code => ?start=ref_<exact-code>', () => {
    const config = loadApiConfig({
      ...localApiBase,
      TELEGRAM_PUBLIC_BOT_USERNAME: 'ExampleBot',
    });
    expect(config.TELEGRAM_PUBLIC_BOT_USERNAME).toBe('ExampleBot');
    const link = buildReferralBotStartLink(config.TELEGRAM_PUBLIC_BOT_USERNAME!, 'ABC_123-x');
    expect(link).toBe('https://t.me/ExampleBot?start=ref_ABC_123-x');
    expect(link?.includes('LOOTRAbot')).toBe(false);
  });

  it('absent username => deepLink null; historical unsafe code => null', () => {
    const config = loadApiConfig({ ...localApiBase });
    expect(config.TELEGRAM_PUBLIC_BOT_USERNAME).toBeUndefined();
    expect(buildReferralBotStartLink('', 'ABC_123-x')).toBeNull();
    expect(buildReferralBotStartLink('ExampleBot', 'bad.code')).toBeNull();
  });

  it('rejects leading @ username (canonical without @ required)', () => {
    expect(() =>
      loadApiConfig({
        ...localApiBase,
        TELEGRAM_PUBLIC_BOT_USERNAME: '@ExampleBot',
      }),
    ).toThrow(/TELEGRAM_PUBLIC_BOT_USERNAME/);
  });
});
