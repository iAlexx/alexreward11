import { Module, type DynamicModule } from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';

import { AuthController } from './auth/auth.controller.js';
import { AccessSessionGuard } from './auth/access-session.guard.js';
import { DependenciesService } from './dependencies.service.js';
import { HealthController } from './health.controller.js';
import { MembershipController } from './membership/membership.controller.js';
import { WithdrawalsController } from './withdrawals/withdrawals.controller.js';
import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from './tokens.js';

@Module({})
export class AppModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, AuthController, MembershipController, WithdrawalsController],
      providers: [
        DependenciesService,
        AccessSessionGuard,
        { provide: API_CONFIG, useValue: config },
        {
          provide: DATABASE_POOL,
          inject: [DependenciesService],
          useFactory: (dependencies: DependenciesService) => dependencies.database,
        },
        {
          provide: REDIS_CLIENT,
          inject: [DependenciesService],
          useFactory: async (dependencies: DependenciesService) => dependencies.ensureRedis(),
        },
      ],
    };
  }
}
