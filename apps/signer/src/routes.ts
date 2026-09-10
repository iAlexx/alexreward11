import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';
import {
  LocalEphemeralSignPort,
  SignerError,
  deriveWalletV5R1,
  localSigningFixtureConfig,
  publicKeyFingerprint,
  signWithdrawalAttempt,
  type LockableSignPort,
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

const unlockBodySchema = z
  .object({
    passphrase: z.string().min(16).max(1024),
  })
  .strict();

export interface SignerRouteDeps {
  readonly pool: Pool;
  readonly serviceToken: string;
  readonly spikeEnabled: boolean;
  readonly signPort: SignPort;
  readonly lockable?: LockableSignPort | undefined;
  readonly runtime: SignerRuntimeConfig;
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.endsWith('127.0.0.1')
  );
}

export async function registerSignerRoutes(
  server: FastifyInstance,
  deps: SignerRouteDeps,
): Promise<void> {
  const health = (): HealthResponse => {
    const signingReady = deps.lockable ? deps.lockable.isSigningReady() : deps.spikeEnabled;
    return {
      contractVersion: HEALTH_CONTRACT_VERSION,
      service: 'signer',
      status: 'ok',
      timestamp: new Date().toISOString(),
      components: [
        {
          name: deps.spikeEnabled ? 'phase9-signing-boundary' : 'phase9-signing-disabled',
          state: 'ok',
        },
        {
          name: 'signing-readiness',
          state: signingReady ? 'ok' : 'degraded',
        },
      ],
    };
  };
  server.get('/health', async () => health());
  server.get('/health/live', async () => health());
  server.get('/health/ready', async (_request, reply) => {
    const body = health();
    const signingReady = deps.lockable ? deps.lockable.isSigningReady() : true;
    if (!signingReady) {
      return reply.code(503).send({ ...body, signingReady: false, custodyState: 'LOCKED' });
    }
    return { ...body, signingReady: true, custodyState: deps.lockable?.custodyState ?? 'n/a' };
  });

  /**
   * Local-only unlock — loopback clients only. Not an Internet unlock endpoint.
   * Passphrase is never logged.
   */
  server.post('/v1/local-unlock', async (request, reply) => {
    try {
      if (!isLoopback(request.ip) && !isLoopback(request.socket.remoteAddress)) {
        throw new SignerError('UNAUTHORIZED', 'local-unlock requires loopback client');
      }
      assertBearerAuth(
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
        deps.serviceToken,
      );
      if (!deps.lockable) {
        throw new SignerError(
          'ACTION_UNAVAILABLE',
          'Unlock is only available for encrypted custody',
        );
      }
      const parsed = unlockBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new SignerError('INVALID_REQUEST', 'Body must be { passphrase } only');
      }
      await deps.lockable.unlock(parsed.data.passphrase);
      return reply.code(200).send({
        custodyState: deps.lockable.custodyState,
        signingReady: deps.lockable.isSigningReady(),
      });
    } catch (error) {
      if (error instanceof SignerError) {
        const status = error.code === 'UNAUTHORIZED' ? 401 : 400;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  server.post('/v1/local-relock', async (request, reply) => {
    try {
      if (!isLoopback(request.ip) && !isLoopback(request.socket.remoteAddress)) {
        throw new SignerError('UNAUTHORIZED', 'local-relock requires loopback client');
      }
      assertBearerAuth(
        typeof request.headers.authorization === 'string'
          ? request.headers.authorization
          : undefined,
        deps.serviceToken,
      );
      if (!deps.lockable) {
        throw new SignerError(
          'ACTION_UNAVAILABLE',
          'Relock is only available for encrypted custody',
        );
      }
      deps.lockable.relock();
      return reply.code(200).send({
        custodyState: deps.lockable.custodyState,
        signingReady: false,
      });
    } catch (error) {
      if (error instanceof SignerError) {
        const status = error.code === 'UNAUTHORIZED' ? 401 : 400;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /**
   * Read-only signing identity for Phase 10 attempt construction.
   * Returns public key + derived wallet address when signing is ready.
   * Never returns private key material or passphrases.
   */
  server.get('/v1/signing-identity', async (request, reply) => {
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
      const signingReady = deps.lockable ? deps.lockable.isSigningReady() : true;
      if (!signingReady) {
        return reply.code(503).send({
          error: 'SIGNING_LOCKED',
          message: 'Signer custody is locked',
          signingReady: false,
          custodyState: deps.lockable?.custodyState ?? 'LOCKED',
        });
      }
      const publicKey = await deps.signPort.getPublicKey();
      const fingerprint = publicKeyFingerprint(publicKey);
      const derived = deriveWalletV5R1({
        publicKey,
        networkGlobalId: deps.runtime.networkGlobalId,
        workchain: deps.runtime.workchain,
      });
      return reply.code(200).send({
        publicKeyHex: publicKey.toString('hex'),
        publicKeyFingerprint: fingerprint,
        walletAddressRaw: derived.addressRaw,
        signingReady: true,
        custodyState: deps.lockable?.custodyState ?? 'n/a',
      });
    } catch (error) {
      if (error instanceof SignerError) {
        const status = error.code === 'UNAUTHORIZED' ? 401 : 400;
        return reply.code(status).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

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
  SIGNER_KEY_MODE: 'self_hosted_encrypted' | 'local_ephemeral';
  SIGNER_KEY_BUNDLE_PATH?: string | undefined;
  SIGNER_EXPECTED_SIGNER_REFERENCE?: string | undefined;
  SIGNER_NETWORK_CODE: string;
  SIGNER_NETWORK_GLOBAL_ID: number;
  SIGNER_WALLET_VERSION: 'v5R1';
  SIGNER_WORKCHAIN: number;
  SIGNER_EXPECTED_ASSET_SYMBOL: string;
}): SignerRuntimeConfig {
  return localSigningFixtureConfig({
    deploymentEnv: config.DEPLOYMENT_ENV,
    spikeEnabled: config.SIGNER_SPIKE_ENABLED,
    keyMode: config.SIGNER_KEY_MODE,
    keyBundlePath: config.SIGNER_KEY_BUNDLE_PATH ?? null,
    expectedSignerReference: config.SIGNER_EXPECTED_SIGNER_REFERENCE ?? null,
    networkCode: config.SIGNER_NETWORK_CODE,
    networkGlobalId: config.SIGNER_NETWORK_GLOBAL_ID,
    walletVersion: config.SIGNER_WALLET_VERSION,
    workchain: config.SIGNER_WORKCHAIN,
    expectedAssetSymbol: config.SIGNER_EXPECTED_ASSET_SYMBOL,
  });
}
