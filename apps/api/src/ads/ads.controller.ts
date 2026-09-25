import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import {
  adRewardIdempotencyKey,
  attemptVerifyAndIssueAdReward,
  authorizeRewardedAdSession,
  getEarnSummaryForUser,
  getProviderAdminView,
  recordAdSessionOutcome,
  recordClientSignal,
  type AdSessionFailureOutcome,
} from '@alex-rewards/ads';
import type { ApiConfig } from '@alex-rewards/config';
import type { EarnSummaryResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import {
  AccessSessionGuard,
  CurrentAuthUser,
  ParseUuidPipe,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';

import { toEarnProviderCard } from './earn-summary.js';
import {
  assertNoClientAuthorityFields,
  ENVIRONMENT_BY_DEPLOYMENT,
  mapAdsError,
  optionalCountryCode,
  optionalSafePayload,
  optionalUuid,
  requireProviderCode,
  requireShortString,
  requireUuid,
} from './http.js';

/** Terminal non-reward outcomes the mini app may report directly. */
const OUTCOME_EVENTS: Readonly<Record<string, AdSessionFailureOutcome>> = {
  NO_FILL: 'NO_FILL',
  LOAD_FAILURE: 'FAILED',
  START_FAILURE: 'FAILED',
  TECHNICAL_FAILURE: 'FAILED',
  USER_SKIPPED: 'SKIPPED',
};

/**
 * Phase 11 rewarded-ad surface.
 *
 * Every endpoint here is authenticated and every one of them is evidence-only: the client
 * reports what it observed, and the server decides — independently — whether an attempt is
 * rewardable. No endpoint accepts an amount, and no endpoint credits a balance. Reward
 * issuance happens exclusively inside `attemptVerifyAndIssueAdReward`, which runs the
 * provider-neutral monetary gate before it lets the Reward Engine post anything.
 *
 * There is deliberately no debug, simulate or force-completion route: a production build
 * must not contain a path that manufactures ad evidence.
 */
@Controller('v1/ads')
@UseGuards(AccessSessionGuard)
export class AdsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  /**
   * Authorize one rewarded ad attempt.
   *
   * `assetId` / `budgetPeriodId` are locators only — the Reward Engine re-validates scope,
   * window and authority server-side and prices the quote itself.
   */
  @Post('sessions/authorize')
  @HttpCode(200)
  async authorizeSession(@CurrentAuthUser() auth: AuthenticatedRequestUser, @Body() body: unknown) {
    const source = assertNoClientAuthorityFields(body);
    const providerCode = requireProviderCode(source['providerCode']);
    const assetId = requireUuid(source, 'assetId');
    const budgetPeriodId = requireUuid(source, 'budgetPeriodId');
    const adUnitId = optionalUuid(source, 'adUnitId');
    const countryCode = optionalCountryCode(source);

    try {
      const result = await authorizeRewardedAdSession(this.pool, {
        providerCode,
        userId: auth.userId,
        assetId,
        budgetPeriodId,
        adUnitId,
        countryCode,
        environment: ENVIRONMENT_BY_DEPLOYMENT[this.config.DEPLOYMENT_ENV],
        evaluateMembershipBonus: false,
      });
      return result;
    } catch (error) {
      throw mapAdsError(error);
    }
  }

  /**
   * Record one client-observed lifecycle event.
   *
   * Stored as UNVERIFIED forensic evidence. A client completion can never reach VERIFIED
   * or REWARDED on its own, and a terminal outcome (no-fill / failure / skip) releases the
   * quote's reservations without moving money.
   */
  @Post('sessions/:id/client-signal')
  @HttpCode(200)
  async recordSignal(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('id', ParseUuidPipe) adSessionId: string,
    @Body() body: unknown,
  ) {
    const source = assertNoClientAuthorityFields(body);
    const event = requireShortString(source, 'event', 64);
    const payload = optionalSafePayload(source);
    const outcome = OUTCOME_EVENTS[event.toUpperCase()];

    try {
      if (outcome !== undefined) {
        const result = await recordAdSessionOutcome(this.pool, {
          adSessionId,
          userId: auth.userId,
          outcome,
          failureCode: event.toUpperCase(),
          source: 'CLIENT',
        });
        return { ...result, issued: false, rewardCredited: false };
      }

      const result = await recordClientSignal(this.pool, {
        adSessionId,
        userId: auth.userId,
        eventType: event,
        ...(payload === undefined ? {} : { payload }),
      });
      return { ...result, rewardCredited: false };
    } catch (error) {
      throw mapAdsError(error);
    }
  }

  /**
   * Ask the server to verify a session and, only if the monetary gate passes, issue the
   * reward through the Reward Engine.
   *
   * The idempotency key is derived from the session id server-side so a retried request
   * can never produce a second posting.
   */
  @Post('sessions/:id/attempt-verify')
  @HttpCode(200)
  async attemptVerify(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('id', ParseUuidPipe) adSessionId: string,
    @Body() body: unknown,
  ) {
    assertNoClientAuthorityFields(body ?? {});
    try {
      const result = await attemptVerifyAndIssueAdReward(this.pool, {
        adSessionId,
        userId: auth.userId,
        idempotencyKey: adRewardIdempotencyKey(adSessionId),
      });
      return {
        adSessionId: result.adSessionId,
        state: result.state,
        issued: result.issued,
        alreadyRewarded: result.alreadyRewarded,
        monetary: result.monetary,
        reasonCodes: result.reasonCodes,
        // Amounts come from the consumed quote; the client never asserts or receives a price.
        baseAmountAtomic: result.reward?.baseAmountAtomic ?? null,
        membershipBonusAmountAtomic: result.reward?.membershipBonusAmountAtomic ?? null,
        pendingUntil: result.reward?.pendingUntil ?? null,
      };
    } catch (error) {
      throw mapAdsError(error);
    }
  }

  /**
   * User-facing earn summary for one provider.
   *
   * Reports the monetary gate decision and today's remaining opportunities against the
   * ACTIVE versioned limit rules. AdsGram is BLOCKED for production money and this endpoint
   * says so instead of advertising an earning opportunity the gate would refuse.
   */
  @Get('earn-summary')
  async earnSummary(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Query('provider') provider: string,
  ): Promise<EarnSummaryResponse> {
    const providerCode = requireProviderCode(provider);
    const asOf = new Date();
    try {
      const summary = await getEarnSummaryForUser(this.pool, {
        providerCode,
        userId: auth.userId,
        environment: ENVIRONMENT_BY_DEPLOYMENT[this.config.DEPLOYMENT_ENV],
        asOf,
        networkCode: this.config.WITHDRAWAL_NETWORK_CODE,
        assetSymbol: this.config.WITHDRAWAL_ASSET_SYMBOL,
      });
      return {
        status: 'READY',
        asOf: summary.asOf,
        providers: [toEarnProviderCard(summary)],
      };
    } catch (error) {
      throw mapAdsError(error);
    }
  }

  /**
   * Read-only provider policy view.
   *
   * Phase 11 foundation: this is gated by the authenticated-session guard only. Owner/admin
   * RBAC for the admin surface is not in scope for this phase, and the payload is
   * deliberately limited to non-secret policy configuration — no credentials, no revenue
   * data and no per-user financial state.
   */
  @Get('providers/:code/admin-view')
  async adminView(@Param('code') code: string) {
    const providerCode = requireProviderCode(code);
    try {
      return await getProviderAdminView(this.pool, { providerCode });
    } catch (error) {
      throw mapAdsError(error);
    }
  }
}
