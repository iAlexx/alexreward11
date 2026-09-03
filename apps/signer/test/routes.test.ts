import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { registerSignerFoundationRoutes } from '../src/routes.js';

describe('Phase 1 signer boundary', () => {
  it('exposes health only and has no signing endpoint', async () => {
    const server = Fastify();
    await registerSignerFoundationRoutes(server);
    expect((await server.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url: '/sign' })).statusCode).toBe(404);
    await server.close();
  });
});
