import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  LocalEphemeralSignPort,
  PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
  localSigningFixtureConfig,
} from '@alex-rewards/signing';
import { Pool } from 'pg';

import { isLoopback, registerSignerRoutes, runtimeFromEnv } from '../src/routes.js';

describe('isLoopback local-unlock peer allowlist', () => {
  it('accepts only the exact loopback address forms required by the runtime', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects ordinary Docker-network peers and suffix lookalikes', () => {
    expect(isLoopback('172.18.0.5')).toBe(false);
    expect(isLoopback('10.0.0.12')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
    expect(isLoopback('attacker.example/127.0.0.1')).toBe(false);
    expect(isLoopback('not-loopback-127.0.0.1')).toBe(false);
    expect(isLoopback('127.0.0.1.extra')).toBe(false);
    expect(isLoopback(' 127.0.0.1')).toBe(false);
  });

  it('rejects undefined, empty, and non-IP values', () => {
    expect(isLoopback(undefined)).toBe(false);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback('localhost')).toBe(false);
    expect(isLoopback('loopback')).toBe(false);
    expect(isLoopback('0.0.0.0')).toBe(false);
  });
});

describe('Phase 9 signer HTTP boundary', () => {
  it('exposes health and rejects unauthenticated / generic sign routes', async () => {
    const pool = new Pool({ connectionString: 'postgresql://invalid' });
    const server = Fastify();
    await registerSignerRoutes(server, {
      pool,
      serviceToken: 'a-secure-local-token-that-is-long-enough',
      spikeEnabled: true,
      signPort: new LocalEphemeralSignPort(),
      runtime: localSigningFixtureConfig(),
    });
    expect((await server.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: '/sign' })).statusCode).toBe(404);
    expect((await server.inject({ method: 'POST', url: '/kms/sign' })).statusCode).toBe(404);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/sign-withdrawal-attempt',
          payload: { withdrawalAttemptId: '00000000-0000-4000-8000-000000000001' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/v1/sign-withdrawal-attempt',
          headers: { authorization: 'Bearer a-secure-local-token-that-is-long-enough' },
          payload: { withdrawalAttemptId: 'not-a-uuid', amount: '1' },
        })
      ).statusCode,
    ).toBe(400);
    await server.close();
    await pool.end();
  });
});

describe('runtimeFromEnv Phase 21 Mainnet transfer policy', () => {
  it('wires PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE when Mainnet enabled', () => {
    const runtime = runtimeFromEnv({
      DEPLOYMENT_ENV: 'production',
      SIGNER_SPIKE_ENABLED: true,
      SIGNER_KEY_MODE: 'self_hosted_encrypted',
      SIGNER_NETWORK_CODE: 'TON_MAINNET',
      SIGNER_NETWORK_GLOBAL_ID: -239,
      SIGNER_WALLET_VERSION: 'v5R1',
      SIGNER_WORKCHAIN: 0,
      SIGNER_EXPECTED_ASSET_SYMBOL: 'USDT',
      PHASE21_MAINNET_ENABLED: true,
    });
    expect(runtime.phase21MainnetEnabled).toBe(true);
    expect(runtime.mainnetTransferPolicy).toEqual(
      PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
    );
  });

  it('keeps mainnetTransferPolicy null when Mainnet disabled', () => {
    const runtime = runtimeFromEnv({
      DEPLOYMENT_ENV: 'local',
      SIGNER_SPIKE_ENABLED: true,
      SIGNER_KEY_MODE: 'local_ephemeral',
      SIGNER_NETWORK_CODE: 'TON_TESTNET',
      SIGNER_NETWORK_GLOBAL_ID: -3,
      SIGNER_WALLET_VERSION: 'v5R1',
      SIGNER_WORKCHAIN: 0,
      SIGNER_EXPECTED_ASSET_SYMBOL: 'USDT',
      PHASE21_MAINNET_ENABLED: false,
    });
    expect(runtime.phase21MainnetEnabled).toBe(false);
    expect(runtime.mainnetTransferPolicy).toBeNull();
  });
});

describe('GET /v1/signing-identity Phase 21 Mainnet identity', () => {
  const serviceToken = 'a-secure-local-token-that-is-long-enough';

  it('rejects unauthenticated requests', async () => {
    const pool = new Pool({ connectionString: 'postgresql://invalid' });
    const server = Fastify();
    await registerSignerRoutes(server, {
      pool,
      serviceToken,
      spikeEnabled: true,
      signPort: new LocalEphemeralSignPort(),
      runtime: localSigningFixtureConfig({
        phase21MainnetEnabled: true,
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
        keyMode: 'self_hosted_encrypted',
        deploymentEnv: 'production',
        mainnetTransferPolicy: PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
      }),
    });

    const res = await server.inject({ method: 'GET', url: '/v1/signing-identity' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'UNAUTHORIZED' });

    await server.close();
    await pool.end();
  });

  it('returns Wallet V5R1 identity when Mainnet networkGlobalId=-239 and Phase 21 is enabled', async () => {
    const pool = new Pool({ connectionString: 'postgresql://invalid' });
    const server = Fastify();
    await registerSignerRoutes(server, {
      pool,
      serviceToken,
      spikeEnabled: true,
      signPort: new LocalEphemeralSignPort(),
      runtime: localSigningFixtureConfig({
        phase21MainnetEnabled: true,
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
        keyMode: 'self_hosted_encrypted',
        deploymentEnv: 'production',
        mainnetTransferPolicy: PHASE21_MAINNET_FORWARD_APPROVED_POLICY_TEMPLATE,
      }),
    });

    const res = await server.inject({
      method: 'GET',
      url: '/v1/signing-identity',
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      publicKeyHex: string;
      publicKeyFingerprint: string;
      walletAddressRaw: string;
      signingReady: boolean;
    };
    expect(body.signingReady).toBe(true);
    expect(body.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(body.publicKeyFingerprint).toMatch(/^[0-9a-f]+$/);
    expect(body.walletAddressRaw).toMatch(/^-?[0-9]:[0-9a-fA-F]{64}$/);

    await server.close();
    await pool.end();
  });

  it('still rejects Mainnet identity when Phase 21 is disabled', async () => {
    const pool = new Pool({ connectionString: 'postgresql://invalid' });
    const server = Fastify();
    await registerSignerRoutes(server, {
      pool,
      serviceToken,
      spikeEnabled: true,
      signPort: new LocalEphemeralSignPort(),
      runtime: localSigningFixtureConfig({
        phase21MainnetEnabled: false,
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
      }),
    });

    const res = await server.inject({
      method: 'GET',
      url: '/v1/signing-identity',
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'MAINNET_REJECTED',
      message: expect.stringMatching(/Phase 9 rejects MAINNET Wallet V5 R1 identity/),
    });

    await server.close();
    await pool.end();
  });

  it('preserves authenticated Testnet identity when Phase 21 is disabled', async () => {
    const pool = new Pool({ connectionString: 'postgresql://invalid' });
    const server = Fastify();
    await registerSignerRoutes(server, {
      pool,
      serviceToken,
      spikeEnabled: true,
      signPort: new LocalEphemeralSignPort(),
      runtime: localSigningFixtureConfig(),
    });

    const res = await server.inject({
      method: 'GET',
      url: '/v1/signing-identity',
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ signingReady: true });

    await server.close();
    await pool.end();
  });
});
