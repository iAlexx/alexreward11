import Fastify, { LogController } from 'fastify';
import { Bot } from 'grammy';

import { loadBotConfig } from '@alex-rewards/config';
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';

const config = loadBotConfig();
const observability = await initializeObservability({
  serviceName: 'bot',
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
let bot: Bot | undefined;
let ready = config.BOT_TRANSPORT_MODE === 'disabled';

const response = (status: HealthResponse['status']): HealthResponse => ({
  contractVersion: HEALTH_CONTRACT_VERSION,
  service: 'bot',
  status,
  timestamp: new Date().toISOString(),
  components: [{ name: `telegram-transport:${config.BOT_TRANSPORT_MODE}`, state: status }],
});

server.get('/health/live', async () => response('ok'));
server.get('/health/ready', async (_request, reply) => {
  const status = ready ? 'ok' : 'unavailable';
  return reply.code(ready ? 200 : 503).send(response(status));
});
server.get('/health', async () => response('ok'));

try {
  await server.listen({ port: config.BOT_PORT, host: '0.0.0.0' });
  if (config.BOT_TRANSPORT_MODE === 'polling' && config.TELEGRAM_BOT_TOKEN !== undefined) {
    bot = new Bot(config.TELEGRAM_BOT_TOKEN);
    void bot
      .start({
        onStart: () => {
          ready = true;
          observability.logger.info('telegram polling started');
        },
      })
      .catch((error: unknown) => {
        ready = false;
        observability.logger.error({ err: error }, 'telegram polling stopped unexpectedly');
      });
  }
  observability.logger.info(
    { port: config.BOT_PORT, transport: config.BOT_TRANSPORT_MODE },
    'bot listening',
  );
} catch (error) {
  observability.logger.fatal({ err: error }, 'bot failed to start');
  await observability.shutdown();
  process.exitCode = 1;
}

const shutdown = createShutdownCoordinator(observability.logger, 'bot', [
  () => {
    ready = false;
  },
  async () => {
    if (bot?.isRunning()) await bot.stop();
  },
  () => server.close(),
  () => observability.shutdown(),
]);
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
