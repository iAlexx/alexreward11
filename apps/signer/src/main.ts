import Fastify, { LogController } from 'fastify';

import { loadSignerConfig } from '@alex-rewards/config';
import { createDatabasePool } from '@alex-rewards/db';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';
import { LocalEphemeralSignPort, type SignPort } from '@alex-rewards/signing';

import { AwsKmsSignPort } from './kms/aws-kms.js';
import { registerSignerRoutes, runtimeFromEnv } from './routes.js';

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

const pool = createDatabasePool(config.SIGNER_DATABASE_URL);
const runtime = runtimeFromEnv(config);

let signPort: SignPort;
if (config.SIGNER_KMS_MODE === 'aws') {
  if (!config.SIGNER_KMS_KEY_ARN) {
    throw new Error('SIGNER_KMS_KEY_ARN required for aws mode');
  }
  signPort = new AwsKmsSignPort({
    region: config.SIGNER_AWS_REGION,
    keyArn: config.SIGNER_KMS_KEY_ARN,
  });
} else {
  signPort = new LocalEphemeralSignPort();
}

try {
  await registerSignerRoutes(server, {
    pool,
    serviceToken: config.SIGNER_SERVICE_TOKEN,
    spikeEnabled: config.SIGNER_SPIKE_ENABLED,
    signPort,
    runtime,
  });
  await server.listen({ port: config.SIGNER_PORT, host: '0.0.0.0' });
  observability.logger.info(
    {
      port: config.SIGNER_PORT,
      signingEnabled: config.SIGNER_SPIKE_ENABLED,
      kmsMode: config.SIGNER_KMS_MODE,
    },
    'signer boundary listening',
  );
} catch (error) {
  observability.logger.fatal({ err: error }, 'signer failed to start');
  await observability.shutdown();
  process.exitCode = 1;
}

const shutdown = createShutdownCoordinator(observability.logger, 'signer', [
  () => server.close(),
  async () => {
    await pool.end();
  },
  () => observability.shutdown(),
]);
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
