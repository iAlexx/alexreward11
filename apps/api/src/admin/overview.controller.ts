import { Controller, Get, UseGuards } from '@nestjs/common';

import type { AdminOverviewResponse } from '@alex-rewards/contracts';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';

/**
 * Overview aggregates availability of Admin domains.
 * Never fabricates zeros as known financial values.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class OverviewController {
  @Get('overview')
  overview(): AdminOverviewResponse {
    return {
      contractVersion: '1',
      domains: [
        { key: 'users', status: 'READY' },
        { key: 'withdrawals', status: 'READY' },
        { key: 'hot_wallet', status: 'READY' },
        { key: 'ledger', status: 'READY' },
        { key: 'ads', status: 'READY' },
        { key: 'providers', status: 'READY' },
        { key: 'reward_engine', status: 'READY' },
        { key: 'memberships', status: 'READY' },
        { key: 'entitlements', status: 'READY' },
        { key: 'policy_center', status: 'READY' },
        { key: 'economics', status: 'READY' },
        { key: 'exposure', status: 'READY' },
        { key: 'review_queue', status: 'READY' },
        { key: 'feature_flags', status: 'READY' },
        { key: 'audit', status: 'READY' },
        { key: 'system', status: 'READY' },
        { key: 'settings', status: 'READY' },
        { key: 'support', status: 'READY' },
        { key: 'notifications', status: 'READY' },
        {
          key: 'missions',
          status: 'ENGINE_NOT_ENABLED',
          reasonCode: 'ENGINE_NOT_ENABLED',
        },
        {
          key: 'referrals',
          status: 'ENGINE_NOT_ENABLED',
          reasonCode: 'ENGINE_NOT_ENABLED',
        },
        {
          key: 'fraud_engine',
          status: 'READY',
        },
      ],
    };
  }
}
