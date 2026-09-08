import 'reflect-metadata';

import type { FastifyReply, FastifyRequest } from 'fastify';

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
  const adapter = new FastifyAdapter({
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });
  const app = await NestFactory.create(AppModule.register(config), adapter, {
    bufferLogs: false,
    logger: createFrameworkLogger(observability.logger),
  });

  const origins = config.CORS_ORIGINS;
  app.enableCors({
    origin: origins.length === 0 ? false : origins,
    credentials: false,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
  });

  const fastify = app.getHttpAdapter().getInstance() as {
    addHook: (
      name: 'onSend',
      handler: (request: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown>,
    ) => void;
  };
  fastify.addHook(
    'onSend',
    async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Cache-Control', 'no-store');
      reply.header(
        'Content-Security-Policy',
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      );
      return payload;
    },
  );

  const openApiConfig = new DocumentBuilder()
    .setTitle('ALEx Rewards API')
    .setDescription('Phase 3 Telegram auth and membership identity binding')
    .setVersion('1.2.0')
    .addBearerAuth()
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
