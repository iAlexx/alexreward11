import { Module, type DynamicModule } from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';

import { AdminAuthController } from './admin-auth/admin-auth.controller.js';
import { AdminSessionGuard } from './admin-auth/admin-session.guard.js';
import { AdsAdminController } from './admin/ads-admin.controller.js';
import { AuditController } from './admin/audit.controller.js';
import { EconomicsController } from './admin/economics.controller.js';
import { EntitlementsAdminController } from './admin/entitlements-admin.controller.js';
import { ExposureController } from './admin/exposure.controller.js';
import { FeatureFlagsController } from './admin/feature-flags.controller.js';
import { FraudAdminController } from './admin/fraud-admin.controller.js';
import { HotWalletController } from './admin/hot-wallet.controller.js';
import { LedgerAdminController } from './admin/ledger-admin.controller.js';
import { MembershipsAdminController } from './admin/memberships-admin.controller.js';
import { MissionsAdminController } from './admin/missions-admin.controller.js';
import { NotificationsAdminController } from './admin/notifications-admin.controller.js';
import { OverviewController } from './admin/overview.controller.js';
import { PolicyCenterController } from './admin/policy-center.controller.js';
import { ProvidersAdminController } from './admin/providers-admin.controller.js';
import { ReferralAdminController } from './admin/referral-admin.controller.js';
import { RewardEngineAdminController } from './admin/reward-engine-admin.controller.js';
import { ReviewQueueController } from './admin/review-queue.controller.js';
import { SettingsController } from './admin/settings.controller.js';
import { SupportAdminController } from './admin/support-admin.controller.js';
import { SystemController } from './admin/system.controller.js';
import { UsersController } from './admin/users.controller.js';
import { WithdrawalsAdminController } from './admin/withdrawals-admin.controller.js';
import { AdsController } from './ads/ads.controller.js';
import { AdsGramWebhookController } from './ads/adsgram-webhook.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AccessSessionGuard } from './auth/access-session.guard.js';
import { DependenciesService } from './dependencies.service.js';
import { HealthController } from './health.controller.js';
import { MeController } from './me/me.controller.js';
import { MembershipController } from './membership/membership.controller.js';
import { ReferralsController } from './referrals/referrals.controller.js';
import { SupportController } from './support/support.controller.js';
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
        AdminAuthController,
        OverviewController,
        UsersController,
        WithdrawalsAdminController,
        HotWalletController,
        LedgerAdminController,
        AdsAdminController,
        ProvidersAdminController,
        RewardEngineAdminController,
        MembershipsAdminController,
        EntitlementsAdminController,
        PolicyCenterController,
        EconomicsController,
        ExposureController,
        ReviewQueueController,
        FeatureFlagsController,
        MissionsAdminController,
        NotificationsAdminController,
        FraudAdminController,
        ReferralAdminController,
        SupportAdminController,
        AuditController,
        SystemController,
        SettingsController,
        MembershipController,
        WithdrawalsController,
        AdsController,
        AdsGramWebhookController,
        MeController,
        WalletsController,
        TasksController,
        ReferralsController,
        SupportController,
      ],
      providers: [
        DependenciesService,
        AccessSessionGuard,
        AdminSessionGuard,
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
