import Fastify, { LogController } from 'fastify';

import { loadSignerConfig } from '@alex-rewards/config';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';

import { registerSignerFoundationRoutes } from './routes.js';

const config = loadSignerConfig();
const observability = await initializeObservability({
  serviceName: 'signer',
  environment: config.DEPLOYMENT_ENV,
  logLevel: config.LOG_LEVEL,
  otelEnabled: config.OTEL_ENABLED,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
    ? {}
    : { otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT }),
  ...(config.SENTRY_DSN === undefined ? {} : { sentryDsn: config.SENTRY_DSN }),
});
const server = Fastify({
  logger: false,
  logController: new LogController({ disableRequestLogging: true }),
});

try {
  await registerSignerFoundationRoutes(server);
  await server.listen({ port: config.SIGNER_PORT, host: '0.0.0.0' });
  observability.logger.info(
    { port: config.SIGNER_PORT, signingEnabled: false },
    'signer boundary listening',
  );
} catch (error) {
  observability.logger.fatal({ err: error }, 'signer failed to start');
  await observability.shutdown();
  process.exitCode = 1;
}

const shutdown = createShutdownCoordinator(observability.logger, 'signer', [
  () => server.close(),
  () => observability.shutdown(),
]);
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
