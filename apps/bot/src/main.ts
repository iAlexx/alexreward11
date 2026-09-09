import Fastify, { LogController } from 'fastify';
import { Bot } from 'grammy';
import { Pool } from 'pg';

import { loadBotConfig } from '@alex-rewards/config';
import {
  controlCenterConfigFromBot,
  handleControlCenterCallback,
} from '@alex-rewards/control-center';
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';
import { withdrawalEngineConfigFromValidatedApi } from '@alex-rewards/withdrawals';

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
let pool: Pool | undefined;
let ready = config.BOT_TRANSPORT_MODE === 'disabled';

const controlCenterConfig = controlCenterConfigFromBot(config);
const withdrawalEngineConfig = withdrawalEngineConfigFromValidatedApi({
  DEPLOYMENT_ENV: config.DEPLOYMENT_ENV,
  WITHDRAWAL_QUOTE_TTL_SECONDS: config.WITHDRAWAL_QUOTE_TTL_SECONDS,
  WITHDRAWAL_RISK_POLICY_VERSION: config.WITHDRAWAL_RISK_POLICY_VERSION,
  WITHDRAWAL_NETWORK_CODE: config.WITHDRAWAL_NETWORK_CODE,
  WITHDRAWAL_ASSET_SYMBOL: config.WITHDRAWAL_ASSET_SYMBOL,
  WITHDRAWAL_FAKE_CHAIN_ENABLED: config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
});

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
    if (config.DATABASE_URL === undefined) {
      throw new Error('DATABASE_URL is required when bot transport is enabled');
    }
    pool = new Pool({ connectionString: config.DATABASE_URL });
    bot = new Bot(config.TELEGRAM_BOT_TOKEN);
    bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const fromId = ctx.from?.id;
      const chatId = ctx.chat?.id;
      if (fromId === undefined || chatId === undefined || pool === undefined) {
        await ctx.answerCallbackQuery({ text: 'Unavailable', show_alert: false });
        return;
      }
      const topicThreadId =
        ctx.callbackQuery.message !== undefined &&
        'message_thread_id' in ctx.callbackQuery.message &&
        typeof ctx.callbackQuery.message.message_thread_id === 'number'
          ? String(ctx.callbackQuery.message.message_thread_id)
          : null;
      const result = await handleControlCenterCallback(
        pool,
        controlCenterConfig,
        withdrawalEngineConfig,
        {
          callbackQueryId: String(ctx.callbackQuery.id),
          callbackData: data,
          telegramUserId: String(fromId),
          chatId: String(chatId),
          topicThreadId,
          ...(ctx.callbackQuery.message !== undefined
            ? { messageId: ctx.callbackQuery.message.message_id }
            : {}),
        },
      );
      await ctx.answerCallbackQuery({
        text: result.telegramText.slice(0, 180),
        show_alert: !result.ok,
      });
    });
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
  async () => {
    await pool?.end();
  },
  () => server.close(),
  () => observability.shutdown(),
]);
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
