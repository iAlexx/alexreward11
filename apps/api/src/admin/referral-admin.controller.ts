import { Controller, Get, UseGuards } from '@nestjs/common';

import type { AdminReferralFoundationResponse } from '@alex-rewards/contracts';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';

/** Referral Admin foundation — Phase 15 engine not enabled. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class ReferralAdminController {
  @Get('referrals')
  foundation(): AdminReferralFoundationResponse {
    return {
      contractVersion: '1',
      status: 'UNAVAILABLE',
      reasonCode: 'ENGINE_NOT_ENABLED',
      data: null,
    };
  }
}
