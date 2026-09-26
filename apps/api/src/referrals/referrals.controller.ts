import { Controller, Get, UseGuards } from '@nestjs/common';

import type { ReferralsSummaryResponse } from '@alex-rewards/contracts';

import { AccessSessionGuard } from '../auth/access-session.guard.js';

/**
 * Referral read surface.
 *
 * The referral tables (`referral_codes`, `referral_edges`, `referral_reward_events`) exist
 * from the approved schema phase, but `packages/referrals` is still a boundary shell: no
 * code issues a referral code, attributes an edge or activates one. Reporting counted zeros
 * would imply a working programme, so the summary reports `UNAVAILABLE` until a phase
 * approves the engine.
 */
@Controller('v1/referrals')
@UseGuards(AccessSessionGuard)
export class ReferralsController {
  @Get('summary')
  getSummary(): ReferralsSummaryResponse {
    return { status: 'UNAVAILABLE', data: null, reasonCode: 'ENGINE_NOT_ENABLED' };
  }
}
