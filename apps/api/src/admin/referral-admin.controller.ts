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
    readonly sourceRewardState: string | null;
    readonly referrerRewardEventId: string | null;
    readonly referrerRewardState: string | null;
    readonly referrerRewardReversalLedgerTransactionId: string | null;
    readonly rateBps: number;
    readonly rateSource: string | null;
    readonly amountAtomic: string;
    readonly ruleVersion: number;
    readonly userMembershipId: string | null;
    readonly entitlementRuleVersionId: string | null;
    readonly createdAt: string;
  }[];
  /** Full reconstructable fields for recent durable decisions (read-only). */
  readonly recentDecisions: readonly {
    readonly id: string;
    readonly sourceRewardEventId: string;
    readonly sourceRewardState: string | null;
    readonly referralEdgeId: string | null;
    readonly outcome: string;
    readonly reasonCode: string;
    readonly amountAtomic: string | null;
    readonly referrerRewardEventId: string | null;
    readonly referrerRewardState: string | null;
    readonly referralRewardEventId: string | null;
    readonly exposureLimitId: string | null;
    readonly exposurePeriodId: string | null;
    readonly rateBps: number | null;
    readonly rateSource: string | null;
    readonly referralRuleVersion: number | null;
    readonly userMembershipId: string | null;
    readonly entitlementRuleVersionId: string | null;
    readonly reversalLedgerTransactionId: string | null;
    readonly decidedAt: string;
  }[];
  /** Truthful presence of ACTIVE config rows (not a production-seed heuristic). */
  readonly activeConfigPresence: {
    readonly referralRule: boolean;
    readonly codePolicy: boolean;
    readonly maxReferralBonusDaily: boolean;
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
      source_reward_state: string | null;
      referrer_reward_event_id: string | null;
      referrer_reward_state: string | null;
      referrer_reward_reversal_ledger_transaction_id: string | null;
      rate_bps: number;
      rate_source: string | null;
      amount_atomic: string;
      rule_version: number;
      user_membership_id: string | null;
      entitlement_rule_version_id: string | null;
      created_at: Date;
    }>(
      `SELECT rre.id, rre.referrer_user_id, rre.source_reward_event_id,
              src.state::text AS source_reward_state,
              rre.referrer_reward_event_id,
              ref.state::text AS referrer_reward_state,
              ref.reversal_ledger_transaction_id::text
                AS referrer_reward_reversal_ledger_transaction_id,
              rre.rate_bps, rre.rate_source::text AS rate_source,
              rre.amount_atomic::text AS amount_atomic, rre.rule_version,
              rre.user_membership_id, rre.entitlement_rule_version_id, rre.created_at
       FROM referral_reward_events rre
       LEFT JOIN reward_events src ON src.id = rre.source_reward_event_id
       LEFT JOIN reward_events ref ON ref.id = rre.referrer_reward_event_id
       ORDER BY rre.created_at DESC
       LIMIT 50`,
    );

    const decisions = await this.pool.query<{
      id: string;
      source_reward_event_id: string;
      source_reward_state: string | null;
      referral_edge_id: string | null;
      outcome: string;
      reason_code: string;
      amount_atomic: string | null;
      referrer_reward_event_id: string | null;
      referrer_reward_state: string | null;
      referral_reward_event_id: string | null;
      exposure_limit_id: string | null;
      exposure_period_id: string | null;
      rate_bps: number | null;
      rate_source: string | null;
      referral_rule_version: number | null;
      user_membership_id: string | null;
      entitlement_rule_version_id: string | null;
      reversal_ledger_transaction_id: string | null;
      decided_at: Date;
    }>(
      `SELECT d.id, d.source_reward_event_id,
              src.state::text AS source_reward_state,
              d.referral_edge_id,
              d.outcome::text AS outcome, d.reason_code,
              d.amount_atomic::text AS amount_atomic,
              d.referrer_reward_event_id,
              ref.state::text AS referrer_reward_state,
              d.referral_reward_event_id,
              d.exposure_limit_id, d.exposure_period_id,
              d.rate_bps, d.rate_source::text AS rate_source,
              d.referral_rule_version, d.user_membership_id, d.entitlement_rule_version_id,
              ref.reversal_ledger_transaction_id::text AS reversal_ledger_transaction_id,
              d.decided_at
       FROM referral_reward_decisions d
       LEFT JOIN reward_events src ON src.id = d.source_reward_event_id
       LEFT JOIN reward_events ref ON ref.id = d.referrer_reward_event_id
       ORDER BY d.decided_at DESC
       LIMIT 50`,
    );

    const activeLimit = await this.pool.query<{ c: string }>(
      `SELECT count(*)::text AS c
       FROM economic_exposure_limits
       WHERE limit_code = 'MAX_REFERRAL_BONUS_DAILY'
         AND status = 'ACTIVE'`,
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
        alphabetSize: Array.from(row.alphabet).length,
        effectiveFrom: row.effective_from.toISOString(),
        effectiveTo: row.effective_to?.toISOString() ?? null,
      })),
      recentReferralRewards: rewards.rows.map((row) => ({
        id: row.id,
        referrerUserId: row.referrer_user_id,
        sourceRewardEventId: row.source_reward_event_id,
        sourceRewardState: row.source_reward_state,
        referrerRewardEventId: row.referrer_reward_event_id,
        referrerRewardState: row.referrer_reward_state,
        referrerRewardReversalLedgerTransactionId:
          row.referrer_reward_reversal_ledger_transaction_id,
        rateBps: row.rate_bps,
        rateSource: row.rate_source,
        amountAtomic: row.amount_atomic,
        ruleVersion: row.rule_version,
        userMembershipId: row.user_membership_id,
        entitlementRuleVersionId: row.entitlement_rule_version_id,
        createdAt: row.created_at.toISOString(),
      })),
      recentDecisions: decisions.rows.map((row) => ({
        id: row.id,
        sourceRewardEventId: row.source_reward_event_id,
        sourceRewardState: row.source_reward_state,
        referralEdgeId: row.referral_edge_id,
        outcome: row.outcome,
        reasonCode: row.reason_code,
        amountAtomic: row.amount_atomic,
        referrerRewardEventId: row.referrer_reward_event_id,
        referrerRewardState: row.referrer_reward_state,
        referralRewardEventId: row.referral_reward_event_id,
        exposureLimitId: row.exposure_limit_id,
        exposurePeriodId: row.exposure_period_id,
        rateBps: row.rate_bps,
        rateSource: row.rate_source,
        referralRuleVersion: row.referral_rule_version,
        userMembershipId: row.user_membership_id,
        entitlementRuleVersionId: row.entitlement_rule_version_id,
        reversalLedgerTransactionId: row.reversal_ledger_transaction_id,
        decidedAt: row.decided_at.toISOString(),
      })),
      activeConfigPresence: {
        referralRule: rules.rows.length > 0,
        codePolicy: policies.rows.length > 0,
        maxReferralBonusDaily: Number(activeLimit.rows[0]?.c ?? '0') > 0,
      },
    };
  }
}
