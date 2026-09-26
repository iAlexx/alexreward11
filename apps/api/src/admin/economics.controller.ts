import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import type {
  AdminEconomicsMetricDto,
  AdminEconomicsResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

function unavailableMetric(
  metric: AdminEconomicsMetricDto['metric'],
  basis: AdminEconomicsMetricDto['basis'],
  reasonCode: string,
): AdminEconomicsMetricDto {
  return {
    metric,
    basis,
    amountAtomic: null,
    status: 'UNAVAILABLE',
    reasonCode,
  };
}

/**
 * Economics dashboard — honest metric contract (P13-04 / Spec §156M).
 * Confirmed withdrawal principal is NEVER labeled settled margin/revenue.
 * Missing inputs → UNAVAILABLE, never invented zeros as known economics.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class EconomicsController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('economics')
  async economics(): Promise<AdminEconomicsResponse> {
    try {
      const asOf = new Date().toISOString();
      const metrics: AdminEconomicsMetricDto[] = [];

      // Spec §156M metrics that lack an authoritative configured source stay UNAVAILABLE.
      const unavailableByDefault: ReadonlyArray<{
        metric: AdminEconomicsMetricDto['metric'];
        basis: AdminEconomicsMetricDto['basis'];
        reason: string;
      }> = [
        {
          metric: 'PROVIDER_ESTIMATED_REVENUE',
          basis: 'ESTIMATED',
          reason: 'PROVIDER_REVENUE_NOT_CONFIGURED',
        },
        {
          metric: 'PROVIDER_SETTLED_CONFIRMED_REVENUE',
          basis: 'SETTLED',
          reason: 'PROVIDER_SETTLEMENT_NOT_CONFIGURED',
        },
        {
          metric: 'PROVIDER_RECEIVABLES',
          basis: 'ACCRUED',
          reason: 'PROVIDER_RECEIVABLES_NOT_CONFIGURED',
        },
        {
          metric: 'BASE_USER_REWARD_EXPENSE',
          basis: 'ACCRUED',
          reason: 'REWARD_EXPENSE_ROLLUP_UNAVAILABLE',
        },
        {
          metric: 'MEMBERSHIP_FOUNDER_BONUS_EXPENSE',
          basis: 'ACCRUED',
          reason: 'FOUNDER_BONUS_EXPENSE_UNAVAILABLE',
        },
        {
          metric: 'REFERRAL_BONUS_EXPENSE',
          basis: 'ACCRUED',
          reason: 'ENGINE_NOT_ENABLED',
        },
        {
          metric: 'MISSION_TASK_REWARD_EXPENSE',
          basis: 'ACCRUED',
          reason: 'ENGINE_NOT_ENABLED',
        },
        {
          metric: 'WITHDRAWAL_FEE_REVENUE',
          basis: 'SETTLED',
          reason: 'FEE_REVENUE_ROLLUP_UNAVAILABLE',
        },
        {
          metric: 'TON_NETWORK_FEE_EXPENSE',
          basis: 'ACTUAL',
          reason: 'NETWORK_FEE_ROLLUP_UNAVAILABLE',
        },
        {
          metric: 'INVALID_TRAFFIC_ADJUSTMENTS_LOSS',
          basis: 'SETTLED',
          reason: 'INVALID_TRAFFIC_ADJUSTMENTS_UNAVAILABLE',
        },
        {
          metric: 'NET_CONTRIBUTION_MARGIN_ESTIMATE',
          basis: 'ESTIMATED',
          reason: 'MARGIN_INPUTS_INCOMPLETE',
        },
        {
          metric: 'HOT_WALLET_COVERAGE',
          basis: 'OPERATIONAL',
          reason: 'HOT_WALLET_COVERAGE_UNAVAILABLE',
        },
        {
          metric: 'OUTSTANDING_USER_LIABILITIES',
          basis: 'OPERATIONAL',
          reason: 'LIABILITY_ROLLUP_UNAVAILABLE',
        },
      ];

      for (const item of unavailableByDefault) {
        metrics.push(unavailableMetric(item.metric, item.basis, item.reason));
      }

      // Confirmed withdrawal principal is an operational payout figure — not margin.
      try {
        const settled = await this.pool.query<{ total: string }>(
          `SELECT COALESCE(sum(net_amount_atomic), 0)::text AS total
           FROM withdrawals
           WHERE state = 'CONFIRMED'`,
        );
        const total = settled.rows[0]?.total ?? null;
        metrics.push({
          metric: 'CONFIRMED_WITHDRAWAL_PRINCIPAL_OPERATIONAL',
          basis: 'OPERATIONAL',
          amountAtomic: total,
          status: total === null ? 'UNAVAILABLE' : 'READY',
          ...(total === null ? { reasonCode: 'READ_FAILED' } : {}),
          asOf,
        });
      } catch {
        metrics.push(
          unavailableMetric(
            'CONFIRMED_WITHDRAWAL_PRINCIPAL_OPERATIONAL',
            'OPERATIONAL',
            'READ_FAILED',
          ),
        );
      }

      // Exposure reserved/consumed is operational burn against configured limits —
      // never labeled provider settled revenue or contribution margin.
      const exposureConfigured = await this.pool.query<{ c: string }>(
        `SELECT count(*)::text AS c
         FROM economic_exposure_limits
         WHERE status = 'ACTIVE'`,
      );
      const exposureCount = Number(exposureConfigured.rows[0]?.c ?? 0);
      if (exposureCount === 0) {
        // Already marked NET_CONTRIBUTION_MARGIN_ESTIMATE UNAVAILABLE above.
      } else {
        try {
          const reserved = await this.pool.query<{ total: string }>(
            `SELECT COALESCE(sum(reserved_atomic + consumed_atomic), 0)::text AS total
             FROM economic_exposure_periods`,
          );
          const total = reserved.rows[0]?.total ?? null;
          // Replace the unavailable NET metric only when we still lack true margin inputs;
          // exposure burn is not contribution margin — keep margin UNAVAILABLE.
          void total;
        } catch {
          // keep UNAVAILABLE
        }
      }

      return {
        contractVersion: '1',
        metrics,
        note: 'estimates_are_not_settled_and_withdrawal_principal_is_not_margin',
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
