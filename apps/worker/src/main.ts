import { fileURLToPath } from 'node:url';

import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Runtime, Worker } from '@temporalio/worker';
import Fastify, { LogController } from 'fastify';
import { Pool } from 'pg';

import { loadWorkerConfig } from '@alex-rewards/config';
import { type HealthResponse } from '@alex-rewards/contracts';
import { createShutdownCoordinator, initializeObservability } from '@alex-rewards/observability';
import {
  processWithdrawalApprovedOutboxBatch,
  processWithdrawalFailedPreRetryOutboxBatch,
  processWithdrawalPhase21ManualDispatchOutboxBatch,
  processWithdrawalConfirmedPublicPayoutOutboxBatch,
  mapDeploymentEnvToFeatureEnvironment,
  buildPhase10PayoutConfig,
  buildPhase21PayoutConfig,
  selectWithdrawalPayoutAuthority,
  tryBuildPhase21ManualDispatchRelayAuthority,
  type Phase21PayoutConfig,
  type PublicPayoutFeatureEnvironment,
} from '@alex-rewards/withdrawals';

import { createWithdrawalActivities } from './activities.js';
import { buildWorkerHealth } from './health.js';
import { createWithdrawalOutboxPoller, startWithdrawalOutboxRelay } from './outbox-relay.js';
import {
  createReferralMaintenanceCycle,
  mapDeploymentEnvToRewardEnvironment,
  startReferralMaintenanceLoop,
} from './referral-maintenance.js';
import {
  createMissionMaintenanceCycle,
  startMissionMaintenanceLoop,
} from './mission-maintenance.js';
import { withdrawalEngineConfigFromWorker } from './withdrawal-engine-config.js';

const OUTBOX_POLL_INTERVAL_MS = 2_000;
const REFERRAL_MAINTENANCE_INTERVAL_MS = 5_000;
const MISSION_MAINTENANCE_INTERVAL_MS = 5_000;

const config = loadWorkerConfig();
const withdrawalConfig = withdrawalEngineConfigFromWorker(config);
const payoutAuthority = selectWithdrawalPayoutAuthority({
  phase21MainnetEnabled: config.PHASE21_MAINNET_ENABLED,
  withdrawalNetworkCode: config.WITHDRAWAL_NETWORK_CODE,
});
const phase10Config =
  payoutAuthority === 'PHASE10_TESTNET'
    ? buildPhase10PayoutConfig({
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
      })
    : undefined;
const phase21Config: Phase21PayoutConfig | undefined =
  payoutAuthority === 'PHASE21_MAINNET'
    ? buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        realChainEnabled: config.WITHDRAWAL_REAL_CHAIN_ENABLED,
        fakeChainEnabled: config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
        signerBaseUrl: config.SIGNER_BASE_URL,
        signerServiceToken: config.SIGNER_SERVICE_TOKEN ?? '',
        jettonMasterIdentity: config.TON_MAINNET_USDT_JETTON_MASTER ?? null,
        primaryProviderKind: config.TON_PRIMARY_PROVIDER_KIND,
        primaryProviderUrl: config.TON_PRIMARY_PROVIDER_URL,
        primaryProviderApiKey: config.TON_PRIMARY_PROVIDER_API_KEY,
        secondaryProviderKind: config.TON_SECONDARY_PROVIDER_KIND,
        secondaryProviderUrl: config.TON_SECONDARY_PROVIDER_URL,
        secondaryProviderApiKey: config.TON_SECONDARY_PROVIDER_API_KEY,
      })
    : undefined;
const realChainEnabled =
  phase21Config?.realChainEnabled ?? phase10Config?.realChainEnabled ?? false;
