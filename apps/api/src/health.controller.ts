import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import {
  HEALTH_CONTRACT_VERSION,
  type HealthComponent,
  type HealthResponse,
} from '@alex-rewards/contracts';

import { DependenciesService } from './dependencies.service.js';

export function healthResponse(
  service: string,
  status: HealthResponse['status'],
  components?: readonly HealthComponent[],
): HealthResponse {
  return {
    contractVersion: HEALTH_CONTRACT_VERSION,
    service,
    status,
    timestamp: new Date().toISOString(),
    ...(components === undefined ? {} : { components }),
  };
}

@Controller('health')
export class HealthController {
  constructor(private readonly dependencies: DependenciesService) {}

  @Get()
  live(): HealthResponse {
    return healthResponse('api', 'ok');
  }

  @Get('live')
  liveness(): HealthResponse {
    return this.live();
  }

  @Get('ready')
  async readiness(): Promise<HealthResponse> {
    const components = await this.dependencies.probeAll();
    const status = components.every((component) => component.state === 'ok') ? 'ok' : 'unavailable';
    const response = healthResponse('api', status, components);
    if (status !== 'ok') throw new ServiceUnavailableException(response);
    return response;
  }
}
