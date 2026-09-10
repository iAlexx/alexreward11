import Fastify, { LogController } from 'fastify';

import { loadSignerConfig } from '@alex-rewards/config';
import { createDatabasePool } from '@alex-rewards/db';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';
import {
  EncryptedLocalSigningProvider,
  LocalEphemeralSignPort,
  type LockableSignPort,
  type SignPort,
} from '@alex-rewards/signing';

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
let lockable: LockableSignPort | undefined;
if (config.SIGNER_KEY_MODE === 'self_hosted_encrypted') {
  const provider = new EncryptedLocalSigningProvider({
    ...(config.SIGNER_KEY_BUNDLE_PATH !== undefined
      ? { bundlePath: config.SIGNER_KEY_BUNDLE_PATH }
      : {}),
    expectedPublicKeyFingerprint: config.SIGNER_EXPECTED_SIGNER_REFERENCE ?? null,
    expectedNetworkGlobalId: config.SIGNER_NETWORK_GLOBAL_ID,
  });
  signPort = provider;
  lockable = provider;
} else {
  signPort = new LocalEphemeralSignPort();
}

try {
  await registerSignerRoutes(server, {
    pool,
    serviceToken: config.SIGNER_SERVICE_TOKEN,
    spikeEnabled: config.SIGNER_SPIKE_ENABLED,
    signPort,
    lockable,
    runtime,
  });
  // Bind loopback-only for local unlock safety when self-hosted; compose may still map host ports.
  const host = config.SIGNER_KEY_MODE === 'self_hosted_encrypted' ? '127.0.0.1' : '0.0.0.0';
  await server.listen({ port: config.SIGNER_PORT, host });
  observability.logger.info(
    {
      port: config.SIGNER_PORT,
      host,
      signingEnabled: config.SIGNER_SPIKE_ENABLED,
      keyMode: config.SIGNER_KEY_MODE,
      custodyState: lockable?.custodyState ?? 'n/a',
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
    lockable?.relock();
    await pool.end();
  },
  () => observability.shutdown(),
]);
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
