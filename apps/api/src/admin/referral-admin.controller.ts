import {
  Controller,
  Get,
  Inject,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';

import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

export interface AdminReferralEdgeListItem {
  readonly id: string;
  readonly inviterUserId: string;
  readonly inviteeUserId: string;
  readonly status: string;
  readonly activationRuleVersion: number | null;
  readonly attributedAt: string;
  readonly activatedAt: string | null;
  readonly rejectedAt: string | null;
}

export interface AdminReferralOverviewData {
  readonly edgeCounts: {
    readonly pending: number;
    readonly active: number;
    readonly rejected: number;
  };
  readonly rewardDecisionCounts: {
    readonly issued: number;
    readonly skipped: number;
    readonly rejectedBudget: number;
  };
  readonly activeReferralRules: readonly {
    readonly ruleVersion: number;
    readonly baseRateBps: number;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
  readonly activeCodePolicies: readonly {
    readonly policyVersion: number;
    readonly codeLength: number;
    readonly alphabetSize: number;
    readonly effectiveFrom: string;
    readonly effectiveTo: string | null;
  }[];
  readonly recentReferralRewards: readonly {
    readonly id: string;
    readonly referrerUserId: string;
    readonly sourceRewardEventId: string;
    readonly referrerRewardEventId: string | null;
    readonly rateBps: number;
    readonly rateSource: string | null;
    readonly amountAtomic: string;
    readonly ruleVersion: number;
    readonly createdAt: string;
  }[];
  readonly productionPolicySeeds: {
    readonly referralRule: 'NOT_SEEDED' | 'SEEDED';
    readonly codePolicy: 'NOT_SEEDED' | 'SEEDED';
    readonly maxReferralBonusDaily: 'NOT_SEEDED' | 'SEEDED';
  };
}

/**
 * Admin Referral read model (Phase 15).
 * Read-only: no force-bonus, no edge rewrite, no ledger mutation.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class ReferralAdminController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('referral')
  async listEdges(
    @Query('page', new ParseIntPipe({ optional: true })) pageRaw?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSizeRaw?: number,
  ): Promise<{
    readonly contractVersion: '1';
    readonly items: readonly AdminReferralEdgeListItem[];
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly totalKnown: true;
  }> {
    try {
      const page = Math.max(1, pageRaw ?? 1);
      const pageSize = Math.min(100, Math.max(1, pageSizeRaw ?? 25));
      const offset = (page - 1) * pageSize;

      const count = await this.pool.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM referral_edges`,
      );
      const total = Number(count.rows[0]?.c ?? 0);

      const rows = await this.pool.query<{
        id: string;
        referrer_user_id: string;
        referred_user_id: string;
        state: string;
        activation_rule_version: number | null;
        attributed_at: Date;
        activated_at: Date | null;
        rejected_at: Date | null;
      }>(
        `SELECT id, referrer_user_id, referred_user_id, state::text AS state,
                activation_rule_version, attributed_at, activated_at, rejected_at
         FROM referral_edges
         ORDER BY attributed_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      );

      return {
        contractVersion: '1',
        items: rows.rows.map((row) => ({
          id: row.id,
          inviterUserId: row.referrer_user_id,
          inviteeUserId: row.referred_user_id,
          status: row.state,
          activationRuleVersion: row.activation_rule_version,
          attributedAt: row.attributed_at.toISOString(),
          activatedAt: row.activated_at?.toISOString() ?? null,
          rejectedAt: row.rejected_at?.toISOString() ?? null,
        })),
        page,
        pageSize,
        total,
        totalKnown: true,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('referrals')
  async overview(): Promise<{
    readonly contractVersion: '1';
    readonly status: 'READY' | 'EMPTY';
    readonly data: AdminReferralOverviewData;
  }> {
    try {
      const data = await this.buildOverview();
      const empty =
        data.edgeCounts.pending + data.edgeCounts.active + data.edgeCounts.rejected === 0 &&
        data.activeReferralRules.length === 0 &&
        data.activeCodePolicies.length === 0;
      return {
        contractVersion: '1',
        status: empty ? 'EMPTY' : 'READY',
        data,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  private async buildOverview(): Promise<AdminReferralOverviewData> {
    const edgeCounts = await this.pool.query<{
      pending: string;
      active: string;
      rejected: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE state = 'PENDING')::text AS pending,
         count(*) FILTER (WHERE state = 'ACTIVE')::text AS active,
         count(*) FILTER (WHERE state = 'REJECTED')::text AS rejected
       FROM referral_edges`,
    );

    const decisionCounts = await this.pool.query<{
      issued: string;
      skipped: string;
      rejected_budget: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE outcome = 'ISSUED')::text AS issued,
         count(*) FILTER (WHERE outcome = 'SKIPPED')::text AS skipped,
         count(*) FILTER (WHERE outcome = 'REJECTED_BUDGET')::text AS rejected_budget
       FROM referral_reward_decisions`,
    );

    const rules = await this.pool.query<{
      rule_version: number;
      base_rate_bps: number;
      effective_from: Date;
      effective_to: Date | null;
    }>(
      `SELECT rule_version, base_rate_bps, effective_from, effective_to
       FROM referral_rule_versions
       WHERE status = 'ACTIVE'
       ORDER BY rule_version ASC`,
    );

    const policies = await this.pool.query<{
      policy_version: number;
      code_length: number;
      alphabet: string;
      effective_from: Date;
      effective_to: Date | null;
    }>(
      `SELECT policy_version, code_length, alphabet, effective_from, effective_to
       FROM referral_code_policy_versions
       WHERE status = 'ACTIVE'
       ORDER BY policy_version ASC`,
    );

    const rewards = await this.pool.query<{
      id: string;
      referrer_user_id: string;
      source_reward_event_id: string;
      referrer_reward_event_id: string | null;
      rate_bps: number;
      rate_source: string | null;
      amount_atomic: string;
      rule_version: number;
      created_at: Date;
    }>(
      `SELECT id, referrer_user_id, source_reward_event_id, referrer_reward_event_id,
              rate_bps, rate_source::text AS rate_source,
              amount_atomic::text AS amount_atomic, rule_version, created_at
       FROM referral_reward_events
       ORDER BY created_at DESC
       LIMIT 50`,
    );

    const productionLimit = await this.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c
       FROM economic_exposure_limits
       WHERE limit_code = 'MAX_REFERRAL_BONUS_DAILY'
         AND environment = 'PRODUCTION'
         AND status = 'ACTIVE'`,
    );

    const productionRule = await this.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c
       FROM referral_rule_versions
       WHERE status = 'ACTIVE'
         AND reason IS DISTINCT FROM 'phase15-test-only'
         AND reason NOT ILIKE '%test%'`,
    );
    const productionPolicy = await this.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c
       FROM referral_code_policy_versions
       WHERE status = 'ACTIVE'
         AND reason NOT ILIKE '%test%'`,
    );

    return {
      edgeCounts: {
        pending: Number(edgeCounts.rows[0]?.pending ?? '0'),
        active: Number(edgeCounts.rows[0]?.active ?? '0'),
        rejected: Number(edgeCounts.rows[0]?.rejected ?? '0'),
      },
      rewardDecisionCounts: {
        issued: Number(decisionCounts.rows[0]?.issued ?? '0'),
        skipped: Number(decisionCounts.rows[0]?.skipped ?? '0'),
        rejectedBudget: Number(decisionCounts.rows[0]?.rejected_budget ?? '0'),
      },
      activeReferralRules: rules.rows.map((row) => ({
        ruleVersion: row.rule_version,
        baseRateBps: row.base_rate_bps,
        effectiveFrom: row.effective_from.toISOString(),
        effectiveTo: row.effective_to?.toISOString() ?? null,
      })),
      activeCodePolicies: policies.rows.map((row) => ({
        policyVersion: row.policy_version,
        codeLength: row.code_length,
        alphabetSize: row.alphabet.length,
        effectiveFrom: row.effective_from.toISOString(),
        effectiveTo: row.effective_to?.toISOString() ?? null,
      })),
      recentReferralRewards: rewards.rows.map((row) => ({
        id: row.id,
        referrerUserId: row.referrer_user_id,
        sourceRewardEventId: row.source_reward_event_id,
        referrerRewardEventId: row.referrer_reward_event_id,
        rateBps: row.rate_bps,
        rateSource: row.rate_source,
        amountAtomic: row.amount_atomic,
        ruleVersion: row.rule_version,
        createdAt: row.created_at.toISOString(),
      })),
      productionPolicySeeds: {
        // Migrations never seed production economics; heuristic excludes test reasons.
        referralRule: Number(productionRule.rows[0]?.c ?? '0') > 0 ? 'SEEDED' : 'NOT_SEEDED',
        codePolicy: Number(productionPolicy.rows[0]?.c ?? '0') > 0 ? 'SEEDED' : 'NOT_SEEDED',
        maxReferralBonusDaily:
          Number(productionLimit.rows[0]?.c ?? '0') > 0 ? 'SEEDED' : 'NOT_SEEDED',
      },
    };
  }
}
