import { Controller, Get, UseGuards } from '@nestjs/common';

import type { AdminMissionsFoundationResponse } from '@alex-rewards/contracts';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';

/** Mission administration foundation — Phase 16 engine not enabled. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class MissionsAdminController {
  @Get('missions')
  list(): AdminMissionsFoundationResponse {
    return {
      contractVersion: '1',
      status: 'UNAVAILABLE',
      reasonCode: 'ENGINE_NOT_ENABLED',
      data: null,
    };
  }
}
