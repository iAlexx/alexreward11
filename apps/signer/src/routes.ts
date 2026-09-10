import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';
import {
  LocalEphemeralSignPort,
  SignerError,
  localSigningFixtureConfig,
  signWithdrawalAttempt,
  type SignPort,
  type SignerRuntimeConfig,
} from '@alex-rewards/signing';
import type { Pool } from 'pg';

import { assertBearerAuth } from './auth.js';

const signBodySchema = z
  .object({
    withdrawalAttemptId: z.string().uuid(),
  })
  .strict();

export interface SignerRouteDeps {
  readonly pool: Pool;
  readonly serviceToken: string;
  readonly spikeEnabled: boolean;
  readonly signPort: SignPort;
  readonly runtime: SignerRuntimeConfig;
}

export async function registerSignerRoutes(
  server: FastifyInstance,
  deps: SignerRouteDeps,
): Promise<void> {
  const health = (): HealthResponse => ({
    contractVersion: HEALTH_CONTRACT_VERSION,
    service: 'signer',
    status: 'ok',
    timestamp: new Date().toISOString(),
    components: [
      {
        name: deps.spikeEnabled ? 'phase9-signing-boundary' : 'phase9-signing-disabled',
        state: 'ok',
      },
    ],
  });
  server.get('/health', async () => health());
  server.get('/health/live', async () => health());
  server.get('/health/ready', async () => health());

  server.post('/v1/sign-withdrawal-attempt', async (request, reply) => {
    try {
      assertBearerAuth(
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
        deps.serviceToken,
      );
      if (!deps.spikeEnabled) {
        throw new SignerError('SPIKE_DISABLED', 'Signer spike disabled');
      }
      const parsed = signBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new SignerError('INVALID_REQUEST', 'Body must be { withdrawalAttemptId: uuid } only');
      }
      const result = await signWithdrawalAttempt({
        pool: deps.pool,
        withdrawalAttemptId: parsed.data.withdrawalAttemptId,
        signPort: deps.signPort,
        config: deps.runtime,
      });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof SignerError) {
        const status =
          error.code === 'UNAUTHORIZED' ? 401 : error.code === 'ATTEMPT_NOT_FOUND' ? 404 : 400;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });
}

export function createLocalSignPort(): SignPort {
  return new LocalEphemeralSignPort();
}

export function runtimeFromEnv(config: {
  DEPLOYMENT_ENV: 'local' | 'test' | 'staging' | 'production';
  SIGNER_SPIKE_ENABLED: boolean;
  SIGNER_KMS_MODE: 'aws' | 'local_ephemeral';
  SIGNER_KMS_KEY_ARN?: string | undefined;
  SIGNER_NETWORK_CODE: string;
  SIGNER_NETWORK_GLOBAL_ID: number;
  SIGNER_WALLET_VERSION: 'v5R1';
  SIGNER_WORKCHAIN: number;
  SIGNER_EXPECTED_ASSET_SYMBOL: string;
}): SignerRuntimeConfig {
  return localSigningFixtureConfig({
    deploymentEnv: config.DEPLOYMENT_ENV,
    spikeEnabled: config.SIGNER_SPIKE_ENABLED,
    kmsMode: config.SIGNER_KMS_MODE,
    kmsKeyArn: config.SIGNER_KMS_KEY_ARN ?? null,
    networkCode: config.SIGNER_NETWORK_CODE,
    networkGlobalId: config.SIGNER_NETWORK_GLOBAL_ID,
    walletVersion: config.SIGNER_WALLET_VERSION,
    workchain: config.SIGNER_WORKCHAIN,
    expectedAssetSymbol: config.SIGNER_EXPECTED_ASSET_SYMBOL,
  });
}