const phase21ManualDispatchAuthority = tryBuildPhase21ManualDispatchRelayAuthority({
  payoutAuthority,
  phase21MainnetEnabled: config.PHASE21_MAINNET_ENABLED,
  withdrawalNetworkCode: config.WITHDRAWAL_NETWORK_CODE,
  realChainEnabled: config.WITHDRAWAL_REAL_CHAIN_ENABLED,
  fakeChainEnabled: config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
  phase21: phase21Config ?? null,
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
let referralMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
let missionMaintenanceTimer: ReturnType<typeof setInterval> | undefined;
let publicPayoutFeatureEnvironment: PublicPayoutFeatureEnvironment | undefined;

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
    payoutAuthority,
    ...(phase10Config !== undefined ? { phase10: phase10Config } : {}),
    ...(phase21Config !== undefined ? { phase21: phase21Config } : {}),
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

  try {
    publicPayoutFeatureEnvironment = mapDeploymentEnvToFeatureEnvironment(config.DEPLOYMENT_ENV);
  } catch (error) {
    publicPayoutFeatureEnvironment = undefined;
    observability.logger.warn(
      { err: error, deploymentEnv: config.DEPLOYMENT_ENV },
      'public payout outbox consumer disabled: DEPLOYMENT_ENV unmapped (fail closed)',
    );
  }

  // Historical poll when enabled. Disabled staging integration never arms this interval.
  // Confirmed public-payout handler creates publications only — never Telegram.
  outboxPollTimer = startWithdrawalOutboxRelay({
    enabled: config.WORKER_OUTBOX_RELAY_ENABLED,
    intervalMs: OUTBOX_POLL_INTERVAL_MS,
    poll: async () => {
      if (dbPool === undefined || temporalClient === undefined) return;
      const pool = dbPool;
      const client = temporalClient;
      const publicPayoutEnvironment = publicPayoutFeatureEnvironment;
      await createWithdrawalOutboxPoller({
        processApproved: () =>
          processWithdrawalApprovedOutboxBatch(pool, {
            client,
            taskQueue: config.TEMPORAL_TASK_QUEUE,
            fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
            realChainEnabled,
          }),
        processFailedPreRetry: () =>
          processWithdrawalFailedPreRetryOutboxBatch(pool, {
            client,
            taskQueue: config.TEMPORAL_TASK_QUEUE,
            fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
            realChainEnabled,
          }),
        processPhase21ManualDispatch: () =>
          processWithdrawalPhase21ManualDispatchOutboxBatch(pool, {
            client,
            taskQueue: config.TEMPORAL_TASK_QUEUE,
            authority: phase21ManualDispatchAuthority,
          }),
        processConfirmedPublicPayout: async () => {
          if (publicPayoutEnvironment === undefined) return;
          await processWithdrawalConfirmedPublicPayoutOutboxBatch(pool, {
            environment: publicPayoutEnvironment,
          });
        },
      })();
    },
    onError: (error) => {
      observability.logger.warn({ err: error }, 'withdrawal outbox relay batch failed');
    },
  });

  if (!config.WORKER_OUTBOX_RELAY_ENABLED) {
    observability.logger.info({ outboxRelayEnabled: false }, 'withdrawal outbox relay disabled');
  }

  let referralMaintenanceEnabled = true;
  try {
    mapDeploymentEnvToRewardEnvironment(config.DEPLOYMENT_ENV);
  } catch (error) {
    referralMaintenanceEnabled = false;
    observability.logger.warn(
      { err: error, deploymentEnv: config.DEPLOYMENT_ENV },
      'referral maintenance disabled: DEPLOYMENT_ENV unmapped (fail closed)',
    );
  }

  if (referralMaintenanceEnabled && dbPool !== undefined) {
    const cycle = createReferralMaintenanceCycle({
      pool: dbPool,
      deploymentEnv: config.DEPLOYMENT_ENV,
    });
    referralMaintenanceTimer = startReferralMaintenanceLoop({
      enabled: true,
      intervalMs: REFERRAL_MAINTENANCE_INTERVAL_MS,
      poll: async () => {
        await cycle();
      },
      onError: (error) => {
        observability.logger.warn({ err: error }, 'referral maintenance batch failed');
      },
    });
  }

  let missionMaintenanceEnabled = referralMaintenanceEnabled;
  if (missionMaintenanceEnabled && dbPool !== undefined) {
    const missionCycle = createMissionMaintenanceCycle({
      pool: dbPool,
      deploymentEnv: config.DEPLOYMENT_ENV,
    });
    missionMaintenanceTimer = startMissionMaintenanceLoop({
      enabled: true,
      intervalMs: MISSION_MAINTENANCE_INTERVAL_MS,
      poll: async () => {
        await missionCycle();
      },
      onError: (error) => {
        observability.logger.warn({ err: error }, 'mission maintenance batch failed');
      },
    });
  }

  observability.logger.info(
    {
      port: config.WORKER_PORT,
      listenHost: config.WORKER_LISTEN_HOST,
      taskQueue: config.TEMPORAL_TASK_QUEUE,
      fakeChainEnabled: withdrawalConfig.fakeChainEnabled,
      realChainEnabled,
      payoutAuthority,
      outboxRelayEnabled: config.WORKER_OUTBOX_RELAY_ENABLED,
      referralMaintenanceEnabled,
      missionMaintenanceEnabled,
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
  () => {
    if (referralMaintenanceTimer !== undefined) {
      clearInterval(referralMaintenanceTimer);
      referralMaintenanceTimer = undefined;
    }
  },
  () => {
    if (missionMaintenanceTimer !== undefined) {
      clearInterval(missionMaintenanceTimer);
      missionMaintenanceTimer = undefined;
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
