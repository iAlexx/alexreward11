import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';
import type {
  ReferralCodeResponse,
  ReferralsSummaryResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import {
  buildReferralMiniAppLaunchLink,
  ensureReferralCode,
  readReferralSummary,
  ReferralDomainError,
} from '@alex-rewards/referrals';

import {
  AccessSessionGuard,
  CurrentAuthUser,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';

function deepLinkFor(config: ApiConfig, code: string | null): string | null {
  if (code === null || code === '') return null;
  const bot = config.TELEGRAM_PUBLIC_BOT_USERNAME;
  if (bot === undefined) return null;
  // User-facing share link opens Mini App directly (?startapp=ref_<code>).
  return buildReferralMiniAppLaunchLink(bot, code);
}

/**
 * Referral read/ensure surface (Phase 15).
 * Counts and codes are server-authoritative. No client-selected codes.
 * Deep links require typed TELEGRAM_PUBLIC_BOT_USERNAME + Telegram-safe code.
 */
@Controller('v1/referrals')
@UseGuards(AccessSessionGuard)
export class ReferralsController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('summary')
  async getSummary(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<ReferralsSummaryResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const summary = await readReferralSummary(client, { userId: auth.userId });
      await client.query('COMMIT');
      return {
        status: 'READY',
        data: {
          referralCode: summary.referralCode,
          referralDeepLink: deepLinkFor(this.config, summary.referralCode),
          invitedCount: summary.invitedCount,
          activatedCount: summary.activatedCount,
        },
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      return { status: 'UNAVAILABLE', data: null, reasonCode: 'READ_FAILED' };
    } finally {
      client.release();
    }
  }

  @Get('code')
  async getOrEnsureCode(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<ReferralCodeResponse> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ensured = await ensureReferralCode(client, { userId: auth.userId });
      await client.query('COMMIT');
      return {
        status: 'READY',
        code: ensured.code,
        deepLink: deepLinkFor(this.config, ensured.code),
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore
      }
      if (
        error instanceof ReferralDomainError &&
        error.code === 'REFERRAL_CODE_POLICY_NOT_CONFIGURED'
      ) {
        return { status: 'UNAVAILABLE', code: null, deepLink: null, reasonCode: 'NOT_CONFIGURED' };
      }
      return { status: 'UNAVAILABLE', code: null, deepLink: null, reasonCode: 'READ_FAILED' };
    } finally {
      client.release();
    }
  }
}
