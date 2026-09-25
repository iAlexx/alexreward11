import { Controller, Get, UseGuards } from '@nestjs/common';

import type { AdminSettingsFamiliesResponse } from '@alex-rewards/contracts';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';

/** Typed settings families only — no arbitrary config eval. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class SettingsController {
  @Get('settings/families')
  families(): AdminSettingsFamiliesResponse {
    return {
      contractVersion: '1',
      families: [
        'WITHDRAWAL_LIMITS',
        'REWARD_RULES',
        'PROVIDER_LIMITS',
        'EXPOSURE_LIMITS',
        'FEATURE_FLAGS',
        'MEMBERSHIP_BENEFITS',
        'NOTIFICATION_DRAFTS',
      ],
      typedOnly: true,
    };
  }
}
