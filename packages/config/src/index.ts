import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const deploymentEnvironment = z.enum(['local', 'test', 'staging', 'production']);
const nodeEnvironment = z.enum(['development', 'test', 'production']);
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);
const optionalUrl = z.preprocess((value) => (value === '' ? undefined : value), z.url().optional());
const optionalSecret = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().min(20).optional(),
);

const commonSchema = z.object({
  DEPLOYMENT_ENV: deploymentEnvironment,
  NODE_ENV: nodeEnvironment,
  LOG_LEVEL: logLevel.default('info'),
  OTEL_ENABLED: booleanFromString,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  SENTRY_DSN: optionalUrl,
});

const postgresUrl = z
  .url()
  .refine((value) => value.startsWith('postgresql://') || value.startsWith('postgres://'), {
    message: 'must use the postgres:// or postgresql:// scheme',
  });

const redisUrl = z
  .url()
  .refine((value) => value.startsWith('redis://') || value.startsWith('rediss://'), {
    message: 'must use the redis:// or rediss:// scheme',
  });

const serviceSchema = commonSchema.extend({
  DATABASE_URL: postgresUrl,
  REDIS_URL: redisUrl,
  TEMPORAL_ADDRESS: z.string().min(3),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
});

/** Local/test-only policy defaults. Staging/production must set every key explicitly. */
const LOCAL_API_AUTH_POLICY_DEFAULTS = {
  SESSION_ACCESS_TTL_SECONDS: '900',
  SESSION_REFRESH_TTL_SECONDS: '2592000',
  INITDATA_MAX_AGE_SECONDS: '86400',
  CORS_ORIGINS: '',
  AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
  AUTH_RATE_LIMIT_MAX: '30',
  CLAIM_RATE_LIMIT_WINDOW_SECONDS: '300',
  CLAIM_RATE_LIMIT_MAX: '10',
  WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
  WITHDRAWAL_RISK_POLICY_VERSION: '1',
  WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
  WITHDRAWAL_ASSET_SYMBOL: 'USDT',
  WITHDRAWAL_FAKE_CHAIN_ENABLED: 'true',
} as const;

const apiSchema = serviceSchema
  .extend({
    API_PORT: z.coerce.number().int().min(1024).max(65535).default(3002),
    TELEGRAM_BOT_TOKEN: z.string().min(20),
    SESSION_ACCESS_SECRET: z.string().min(32),
    // No Zod defaults: staging/production must supply these explicitly (fail closed).
    SESSION_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600),
    SESSION_REFRESH_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(60 * 60 * 24 * 90),
    INITDATA_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(86_400),
    CORS_ORIGINS: z.string().transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
    AUTH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000),
    CLAIM_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600),
    CLAIM_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000),
    // Withdrawal engine — no Zod defaults; local/test merge supplies fixture defaults only.
    WITHDRAWAL_QUOTE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400),
    WITHDRAWAL_RISK_POLICY_VERSION: z.coerce.number().int().min(1).max(10_000),
    WITHDRAWAL_NETWORK_CODE: z.string().min(1).max(64),
    WITHDRAWAL_ASSET_SYMBOL: z.string().min(1).max(32),
    WITHDRAWAL_FAKE_CHAIN_ENABLED: booleanFromString,
  })
  .superRefine((value, context) => {
    const outsideLocal = value.DEPLOYMENT_ENV !== 'local' && value.DEPLOYMENT_ENV !== 'test';
    if (
      outsideLocal &&
      (value.TELEGRAM_BOT_TOKEN.includes('local-only') ||
        value.SESSION_ACCESS_SECRET.includes('local-only'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_BOT_TOKEN'],
        message: 'local-only auth secrets are forbidden outside local/test',
      });
    }
    if (outsideLocal && value.CORS_ORIGINS.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message: 'must list at least one explicit origin outside local/test',
      });
    }
    if (outsideLocal && value.WITHDRAWAL_FAKE_CHAIN_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_FAKE_CHAIN_ENABLED'],
        message: 'fake payout chain is forbidden outside local/test',
      });
    }
    if (outsideLocal && value.WITHDRAWAL_NETWORK_CODE === 'TON_TESTNET') {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_NETWORK_CODE'],
        message: 'TON_TESTNET cannot be inherited by staging/production',
      });
    }
  });

