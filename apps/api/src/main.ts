import 'reflect-metadata';

import { loadApiConfig } from '@alex-rewards/config';
import {
  createFrameworkLogger,
  createShutdownCoordinator,
  initializeObservability,
} from '@alex-rewards/observability';

const config = loadApiConfig();
const observability = await initializeObservability({
  serviceName: 'api',
  environment: config.DEPLOYMENT_ENV,
  logLevel: config.LOG_LEVEL,
  otelEnabled: config.OTEL_ENABLED,
  ...(config.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
    ? {}
    : { otlpEndpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT }),
  ...(config.SENTRY_DSN === undefined ? {} : { sentryDsn: config.SENTRY_DSN }),
});

try {
  const [{ NestFactory }, { FastifyAdapter }, { SwaggerModule, DocumentBuilder }, { AppModule }] =
    await Promise.all([
      import('@nestjs/core'),
      import('@nestjs/platform-fastify'),
      import('@nestjs/swagger'),
      import('./app.module.js'),
    ]);
  const app = await NestFactory.create(AppModule.register(config), new FastifyAdapter(), {
    bufferLogs: false,
    logger: createFrameworkLogger(observability.logger),
  });
  const openApiConfig = new DocumentBuilder()
    .setTitle('ALEx Rewards API')
    .setDescription('Phase 1 foundation endpoints only')
    .setVersion('1.1.0')
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, openApiConfig));
  await app.listen(config.API_PORT, '0.0.0.0');
  observability.logger.info({ port: config.API_PORT }, 'api listening');

  const shutdown = createShutdownCoordinator(observability.logger, 'api', [
    () => app.close(),
    () => observability.shutdown(),
  ]);
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
} catch (error) {
  observability.logger.fatal({ err: error }, 'api failed to start');
  await observability.shutdown();
  process.exitCode = 1;
}
