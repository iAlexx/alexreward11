import { Module, type DynamicModule } from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';

import { DependenciesService } from './dependencies.service.js';
import { HealthController } from './health.controller.js';
import { API_CONFIG } from './tokens.js';

@Module({})
export class AppModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [DependenciesService, { provide: API_CONFIG, useValue: config }],
    };
  }
}