const botSchema = commonSchema
  .extend({
    BOT_PORT: z.coerce.number().int().min(1024).max(65535).default(3003),
    BOT_TRANSPORT_MODE: z.enum(['disabled', 'polling']).default('disabled'),
    TELEGRAM_BOT_TOKEN: optionalSecret,
    DATABASE_URL: postgresUrl.optional(),
    REDIS_URL: redisUrl.optional(),
    CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS: z.string().default(''),
    CONTROL_CENTER_ACTION_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400),
    CONTROL_CENTER_CONFIRM_TOKEN_TTL_SECONDS: z.coerce.number().int().min(30).max(3600),
    CONTROL_CENTER_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).max(3600),
    CONTROL_CENTER_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(10_000),
    WITHDRAWAL_QUOTE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400),
    WITHDRAWAL_RISK_POLICY_VERSION: z.coerce.number().int().min(1).max(10_000),
    WITHDRAWAL_NETWORK_CODE: z.string().min(1).max(64),
    WITHDRAWAL_ASSET_SYMBOL: z.string().min(1).max(32),
    WITHDRAWAL_FAKE_CHAIN_ENABLED: booleanFromString,
  })
  .superRefine((value, context) => {
    if (value.BOT_TRANSPORT_MODE !== 'disabled' && value.TELEGRAM_BOT_TOKEN === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['TELEGRAM_BOT_TOKEN'],
        message: 'is required when BOT_TRANSPORT_MODE enables Telegram connectivity',
      });
    }
    if (value.DEPLOYMENT_ENV !== 'local' && value.BOT_TRANSPORT_MODE === 'disabled') {
      context.addIssue({
        code: 'custom',
        path: ['BOT_TRANSPORT_MODE'],
        message: 'cannot be disabled outside local development',
      });
    }
    const outsideLocal = value.DEPLOYMENT_ENV !== 'local' && value.DEPLOYMENT_ENV !== 'test';
    const ownerIds = value.CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (outsideLocal && ownerIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS'],
        message: 'Owner Telegram allowlist is required outside local/test',
      });
    }
    for (const id of ownerIds) {
      if (!/^\d{5,20}$/.test(id)) {
        context.addIssue({
          code: 'custom',
          path: ['CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS'],
          message: 'must be comma-separated Telegram user IDs',
        });
        break;
      }
    }
    if (
      (outsideLocal || value.BOT_TRANSPORT_MODE !== 'disabled') &&
      value.DATABASE_URL === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'is required when Control Center transport is enabled or outside local/test',
      });
    }
    if (outsideLocal && value.WITHDRAWAL_FAKE_CHAIN_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_FAKE_CHAIN_ENABLED'],
        message: 'fake payout chain is forbidden outside local/test',
      });
    }
    if (outsideLocal && value.WITHDRAWAL_NETWORK_CODE === 'TON_TESTNET') {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_NETWORK_CODE'],
        message: 'TON_TESTNET cannot be inherited by staging/production',
      });
    }
  })
  .transform((value) => {
    const ownerTelegramUserIds = value.CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return { ...value, ownerTelegramUserIds };
  });

const LOCAL_BOT_CONTROL_CENTER_DEFAULTS = {
  CONTROL_CENTER_ACTION_TOKEN_TTL_SECONDS: '900',
  CONTROL_CENTER_CONFIRM_TOKEN_TTL_SECONDS: '300',
  CONTROL_CENTER_RATE_LIMIT_WINDOW_SECONDS: '60',
  CONTROL_CENTER_RATE_LIMIT_MAX: '30',
  CONTROL_CENTER_OWNER_TELEGRAM_USER_IDS: '900001',
  WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
  WITHDRAWAL_RISK_POLICY_VERSION: '1',
  WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
  WITHDRAWAL_ASSET_SYMBOL: 'USDT',
  WITHDRAWAL_FAKE_CHAIN_ENABLED: 'true',
} as const;

const LOCAL_WORKER_WITHDRAWAL_DEFAULTS = {
  WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
  WITHDRAWAL_RISK_POLICY_VERSION: '1',
  WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
  WITHDRAWAL_ASSET_SYMBOL: 'USDT',
  WITHDRAWAL_FAKE_CHAIN_ENABLED: 'true',
  WITHDRAWAL_REAL_CHAIN_ENABLED: 'false',
  SIGNER_BASE_URL: 'http://127.0.0.1:3005',
  TON_TESTNET_JETTON_MASTER: '',
  TON_PRIMARY_PROVIDER_KIND: '',
  TON_PRIMARY_PROVIDER_URL: '',
  TON_PRIMARY_PROVIDER_API_KEY: '',
  TON_SECONDARY_PROVIDER_KIND: '',
  TON_SECONDARY_PROVIDER_URL: '',
  TON_SECONDARY_PROVIDER_API_KEY: '',
} as const;

