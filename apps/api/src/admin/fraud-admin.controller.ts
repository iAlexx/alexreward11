import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { VerifiedAdminSession } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type {
  AdminFraudEligibilityDecisionView,
  AdminFraudEnsureReviewRequest,
  AdminFraudEnsureReviewResponse,
  AdminFraudEvidenceData,
  AdminFraudFlagView,
  AdminFraudReadResponse,
  AdminFraudReviewCaseView,
  AdminFraudRiskProfileView,
  AdminFraudRiskSnapshotMeta,
  AdminFraudSafeAggregateEvidence,
  AdminFraudTrustCurrentView,
  AdminFraudTrustSnapshotMeta,
} from '@alex-rewards/contracts';
import { ensureReviewCase } from '@alex-rewards/control-center';
import type { Pool } from '@alex-rewards/db';

import {
  AdminSessionGuard,
  CurrentAdminSession,
} from '../admin-auth/admin-session.guard.js';
import { ParseUuidPipe } from '../auth/access-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  enforceAdminMutationCsrf,
  gateHighImpactMutation,
  mapAdminDomainError,
  requireConsumedConfirmation,
} from './http.js';

const SAFE_SIGNAL_CODES = [
  'SHARED_PAYOUT_WALLET',
  'SHARED_NETWORK_SIGNAL',
  'AD_REVERSED_REWARD_HISTORY',
  'REFERRAL_REJECTED_EDGE_HISTORY',
] as const;

