import type { FastifyInstance } from 'fastify';

import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';

export async function registerSignerFoundationRoutes(server: FastifyInstance): Promise<void> {
  const health = (): HealthResponse => ({
    contractVersion: HEALTH_CONTRACT_VERSION,
    service: 'signer',
    status: 'ok',
    timestamp: new Date().toISOString(),
    components: [{ name: 'phase1-non-signing-boundary', state: 'ok' }],
  });
  server.get('/health', async () => health());
  server.get('/health/live', async () => health());
  server.get('/health/ready', async () => health());
}