const optionalEmptyString = z.preprocess(
  (value) => (value === undefined || value === null ? '' : value),
  z.string().max(512),
);

const workerSchema = serviceSchema
  .extend({
    WORKER_PORT: z.coerce.number().int().min(1024).max(65535).default(3004),
    TEMPORAL_TASK_QUEUE: z.string().min(3),
    WITHDRAWAL_QUOTE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400),
    WITHDRAWAL_RISK_POLICY_VERSION: z.coerce.number().int().min(1).max(10_000),
    WITHDRAWAL_NETWORK_CODE: z.string().min(1).max(64),
    WITHDRAWAL_ASSET_SYMBOL: z.string().min(1).max(32),
    WITHDRAWAL_FAKE_CHAIN_ENABLED: booleanFromString,
    WITHDRAWAL_REAL_CHAIN_ENABLED: booleanFromString,
    SIGNER_BASE_URL: z.string().min(1).max(512),
    TON_TESTNET_JETTON_MASTER: optionalEmptyString,
    TON_PRIMARY_PROVIDER_KIND: optionalEmptyString,
    TON_PRIMARY_PROVIDER_URL: optionalEmptyString,
    TON_PRIMARY_PROVIDER_API_KEY: optionalEmptyString,
    TON_SECONDARY_PROVIDER_KIND: optionalEmptyString,
    TON_SECONDARY_PROVIDER_URL: optionalEmptyString,
    TON_SECONDARY_PROVIDER_API_KEY: optionalEmptyString,
    SIGNER_SERVICE_TOKEN: z.preprocess(
      (value) => (value === undefined || value === null || value === '' ? undefined : value),
      z.string().min(32).optional(),
    ),
  })
  .superRefine((value, context) => {
    const outsideLocal = value.DEPLOYMENT_ENV !== 'local' && value.DEPLOYMENT_ENV !== 'test';
    if (outsideLocal && value.WITHDRAWAL_FAKE_CHAIN_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_FAKE_CHAIN_ENABLED'],
        message: 'fake payout chain is forbidden outside local/test',
      });
    }
    if (outsideLocal && value.WITHDRAWAL_NETWORK_CODE === 'TON_TESTNET') {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_NETWORK_CODE'],
        message: 'TON_TESTNET cannot be inherited by staging/production',
      });
    }
    if (value.WITHDRAWAL_NETWORK_CODE.toUpperCase().includes('MAINNET')) {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_NETWORK_CODE'],
        message: 'MAINNET network codes are forbidden',
      });
    }
    if (value.WITHDRAWAL_REAL_CHAIN_ENABLED && value.WITHDRAWAL_FAKE_CHAIN_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['WITHDRAWAL_REAL_CHAIN_ENABLED'],
        message: 'real chain and fake chain cannot both be enabled',
      });
    }
    if (value.WITHDRAWAL_REAL_CHAIN_ENABLED && value.TON_TESTNET_JETTON_MASTER.trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['TON_TESTNET_JETTON_MASTER'],
        message:
          'TON_TESTNET_JETTON_MASTER is required when WITHDRAWAL_REAL_CHAIN_ENABLED=true (Owner-approved; fail closed)',
      });
    }
    if (value.WITHDRAWAL_REAL_CHAIN_ENABLED && value.TON_PRIMARY_PROVIDER_KIND.trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['TON_PRIMARY_PROVIDER_KIND'],
        message: 'TON_PRIMARY_PROVIDER_KIND is required when WITHDRAWAL_REAL_CHAIN_ENABLED=true',
      });
    }
    if (value.WITHDRAWAL_REAL_CHAIN_ENABLED && value.TON_PRIMARY_PROVIDER_URL.trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['TON_PRIMARY_PROVIDER_URL'],
        message: 'TON_PRIMARY_PROVIDER_URL is required when WITHDRAWAL_REAL_CHAIN_ENABLED=true',
      });
    }
  });

