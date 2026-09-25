import { Module, type DynamicModule } from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';

import { AdsController } from './ads/ads.controller.js';
import { AdsGramWebhookController } from './ads/adsgram-webhook.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AccessSessionGuard } from './auth/access-session.guard.js';
import { DependenciesService } from './dependencies.service.js';
import { HealthController } from './health.controller.js';
import { MeController } from './me/me.controller.js';
import { MembershipController } from './membership/membership.controller.js';
import { ReferralsController } from './referrals/referrals.controller.js';
import { TasksController } from './tasks/tasks.controller.js';
import { WalletsController } from './wallets/wallets.controller.js';
import { WithdrawalsController } from './withdrawals/withdrawals.controller.js';
import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from './tokens.js';

@Module({})
export class AppModule {
  static register(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        AuthController,
        MembershipController,
        WithdrawalsController,
        AdsController,
        AdsGramWebhookController,
        MeController,
        WalletsController,
        TasksController,
        ReferralsController,
      ],
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
