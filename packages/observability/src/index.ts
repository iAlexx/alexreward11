import { metrics, trace } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import * as Sentry from '@sentry/node';
import pino, { type Logger } from 'pino';

export interface ObservabilityOptions {
  readonly serviceName: string;
  readonly environment: string;
  readonly logLevel: string;
  readonly otelEnabled: boolean;
  readonly otlpEndpoint?: string;
  readonly sentryDsn?: string;
}

export interface Observability {
  readonly logger: Logger;
  readonly tracer: ReturnType<typeof trace.getTracer>;
  readonly meter: ReturnType<typeof metrics.getMeter>;
  shutdown(): Promise<void>;
}

export type ShutdownStep = () => Promise<void> | void;

export interface FrameworkLogger {
  log(message: unknown, ...optionalParameters: unknown[]): void;
  error(message: unknown, ...optionalParameters: unknown[]): void;
  warn(message: unknown, ...optionalParameters: unknown[]): void;
  debug(message: unknown, ...optionalParameters: unknown[]): void;
  verbose(message: unknown, ...optionalParameters: unknown[]): void;
  fatal(message: unknown, ...optionalParameters: unknown[]): void;
}

const REDACT_PATHS = [
  'authorization',
  'cookie',
  'password',
  'token',
  'secret',
  'privateKey',
  'req.headers.authorization',
  'req.headers.cookie',
  'config.DATABASE_URL',
  'config.REDIS_URL',
  'config.SENTRY_DSN',
  'config.SIGNER_SERVICE_TOKEN',
] as const;

export function createLogger(serviceName: string, level: string): Logger {
  return pino({
    name: serviceName,
    level,
    base: { service: serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
  });
}

export function createFrameworkLogger(logger: Logger): FrameworkLogger {
  const write = (
    level: 'debug' | 'error' | 'fatal' | 'info' | 'trace' | 'warn',
    message: unknown,
    optionalParameters: unknown[],
  ): void => {
    logger[level]({ frameworkParameters: optionalParameters }, String(message));
  };
  return {
    log: (message, ...parameters) => write('info', message, parameters),
    error: (message, ...parameters) => write('error', message, parameters),
    warn: (message, ...parameters) => write('warn', message, parameters),
    debug: (message, ...parameters) => write('debug', message, parameters),
    verbose: (message, ...parameters) => write('trace', message, parameters),
    fatal: (message, ...parameters) => write('fatal', message, parameters),
  };
}

export function createShutdownCoordinator(
  logger: Logger,
  serviceName: string,
  steps: readonly ShutdownStep[],
): (signal: string) => Promise<void> {
  let activeShutdown: Promise<void> | undefined;
  return (signal: string) => {
    activeShutdown ??= (async () => {
      logger.info({ signal }, `${serviceName} shutdown started`);
      for (const step of steps) await step();
      logger.info({ signal }, `${serviceName} shutdown complete`);
    })();
    return activeShutdown;
  };
}

export async function initializeObservability(
  options: ObservabilityOptions,
): Promise<Observability> {
  const logger = createLogger(options.serviceName, options.logLevel);
  let sdk: NodeSDK | undefined;

  if (options.sentryDsn !== undefined) {
    Sentry.init({
      dsn: options.sentryDsn,
      environment: options.environment,
      serverName: options.serviceName,
      sendDefaultPii: false,
    });
  }

  if (options.otelEnabled) {
    const endpoint = options.otlpEndpoint;
    sdk = new NodeSDK({
      serviceName: options.serviceName,
      ...(endpoint === undefined
        ? {}
        : {
            traceExporter: new OTLPTraceExporter({
              url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
            }),
            metricReader: new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter({
                url: `${endpoint.replace(/\/$/, '')}/v1/metrics`,
              }),
              exportIntervalMillis: 10_000,
            }),
          }),
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });
    sdk.start();
  }

  const tracer = trace.getTracer(options.serviceName, '1.1.0');
  const meter = metrics.getMeter(options.serviceName, '1.1.0');
  logger.info(
    { otelEnabled: options.otelEnabled, sentryEnabled: options.sentryDsn !== undefined },
    'observability initialized',
  );

  return {
    logger,
    tracer,
    meter,
    async shutdown() {
      await sdk?.shutdown();
      await Sentry.flush(2_000);
    },
  };
}
