import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import Fastify, { LogController } from 'fastify';
import { Pool } from 'pg';

import { loadWorkerConfig, type WorkerConfig } from '@alex-rewards/config';
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';
import {
  processWithdrawalApprovedOutboxBatch,
  withdrawalEngineConfigFromValidatedApi,
  type WithdrawalEngineConfig,
} from '@alex-rewards/withdrawals';

import { createWithdrawalActivities } from './activities.js';

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
let outboxPollInFlight = false;

const health = (status: HealthResponse['status']): HealthResponse => ({
  contractVersion: HEALTH_CONTRACT_VERSION,
  service: 'worker',
  status,
  timestamp: new Date().toISOString(),
  components: [{ name: 'temporal-worker', state: status }],
});
server.get('/health/live', async () => health('ok'));
server.get('/health/ready', async (_request, reply) => {
  const status = ready ? 'ok' : 'unavailable';
  return reply.code(ready ? 200 : 503).send(health(status));
});
server.get('/health', async () => health('ok'));

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
  });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
    activities,
  });
  await server.listen({ port: config.WORKER_PORT, host: '0.0.0.0' });
  ready = true;
  workerRunPromise = worker.run().catch((error: unknown) => {
    ready = false;
    observability.logger.error({ err: error }, 'temporal worker stopped unexpectedly');
    process.exitCode = 1;
  });

  // Always poll when DATABASE_URL is present; activities fail closed if fake disabled.
  outboxPollTimer = setInterval(() => {
    if (outboxPollInFlight || dbPool === undefined || temporalClient === undefined) return;
    outboxPollInFlight = true;
    void processWithdrawalApprovedOutboxBatch(dbPool, {
      client: temporalClient,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
    })
      .catch((error: unknown) => {
        observability.logger.warn({ err: error }, 'withdrawal outbox relay batch failed');
      })
      .finally(() => {
        outboxPollInFlight = false;
      });
  }, OUTBOX_POLL_INTERVAL_MS);

  observability.logger.info(
    {
      port: config.WORKER_PORT,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
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