const LIVE_REVIEW_STATES = ['OPEN', 'IN_REVIEW', 'WAITING_INPUT', 'ESCALATED'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Extract only allowlisted aggregate counts from snapshot safe_inputs / outputs /
 * reason_codes. Never returns IP, wallet address, hash, initData, or linked user ids.
 */
export function extractSafeAggregates(
  reasonCodes: readonly string[],
  safeInputs: unknown,
  outputs: unknown,
): AdminFraudSafeAggregateEvidence {
  const present = new Set<string>();
  for (const code of reasonCodes) {
    if ((SAFE_SIGNAL_CODES as readonly string[]).includes(code)) {
      present.add(code);
    }
  }

  let relatedPayoutAccountCount: number | undefined;
  let relatedNetworkAccountCount: number | undefined;
  let reversedAdRewardCount: number | undefined;
  let rejectedReferralCount: number | undefined;

  const inputs = asRecord(safeInputs);
  const out = asRecord(outputs);
  const evidenceSources: unknown[] = [];
  if (inputs !== null) {
    if (Array.isArray(inputs.signalEvidence)) evidenceSources.push(...inputs.signalEvidence);
    if (Array.isArray(inputs.signalState)) evidenceSources.push(...inputs.signalState);
  }
  if (out !== null && Array.isArray(out.contributions)) {
    evidenceSources.push(...out.contributions);
  }

  for (const raw of evidenceSources) {
    const fact = asRecord(raw);
    if (fact === null) continue;
    const code = typeof fact.code === 'string' ? fact.code : null;
    if (code === null || !(SAFE_SIGNAL_CODES as readonly string[]).includes(code)) continue;
    if (fact.active === true || (SAFE_SIGNAL_CODES as readonly string[]).includes(code)) {
      present.add(code);
    }
    const details = asRecord(fact.safeDetails) ?? {};
    if (code === 'SHARED_PAYOUT_WALLET') {
      relatedPayoutAccountCount =
        asFiniteNumber(details.relatedAccountCount) ?? relatedPayoutAccountCount;
    } else if (code === 'SHARED_NETWORK_SIGNAL') {
      relatedNetworkAccountCount =
        asFiniteNumber(details.relatedAccountCount) ?? relatedNetworkAccountCount;
    } else if (code === 'AD_REVERSED_REWARD_HISTORY') {
      reversedAdRewardCount =
        asFiniteNumber(details.reversedAdRewardCount) ?? reversedAdRewardCount;
    } else if (code === 'REFERRAL_REJECTED_EDGE_HISTORY') {
      rejectedReferralCount =
        asFiniteNumber(details.rejectedReferralCount) ?? rejectedReferralCount;
    }
  }

  return {
    ...(relatedPayoutAccountCount !== undefined ? { relatedPayoutAccountCount } : {}),
    ...(relatedNetworkAccountCount !== undefined ? { relatedNetworkAccountCount } : {}),
    ...(reversedAdRewardCount !== undefined ? { reversedAdRewardCount } : {}),
    ...(rejectedReferralCount !== undefined ? { rejectedReferralCount } : {}),
    signalCodesPresent: SAFE_SIGNAL_CODES.filter((c) => present.has(c)),
  };
}

function mapReviewCase(row: {
  id: string;
  case_type: string;
  resource_type: string;
  resource_id: string;
  priority: string;
  state: string;
  summary: string | null;
  created_at: Date;
  updated_at: Date;
}): AdminFraudReviewCaseView {
  return {
    id: row.id,
    caseType: row.case_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    priority: row.priority,
    state: row.state,
    summary: row.summary,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Admin fraud read visibility + FRAUD_REVIEW ensure.
 * Allowlisted SQL only — never invokes evaluate-and-persist domain writers.
 * No Risk / Trust mutation from this surface. Safe-clearance mutations stay unavailable.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class FraudAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('fraud')
  async read(@Query('userId') userId?: string): Promise<AdminFraudReadResponse> {
    try {
      const trimmed =
        userId !== undefined && userId.trim() !== '' ? userId.trim() : undefined;
      return await this.buildRead(trimmed);
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('fraud/:userId')
  async readByUser(
    @Param('userId', ParseUuidPipe) userId: string,
  ): Promise<AdminFraudReadResponse> {
    try {
      return await this.buildRead(userId);
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('fraud/:userId/ensure-review')
  @HttpCode(200)
  async ensureReview(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('userId', ParseUuidPipe) userId: string,
    @Body() body: AdminFraudEnsureReviewRequest,
  ): Promise<AdminFraudEnsureReviewResponse> {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      await requireConsumedConfirmation(this.pool, session, body.confirmationId, {
        action: 'fraud.ensure_review',
        resourceType: 'user',
        resourceId: userId,
        expectedVersion: gated.expectedVersion,
        payload: { userId, reason: gated.reason, summary: body.summary ?? null },
      });

      const existing = await this.pool.query<{ id: string }>(
        `SELECT id FROM review_cases
         WHERE case_type = 'FRAUD_REVIEW'::review_case_type
           AND resource_type = 'user'
           AND resource_id = $1::uuid
           AND state = ANY($2::review_case_state[])
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId, LIVE_REVIEW_STATES],
      );
      const beforeId = existing.rows[0]?.id;

      const review = await ensureReviewCase(this.pool, {
        caseType: 'FRAUD_REVIEW',
        resourceType: 'user',
        resourceId: userId,
        priority: 'HIGH',
        summary: body.summary?.trim() || gated.reason,
        reasonCodes: ['ADMIN_FRAUD_REVIEW_ENSURE'],
        adminUserId: session.adminUserId,
      });

      return {
        contractVersion: '1',
        reviewCase: {
          id: review.id,
          caseType: review.caseType,
          resourceType: review.resourceType,
          resourceId: review.resourceId,
          priority: review.priority,
          state: review.state,
          summary: review.summary,
          createdAt: review.createdAt.toISOString(),
          updatedAt: review.updatedAt.toISOString(),
        },
        createdOrReused: beforeId === review.id ? 'REUSED' : 'CREATED',
        ledgerWrite: false,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  private async buildRead(userId: string | undefined): Promise<AdminFraudReadResponse> {
    const liveCases = await this.loadLiveFraudReviewCases(userId);

    if (userId === undefined) {
      const empty = liveCases.length === 0;
      return {
        contractVersion: '1',
        status: empty ? 'EMPTY' : 'READY',
        data: {
          userId: null,
          riskProfile: null,
          latestRiskSnapshot: null,
          trustCurrent: null,
          latestTrustSnapshot: null,
          recentEligibilityDecisions: [],
          openOrConfirmedFraudFlags: [],
          liveFraudReviewCases: liveCases,
        },
        ...(empty ? { errorCode: 'NO_DATA' as const } : {}),
        phase14Engine: { status: 'READY' },
      };
    }

    const [
      riskProfile,
      latestRiskSnapshot,
      trustCurrent,
      latestTrustSnapshot,
      recentEligibilityDecisions,
      openOrConfirmedFraudFlags,
    ] = await Promise.all([
      this.loadRiskProfile(userId),
      this.loadLatestRiskSnapshot(userId),
      this.loadTrustCurrent(userId),
      this.loadLatestTrustSnapshot(userId),
      this.loadRecentEligibility(userId),
      this.loadOpenOrConfirmedFlags(userId),
    ]);

    const data: AdminFraudEvidenceData = {
      userId,
      riskProfile,
      latestRiskSnapshot,
      trustCurrent,
      latestTrustSnapshot,
      recentEligibilityDecisions,
      openOrConfirmedFraudFlags,
      liveFraudReviewCases: liveCases,
    };

    const hasEvidence =
      riskProfile !== null ||
      latestRiskSnapshot !== null ||
      trustCurrent !== null ||
      latestTrustSnapshot !== null ||
      recentEligibilityDecisions.length > 0 ||
      openOrConfirmedFraudFlags.length > 0 ||
      liveCases.length > 0;

    return {
      contractVersion: '1',
      status: hasEvidence ? 'READY' : 'EMPTY',
      data,
      ...(hasEvidence ? {} : { errorCode: 'NO_DATA' as const }),
      phase14Engine: { status: 'READY' },
    };
  }

  private async loadRiskProfile(userId: string): Promise<AdminFraudRiskProfileView | null> {
    const result = await this.pool.query<{
      score: number;
      risk_tier: string;
      rule_version: number;
      reason_codes: string[];
      calculated_at: Date;
    }>(
      `SELECT score, risk_tier::text AS risk_tier, rule_version, reason_codes, calculated_at
       FROM risk_profiles
       WHERE user_id = $1::uuid`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      score: row.score,
      riskTier: row.risk_tier,
      ruleVersion: row.rule_version,
      reasonCodes: row.reason_codes,
      calculatedAt: row.calculated_at.toISOString(),
    };
  }

  private async loadLatestRiskSnapshot(
    userId: string,
  ): Promise<AdminFraudRiskSnapshotMeta | null> {
    const result = await this.pool.query<{
      id: string;
      decision_scope: string;
      score: number;
      risk_tier: string;
      rule_version: number;
      reason_codes: string[];
      calculated_at: Date;
      safe_inputs: unknown;
      outputs: unknown;
    }>(
      `SELECT id, decision_scope::text AS decision_scope, score,
              risk_tier::text AS risk_tier, rule_version, reason_codes,
              calculated_at, safe_inputs, outputs
       FROM risk_snapshots
       WHERE user_id = $1::uuid
       ORDER BY calculated_at DESC
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      decisionScope: row.decision_scope,
      score: row.score,
      riskTier: row.risk_tier,
      ruleVersion: row.rule_version,
      reasonCodes: row.reason_codes,
      calculatedAt: row.calculated_at.toISOString(),
      safeAggregates: extractSafeAggregates(row.reason_codes, row.safe_inputs, row.outputs),
    };
  }

  private async loadTrustCurrent(userId: string): Promise<AdminFraudTrustCurrentView | null> {
    const result = await this.pool.query<{ trust_state: string }>(
      `SELECT trust_state::text AS trust_state FROM users WHERE id = $1::uuid`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { trustState: row.trust_state };
  }

  private async loadLatestTrustSnapshot(
    userId: string,
  ): Promise<AdminFraudTrustSnapshotMeta | null> {
    const result = await this.pool.query<{
      id: string;
      trust_state: string;
      trust_score: number;
      rule_version: number;
      reason_codes: string[];
      calculated_at: Date;
    }>(
      `SELECT id, trust_state::text AS trust_state, trust_score, rule_version,
              reason_codes, calculated_at
       FROM trust_snapshots
       WHERE user_id = $1::uuid
       ORDER BY calculated_at DESC
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      trustState: row.trust_state,
      trustScore: row.trust_score,
      ruleVersion: row.rule_version,
      reasonCodes: row.reason_codes,
      calculatedAt: row.calculated_at.toISOString(),
    };
  }

  private async loadRecentEligibility(
    userId: string,
  ): Promise<readonly AdminFraudEligibilityDecisionView[]> {
    const result = await this.pool.query<{
      id: string;
      action_type: string;
      policy_version: number | null;
      outcome: string;
      reason_codes: string[];
      decided_at: Date;
    }>(
      `SELECT id, action_type::text AS action_type, policy_version,
              outcome::text AS outcome, reason_codes, decided_at
       FROM eligibility_decisions
       WHERE user_id = $1::uuid
       ORDER BY decided_at DESC
       LIMIT 20`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      actionType: row.action_type,
      policyVersion: row.policy_version,
      outcome: row.outcome,
      reasonCodes: row.reason_codes,
      decidedAt: row.decided_at.toISOString(),
    }));
  }

  private async loadOpenOrConfirmedFlags(
    userId: string,
  ): Promise<readonly AdminFraudFlagView[]> {
    const result = await this.pool.query<{
      id: string;
      flag_type: string;
      status: string;
      severity: string;
      created_at: Date;
    }>(
      `SELECT id, flag_type, status::text AS status, severity::text AS severity, created_at
       FROM fraud_flags
       WHERE user_id = $1::uuid
         AND status IN ('OPEN'::fraud_flag_status, 'CONFIRMED'::fraud_flag_status)
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      flagType: row.flag_type,
      status: row.status,
      severity: row.severity,
      createdAt: row.created_at.toISOString(),
    }));
  }

  private async loadLiveFraudReviewCases(
    userId: string | undefined,
  ): Promise<readonly AdminFraudReviewCaseView[]> {
    if (userId !== undefined) {
      const result = await this.pool.query<{
        id: string;
        case_type: string;
        resource_type: string;
        resource_id: string;
        priority: string;
        state: string;
        summary: string | null;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, case_type::text AS case_type, resource_type, resource_id,
                priority::text AS priority, state::text AS state, summary,
                created_at, updated_at
         FROM review_cases
         WHERE case_type = 'FRAUD_REVIEW'::review_case_type
           AND resource_type = 'user'
           AND resource_id = $1::uuid
           AND state = ANY($2::review_case_state[])
         ORDER BY created_at ASC
         LIMIT 50`,
        [userId, LIVE_REVIEW_STATES],
      );
      return result.rows.map(mapReviewCase);
    }

    const result = await this.pool.query<{
      id: string;
      case_type: string;
      resource_type: string;
      resource_id: string;
      priority: string;
      state: string;
      summary: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, case_type::text AS case_type, resource_type, resource_id,
              priority::text AS priority, state::text AS state, summary,
              created_at, updated_at
       FROM review_cases
       WHERE case_type = 'FRAUD_REVIEW'::review_case_type
         AND state = ANY($1::review_case_state[])
       ORDER BY created_at ASC
       LIMIT 100`,
      [LIVE_REVIEW_STATES],
    );
    return result.rows.map(mapReviewCase);
  }
}
