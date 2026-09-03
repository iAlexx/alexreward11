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

const apiSchema = serviceSchema.extend({
  API_PORT: z.coerce.number().int().min(1024).max(65535).default(3002),
});

const botSchema = commonSchema
  .extend({
    BOT_PORT: z.coerce.number().int().min(1024).max(65535).default(3003),
    BOT_TRANSPORT_MODE: z.enum(['disabled', 'polling']).default('disabled'),
    TELEGRAM_BOT_TOKEN: optionalSecret,
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
  });

const workerSchema = serviceSchema.extend({
  WORKER_PORT: z.coerce.number().int().min(1024).max(65535).default(3004),
  TEMPORAL_TASK_QUEUE: z.string().min(3),
});

const signerSchema = commonSchema
  .extend({
    SIGNER_PORT: z.coerce.number().int().min(1024).max(65535).default(3005),
    SIGNER_SERVICE_TOKEN: z.string().min(32),
    SIGNER_KMS_KEY_ARN: z.never().optional(),
    AWS_KMS_KEY_ID: z.never().optional(),
  })
  .superRefine((value, context) => {
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

export const loadApiConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig =>
  parseEnvironment(apiSchema, environment);
export const loadBotConfig = (environment: NodeJS.ProcessEnv = process.env): BotConfig =>
  parseEnvironment(botSchema, environment);
export const loadWorkerConfig = (environment: NodeJS.ProcessEnv = process.env): WorkerConfig =>
  parseEnvironment(workerSchema, environment);
export const loadSignerConfig = (environment: NodeJS.ProcessEnv = process.env): SignerConfig =>
  parseEnvironment(signerSchema, environment);
export const loadWebConfig = (environment: NodeJS.ProcessEnv = process.env): WebConfig =>
  parseEnvironment(webSchema, environment);
