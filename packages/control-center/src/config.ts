import type { BotConfig } from '@alex-rewards/config';

import type { ControlCenterEnvironment } from './types.js';

export interface ControlCenterRuntimeConfig {
  readonly deploymentEnvironment: ControlCenterEnvironment;
  readonly ownerTelegramUserIds: ReadonlySet<string>;
  readonly actionTokenTtlSeconds: number;
  readonly confirmTokenTtlSeconds: number;
  readonly rateLimitWindowSeconds: number;
  readonly rateLimitMax: number;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
}

export function deploymentEnvToControlCenterEnvironment(
  value: BotConfig['DEPLOYMENT_ENV'] | string,
): ControlCenterEnvironment {
  switch (value) {
    case 'local':
      return 'LOCAL';
    case 'test':
      return 'LOCAL';
    case 'staging':
      return 'STAGING';
    case 'production':
      return 'PRODUCTION';
    case 'LOCAL':
    case 'DEV':
    case 'STAGING':
    case 'PRODUCTION':
      return value;
    default:
      return 'LOCAL';
  }
}

export function controlCenterConfigFromBot(bot: BotConfig): ControlCenterRuntimeConfig {
  return {
    deploymentEnvironment: deploymentEnvToControlCenterEnvironment(bot.DEPLOYMENT_ENV),
    ownerTelegramUserIds: new Set(bot.ownerTelegramUserIds),
    actionTokenTtlSeconds: bot.CONTROL_CENTER_ACTION_TOKEN_TTL_SECONDS,
    confirmTokenTtlSeconds: bot.CONTROL_CENTER_CONFIRM_TOKEN_TTL_SECONDS,
    rateLimitWindowSeconds: bot.CONTROL_CENTER_RATE_LIMIT_WINDOW_SECONDS,
    rateLimitMax: bot.CONTROL_CENTER_RATE_LIMIT_MAX,
    databaseUrl: bot.DATABASE_URL,
    redisUrl: bot.REDIS_URL,
  };
}

export function localControlCenterFixtureConfig(
  ownerTelegramUserIds: ReadonlyArray<string> = ['900001'],
): ControlCenterRuntimeConfig {
  return {
    deploymentEnvironment: 'LOCAL',
    ownerTelegramUserIds: new Set(ownerTelegramUserIds),
    actionTokenTtlSeconds: 900,
    confirmTokenTtlSeconds: 300,
    rateLimitWindowSeconds: 60,
    rateLimitMax: 60,
    databaseUrl: undefined,
    redisUrl: undefined,
  };
}
