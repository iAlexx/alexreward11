import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { LocalEphemeralSignPort, localSigningFixtureConfig } from '@alex-rewards/signing';
import { Pool } from 'pg';

import { registerSignerRoutes } from '../src/routes.js';

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
