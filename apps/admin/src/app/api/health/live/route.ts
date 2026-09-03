import { HEALTH_CONTRACT_VERSION, type HealthResponse } from '@alex-rewards/contracts';

export function GET(): Response {
  const body: HealthResponse = {
    contractVersion: HEALTH_CONTRACT_VERSION,
    service: 'admin',
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
  return Response.json(body);
}