/** Local/test-only signer defaults. Staging/production must set keys explicitly. */
const LOCAL_SIGNER_DEFAULTS = {
  SIGNER_DATABASE_URL:
    'postgresql://alex_rewards:local-alex-rewards-only@localhost:55432/alex_rewards',
  SIGNER_KEY_MODE: 'local_ephemeral',
  SIGNER_SPIKE_ENABLED: 'true',
  SIGNER_NETWORK_CODE: 'TON_TESTNET',
  SIGNER_NETWORK_GLOBAL_ID: '-3',
  SIGNER_WALLET_VERSION: 'v5R1',
  SIGNER_WORKCHAIN: '0',
  SIGNER_EXPECTED_ASSET_SYMBOL: 'USDT',
} as const;

const forbiddenPlaintextSignerSecrets = [
  'SIGNER_PRIVATE_KEY',
  'SIGNER_SEED',
  'SIGNER_MNEMONIC',
  'SIGNER_KEY_PASSPHRASE',
] as const;

const signerSchema = commonSchema
  .extend({
    SIGNER_PORT: z.coerce.number().int().min(1024).max(65535).default(3005),
    SIGNER_SERVICE_TOKEN: z.string().min(32),
    SIGNER_DATABASE_URL: postgresUrl,
    SIGNER_KEY_MODE: z.enum(['self_hosted_encrypted', 'local_ephemeral']),
    SIGNER_KEY_BUNDLE_PATH: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      z.string().min(1).max(512).optional(),
    ),
    SIGNER_EXPECTED_SIGNER_REFERENCE: z.preprocess(
      (value) => (value === '' || value === undefined ? undefined : value),
      z
        .string()
        .regex(/^[0-9a-f]{64}$/i, 'must be SHA-256 public key fingerprint hex')
        .optional(),
    ),
    // Removed production AWS path (Owner v1.3). Reject if still present.
    SIGNER_KMS_MODE: z.never().optional(),
    SIGNER_KMS_KEY_ARN: z.never().optional(),
    SIGNER_AWS_REGION: z.never().optional(),
    AWS_KMS_KEY_ID: z.never().optional(),
    SIGNER_PRIVATE_KEY: z.never().optional(),
    SIGNER_SEED: z.never().optional(),
    SIGNER_MNEMONIC: z.never().optional(),
    SIGNER_KEY_PASSPHRASE: z.never().optional(),
    SIGNER_SPIKE_ENABLED: booleanFromString,
    SIGNER_NETWORK_CODE: z.string().min(1).max(64),
    SIGNER_NETWORK_GLOBAL_ID: z.coerce.number().int(),
    SIGNER_WALLET_VERSION: z.literal('v5R1'),
    SIGNER_WORKCHAIN: z.coerce.number().int().min(-1).max(0).default(0),
    SIGNER_EXPECTED_ASSET_SYMBOL: z.string().min(1).max(32).default('USDT'),
    /**
     * Optional listen bind. self_hosted_encrypted defaults to 127.0.0.1 for bare-metal
     * unlock safety. Docker Compose must set 0.0.0.0 so published ports work; unlock
     * remains loopback-client gated in apps/signer.
     */
    SIGNER_LISTEN_HOST: z.preprocess(
      (value) => (value === '' || value === undefined || value === null ? undefined : value),
      z.enum(['127.0.0.1', '0.0.0.0']).optional(),
    ),
  })
  .superRefine((value, context) => {
    for (const key of forbiddenPlaintextSignerSecrets) {
      if (process.env[key] !== undefined && process.env[key] !== '') {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is forbidden; passphrase/private material must not be stored in env`,
        });
      }
    }
    if (
      value.DEPLOYMENT_ENV !== 'local' &&
      value.SIGNER_SERVICE_TOKEN === 'replace-with-a-random-32-character-local-token'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SIGNER_SERVICE_TOKEN'],
        message: 'local example token is forbidden outside local development',
      });
    }
    const outsideLocal = value.DEPLOYMENT_ENV !== 'local' && value.DEPLOYMENT_ENV !== 'test';
    if (outsideLocal && value.SIGNER_KEY_MODE !== 'self_hosted_encrypted') {
      context.addIssue({
        code: 'custom',
        path: ['SIGNER_KEY_MODE'],
        message: 'local_ephemeral key mode is forbidden outside local/test',
      });
    }
    if (
      value.SIGNER_KEY_MODE === 'self_hosted_encrypted' &&
      value.SIGNER_KEY_BUNDLE_PATH === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['SIGNER_KEY_BUNDLE_PATH'],
        message: 'SIGNER_KEY_BUNDLE_PATH is required when SIGNER_KEY_MODE=self_hosted_encrypted',
      });
    }
    if (value.SIGNER_NETWORK_CODE.toUpperCase().includes('MAINNET')) {
      context.addIssue({
        code: 'custom',
        path: ['SIGNER_NETWORK_CODE'],
        message: 'MAINNET network codes are forbidden in Phase 9 signer config',
      });
    }
    if (value.SIGNER_NETWORK_GLOBAL_ID === -239) {
      context.addIssue({
        code: 'custom',
        path: ['SIGNER_NETWORK_GLOBAL_ID'],
        message: 'MAINNET networkGlobalId (-239) is forbidden in Phase 9',
      });
    }
    if (value.SIGNER_NETWORK_GLOBAL_ID !== -3) {
      context.addIssue({
        code: 'custom',
        path: ['SIGNER_NETWORK_GLOBAL_ID'],
        message: 'Phase 9 requires TESTNET networkGlobalId -3',
      });
    }
  });

const webSchema = z.object({
  NODE_ENV: nodeEnvironment,
  NEXT_PUBLIC_API_BASE_URL: z.url(),
  NEXT_PUBLIC_SENTRY_DSN: optionalUrl,
});

export type ApiConfig = z.infer<typeof apiSchema>;
export type BotConfig = z.infer<typeof botSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;
export type SignerConfig = z.infer<typeof signerSchema>;
export type WebConfig = z.infer<typeof webSchema>;
export type CommonConfig = z.infer<typeof commonSchema>;

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('; ');
}

function parseEnvironment<T>(schema: z.ZodType<T>, environment: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(environment);
  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${formatIssues(result.error)}`);
  }
  if (typeof result.data === 'object' && result.data !== null && 'DEPLOYMENT_ENV' in result.data) {
    assertSecureEnvironment(result.data as CommonConfig & Record<string, unknown>);
  }
  return result.data;
}

function assertSecureEnvironment(config: CommonConfig & Record<string, unknown>): void {
  if (config.DEPLOYMENT_ENV === 'local' || config.DEPLOYMENT_ENV === 'test') return;

  if (!config.OTEL_ENABLED || config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
    throw new Error(
      'Invalid environment configuration: OTLP export is required outside local/test',
    );
  }
  if (config.SENTRY_DSN === undefined) {
    throw new Error('Invalid environment configuration: SENTRY_DSN is required outside local/test');
  }

  for (const key of ['DATABASE_URL', 'REDIS_URL', 'NEXT_PUBLIC_API_BASE_URL'] as const) {
    const value = config[key];
    if (typeof value === 'string') {
      const hostname = new URL(value).hostname;
      if (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === 'host.docker.internal'
      ) {
        throw new Error(
          `Invalid environment configuration: ${key} may not target loopback outside local/test`,
        );
      }
    }
  }
}

export const loadApiConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const deployment = environment.DEPLOYMENT_ENV ?? 'local';
  const merged =
    deployment === 'local' || deployment === 'test'
      ? { ...LOCAL_API_AUTH_POLICY_DEFAULTS, ...environment }
      : environment;
  return parseEnvironment(apiSchema, merged);
};
export const loadBotConfig = (environment: NodeJS.ProcessEnv = process.env): BotConfig => {
  const deployment = environment.DEPLOYMENT_ENV ?? 'local';
  const merged =
    deployment === 'local' || deployment === 'test'
      ? { ...LOCAL_BOT_CONTROL_CENTER_DEFAULTS, ...environment }
      : environment;
  return parseEnvironment(botSchema, merged);
};
export const loadWorkerConfig = (environment: NodeJS.ProcessEnv = process.env): WorkerConfig => {
  const deployment = environment.DEPLOYMENT_ENV ?? 'local';
  const merged =
    deployment === 'local' || deployment === 'test'
      ? { ...LOCAL_WORKER_WITHDRAWAL_DEFAULTS, ...environment }
      : environment;
  return parseEnvironment(workerSchema, merged);
};
export const loadSignerConfig = (environment: NodeJS.ProcessEnv = process.env): SignerConfig => {
  const deployment = environment.DEPLOYMENT_ENV ?? 'local';
  const merged =
    deployment === 'local' || deployment === 'test'
      ? { ...LOCAL_SIGNER_DEFAULTS, ...environment }
      : environment;
  return parseEnvironment(signerSchema, merged);
};
export const loadWebConfig = (environment: NodeJS.ProcessEnv = process.env): WebConfig =>
  parseEnvironment(webSchema, environment);
