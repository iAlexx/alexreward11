import { fileURLToPath } from 'node:url';

import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import Fastify, { LogController } from 'fastify';

import { loadWorkerConfig } from '@alex-rewards/config';
import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';

const config = loadWorkerConfig();
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
let connection: NativeConnection | undefined;
let worker: Worker | undefined;
let workerRunPromise: Promise<void> | undefined;
let ready = false;

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
  connection = await NativeConnection.connect({ address: config.TEMPORAL_ADDRESS });
  worker = await Worker.create({
    connection,
    namespace: config.TEMPORAL_NAMESPACE,
    taskQueue: config.TEMPORAL_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.js', import.meta.url)),
  });
  await server.listen({ port: config.WORKER_PORT, host: '0.0.0.0' });
  ready = true;
  workerRunPromise = worker.run().catch((error: unknown) => {
    ready = false;
    observability.logger.error({ err: error }, 'temporal worker stopped unexpectedly');
    process.exitCode = 1;
  });
  observability.logger.info(
    { port: config.WORKER_PORT, taskQueue: config.TEMPORAL_TASK_QUEUE },
    'worker listening',
  );
} catch (error) {
  observability.logger.fatal({ err: error }, 'worker failed to start');
  await connection?.close();
  await observability.shutdown();
  process.exitCode = 1;
}

const shutdown = createShutdownCoordinator(observability.logger, 'worker', [
  () => {
    ready = false;
  },
  () => worker?.shutdown(),
  () => workerRunPromise,
  () => server.close(),
  () => connection?.close(),
  () => observability.shutdown(),
]);
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
