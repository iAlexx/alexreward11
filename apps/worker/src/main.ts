import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import Fastify, { LogController } from 'fastify';
import { Pool } from 'pg';

import { loadWorkerConfig, type WorkerConfig } from '@alex-rewards/config';
import { type HealthResponse } from '@alex-rewards/contracts';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';
import {
  processWithdrawalApprovedOutboxBatch,
  processWithdrawalFailedPreRetryOutboxBatch,
  buildPhase10PayoutConfig,
  withdrawalEngineConfigFromValidatedApi,
  type WithdrawalEngineConfig,
} from '@alex-rewards/withdrawals';

import { createWithdrawalActivities } from './activities.js';
import { buildWorkerHealth } from './health.js';
import { createWithdrawalOutboxPoller, startWithdrawalOutboxRelay } from './outbox-relay.js';

const OUTBOX_POLL_INTERVAL_MS = 2_000;

function withdrawalEngineConfigFromWorker(config: WorkerConfig): WithdrawalEngineConfig {
  return withdrawalEngineConfigFromValidatedApi({
    DEPLOYMENT_ENV: config.DEPLOYMENT_ENV,
    WITHDRAWAL_QUOTE_TTL_SECONDS: config.WITHDRAWAL_QUOTE_TTL_SECONDS,
    WITHDRAWAL_RISK_POLICY_VERSION: config.WITHDRAWAL_RISK_POLICY_VERSION,
    WITHDRAWAL_NETWORK_CODE: config.WITHDRAWAL_NETWORK_CODE,
    WITHDRAWAL_ASSET_SYMBOL: config.WITHDRAWAL_ASSET_SYMBOL,
    WITHDRAWAL_FAKE_CHAIN_ENABLED: config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
  });
}

const config = loadWorkerConfig();
const withdrawalConfig = withdrawalEngineConfigFromWorker(config);
const phase10Config = buildPhase10PayoutConfig({
  realChainEnabled: config.WITHDRAWAL_REAL_CHAIN_ENABLED,
  signerBaseUrl: config.SIGNER_BASE_URL,
  signerServiceToken: config.SIGNER_SERVICE_TOKEN ?? '',
  jettonMasterIdentity: config.TON_TESTNET_JETTON_MASTER,
  primaryProviderKind: config.TON_PRIMARY_PROVIDER_KIND,
  primaryProviderUrl: config.TON_PRIMARY_PROVIDER_URL,
  primaryProviderApiKey: config.TON_PRIMARY_PROVIDER_API_KEY,
  secondaryProviderKind: config.TON_SECONDARY_PROVIDER_KIND,
  secondaryProviderUrl: config.TON_SECONDARY_PROVIDER_URL,
  secondaryProviderApiKey: config.TON_SECONDARY_PROVIDER_API_KEY,
});
Runtime.install({ shutdownSignals: [] });
const observability = await initializeObservability({
  serviceName: 'worker',
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
let nativeConnection: NativeConnection | undefined;
let clientConnection: Connection | undefined;
let worker: Worker | undefined;
let workerRunPromise: Promise<void> | undefined;
let ready = false;
let dbPool: Pool | undefined;
let temporalClient: Client | undefined;
let outboxPollTimer: ReturnType<typeof setInterval> | undefined;

const health = (readyForTraffic: boolean): HealthResponse =>
  buildWorkerHealth({
    ready: readyForTraffic,
    outboxRelayEnabled: config.WORKER_OUTBOX_RELAY_ENABLED,
    timestamp: new Date().toISOString(),
  });
server.get('/health/live', async () => health(true));
server.get('/health/ready', async (_request, reply) => {
  const body = health(ready);
  return reply.code(body.status === 'ok' ? 200 : 503).send(body);
});
server.get('/health', async () => health(true));

try {
  nativeConnection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  clientConnection = await Connection.connect({ address: config.TEMPORAL_ADDRESS });
  dbPool = new Pool({ connectionString: config.DATABASE_URL });
  temporalClient = new Client({
    connection: clientConnection,
    namespace: config.TEMPORAL_NAMESPACE,
  });
  const activities = createWithdrawalActivities({
    pool: dbPool,
    config: withdrawalConfig,
    phase10: phase10Config,
  });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
    activities,
  });
  await server.listen({ port: config.WORKER_PORT, host: config.WORKER_LISTEN_HOST });
  ready = true;
  workerRunPromise = worker.run().catch((error: unknown) => {
    ready = false;
    observability.logger.error({ err: error }, 'temporal worker stopped unexpectedly');
    process.exitCode = 1;
  });

  // Historical poll when enabled. Disabled staging integration never arms this interval.
  outboxPollTimer = startWithdrawalOutboxRelay({
    enabled: config.WORKER_OUTBOX_RELAY_ENABLED,
    intervalMs: OUTBOX_POLL_INTERVAL_MS,
    poll: async () => {
      if (dbPool === undefined || temporalClient === undefined) return;
      const pool = dbPool;
      const client = temporalClient;
      await createWithdrawalOutboxPoller({
        processApproved: () =>
          processWithdrawalApprovedOutboxBatch(pool, {
            client,
            taskQueue: config.TEMPORAL_TASK_QUEUE,
            fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
            realChainEnabled: phase10Config.realChainEnabled,
          }),
        processFailedPreRetry: () =>
          processWithdrawalFailedPreRetryOutboxBatch(pool, {
            client,
            taskQueue: config.TEMPORAL_TASK_QUEUE,
            fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
            realChainEnabled: phase10Config.realChainEnabled,
          }),
      })();
    },
    onError: (error) => {
      observability.logger.warn({ err: error }, 'withdrawal outbox relay batch failed');
    },
  });

  if (!config.WORKER_OUTBOX_RELAY_ENABLED) {
    observability.logger.info({ outboxRelayEnabled: false }, 'withdrawal outbox relay disabled');
  }

  observability.logger.info(
    {
      port: config.WORKER_PORT,
      listenHost: config.WORKER_LISTEN_HOST,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
      realChainEnabled: phase10Config.realChainEnabled,
      outboxRelayEnabled: config.WORKER_OUTBOX_RELAY_ENABLED,
    },
    'worker listening',
  );
} catch (error) {
  observability.logger.fatal({ err: error }, 'worker failed to start');
  await nativeConnection?.close();
  await clientConnection?.close();
  await dbPool?.end();
  await observability.shutdown();
  process.exitCode = 1;
}

const shutdown = createShutdownCoordinator(observability.logger, 'worker', [
  () => {
    ready = false;
  },
  () => {
    if (outboxPollTimer !== undefined) {
      clearInterval(outboxPollTimer);
      outboxPollTimer = undefined;
    }
  },
  () => worker?.shutdown(),
  () => workerRunPromise,
  () => server.close(),
  () => dbPool?.end(),
  () => clientConnection?.close(),
  () => nativeConnection?.close(),
  () => observability.shutdown(),
]);
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
