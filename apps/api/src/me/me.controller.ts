import { Body, Controller, Get, Inject, Patch, UseGuards } from '@nestjs/common';

import { ADSGRAM_CODE, getEarnSummaryForUser } from '@alex-rewards/ads';
import { getMembershipView } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type {
  HomeAnnouncementData,
  HomeLatestWithdrawalData,
  HomeMembershipBriefData,
  HomeMissionsData,
  HomeSummaryResponse,
  HomeTodayAdsData,
  LocaleCode,
  PublicPayoutIdentityMode,
  ReferralsSummaryData,
  UserBalancesResponse,
  UserSettingsResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import { readUserLedgerBalances } from '@alex-rewards/ledger';
import { readUserLifetimeEarned } from '@alex-rewards/rewards';

import { ENVIRONMENT_BY_DEPLOYMENT } from '../ads/http.js';
import {
  AccessSessionGuard,
  CurrentAuthUser,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';

import { toUserBalancesResponse } from './balances.js';
import { mapMeError, parsePatchSettingsBody } from './http.js';
import { settleDomain, unavailableDomain } from './read-models.js';

/**
 * Phase 12 per-user read surface.
 *
 * Everything here is a projection of server-side truth: the ledger owns balances, the
 * Reward Engine owns matured history, the ad domain owns provider eligibility. Nothing on
 * this controller writes financial state, and an engine that does not exist yet reports
 * `UNAVAILABLE` rather than an empty success.
 */
@Controller('v1/me')
@UseGuards(AccessSessionGuard)
export class MeController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  @Get('balances')
  async getBalances(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<UserBalancesResponse> {
    try {
      return await this.readBalances(auth.userId);
    } catch (error) {
      throw mapMeError(error);
    }
  }

  /**
   * Home aggregate.
   *
   * Domains are read concurrently and settled independently, so a provider outage or a
   * not-yet-approved engine degrades one card instead of the whole screen.
   */
  @Get('home')
  async getHome(@CurrentAuthUser() auth: AuthenticatedRequestUser): Promise<HomeSummaryResponse> {
    const asOf = new Date();
    const [balances, todayAds, latestWithdrawal, announcement, membershipBrief] = await Promise.all(
      [
        settleDomain<UserBalancesResponse>(() => this.readBalances(auth.userId, asOf)),
        settleDomain<HomeTodayAdsData>(() => this.readTodayAds(auth.userId, asOf)),
        settleDomain<HomeLatestWithdrawalData>(() => this.readLatestWithdrawal(auth.userId)),
        settleDomain<HomeAnnouncementData>(() => this.readAnnouncement(auth.userId)),
        settleDomain<HomeMembershipBriefData>(() => this.readMembershipBrief(auth.userId)),
      ],
    );

    return {
      asOf: asOf.toISOString(),
      balances,
      todayAds,
      // Mission and referral engines are not approved yet; saying so is the honest answer.
      missions: unavailableDomain<HomeMissionsData>('ENGINE_NOT_ENABLED'),
      referrals: unavailableDomain<ReferralsSummaryData>('ENGINE_NOT_ENABLED'),
      latestWithdrawal,
      announcement,
      membershipBrief,
    };
  }

  @Get('settings')
  async getSettings(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<UserSettingsResponse> {
    try {
      return await this.readSettings(auth.userId);
    } catch (error) {
      throw mapMeError(error);
    }
  }

  /**
   * Update the user's locale.
   *
   * `users.preferred_locale` and `user_settings.locale` are both written in one transaction
   * so the login-time projection and the settings row can never disagree. Payout privacy and
   * notification preferences are read-only in this phase.
   */
  @Patch('settings')
  async patchSettings(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Body() body: unknown,
  ): Promise<UserSettingsResponse> {
    const { preferredLocale } = parsePatchSettingsBody(body);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE users SET preferred_locale = $2 WHERE id = $1::uuid`,
        [auth.userId, preferredLocale],
      );
      if (updated.rowCount === 0) {
        throw new Error('user not found');
      }
      await client.query(
        `INSERT INTO user_settings (user_id, locale)
         VALUES ($1::uuid, $2)
         ON CONFLICT (user_id) DO UPDATE SET locale = EXCLUDED.locale, updated_at = now()`,
        [auth.userId, preferredLocale],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapMeError(error);
    } finally {
      client.release();
    }

    try {
      return await this.readSettings(auth.userId);
    } catch (error) {
      throw mapMeError(error);
    }
  }

  /**
   * Authoritative balances for the configured payout asset.
   *
   * Lifetime earned is read separately and is allowed to fail on its own: an unreadable
   * history must never make a readable spendable balance look unavailable.
   */
  private async readBalances(userId: string, asOf?: Date): Promise<UserBalancesResponse> {
    const balances = await readUserLedgerBalances(this.pool, {
      userId,
      networkCode: this.config.WITHDRAWAL_NETWORK_CODE,
      assetSymbol: this.config.WITHDRAWAL_ASSET_SYMBOL,
      ...(asOf === undefined ? {} : { asOf }),
    });
    return toUserBalancesResponse(
      balances,
      await this.readLifetimeEarned(userId, balances.assetId),
    );
  }

  /** Null means "history could not be read", never "nothing was ever earned". */
  private async readLifetimeEarned(userId: string, assetId: string): Promise<string | null> {
    try {
      const lifetime = await readUserLifetimeEarned(this.pool, { userId, assetId });
      return lifetime.amountAtomic;
    } catch {
      return null;
    }
  }

  private async readTodayAds(userId: string, asOf: Date): Promise<HomeTodayAdsData> {
    const summary = await getEarnSummaryForUser(this.pool, {
      providerCode: ADSGRAM_CODE,
      userId,
      environment: ENVIRONMENT_BY_DEPLOYMENT[this.config.DEPLOYMENT_ENV],
      asOf,
    });
    return {
      utcDay: summary.utcDay,
      providerCode: summary.providerCode,
      monetaryEligible: summary.monetary.eligible,
      successRemaining: summary.success.remaining,
      requestRemaining: summary.request.remaining,
      requestUsageBasis: summary.request.usageBasis,
      successUsageBasis: summary.success.usageBasis,
    };
  }

  private async readLatestWithdrawal(userId: string): Promise<HomeLatestWithdrawalData | null> {
    const result = await this.pool.query<{
      id: string;
      public_id: string;
      state: string;
      net_amount_atomic: string;
      requested_at: Date;
    }>(
      `SELECT id,
              public_id,
              state::text AS state,
              net_amount_atomic::text AS net_amount_atomic,
              requested_at
       FROM withdrawals
       WHERE user_id = $1::uuid
       ORDER BY requested_at DESC
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      publicId: row.public_id,
      state: row.state,
      netAmountAtomic: row.net_amount_atomic,
      requestedAt: row.requested_at.toISOString(),
    };
  }

  /**
   * Latest non-security announcement addressed to this user.
   *
   * Security notifications are deliberately excluded: they are delivered through their own
   * mandatory channel and must not be reduced to a dismissible home card.
   */
  private async readAnnouncement(userId: string): Promise<HomeAnnouncementData | null> {
    const result = await this.pool.query<{
      id: string;
      type_code: string;
      title: string | null;
      created_at: Date;
      read_at: Date | null;
    }>(
      `SELECT n.id,
              n.type_code,
              c.title,
              n.created_at,
              n.read_at
       FROM notifications n
       LEFT JOIN notification_campaigns c ON c.id = n.campaign_id
       WHERE n.user_id = $1::uuid
         AND n.category <> 'SECURITY'
       ORDER BY n.created_at DESC
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      typeCode: row.type_code,
      title: row.title,
      createdAt: row.created_at.toISOString(),
      readAt: row.read_at?.toISOString() ?? null,
    };
  }

  /** Identity only — membership is never a security or trust bypass. */
  private async readMembershipBrief(userId: string): Promise<HomeMembershipBriefData> {
    const view = await getMembershipView(this.pool, userId);
    return {
      active: view.active,
      planCode: view.planCode,
      isFounder: view.isFounder,
      founderNumber: view.founderNumber,
    };
  }

  private async readSettings(userId: string): Promise<UserSettingsResponse> {
    const result = await this.pool.query<{
      locale: LocaleCode;
      public_payout_identity_mode: PublicPayoutIdentityMode;
      marketing_notifications_enabled: boolean;
    }>(
      `SELECT COALESCE(s.locale, u.preferred_locale) AS locale,
              COALESCE(s.public_payout_identity_mode::text, 'HIDE_IDENTITY')
                AS public_payout_identity_mode,
              COALESCE(s.marketing_notifications_enabled, true)
                AS marketing_notifications_enabled
       FROM users u
       LEFT JOIN user_settings s ON s.user_id = u.id
       WHERE u.id = $1::uuid`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error('user not found');
    }
    return {
      preferredLocale: row.locale,
      publicPayoutIdentityMode: row.public_payout_identity_mode,
      marketingNotificationsEnabled: row.marketing_notifications_enabled,
      // Schema-enforced: security notifications cannot be switched off.
      securityNotificationsEnabled: true,
    };
  }
}
