import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import type { AdminEconomicsResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

/**
 * Economics dashboard — estimated vs settled are separate labels.
 * Unconfigured exposure reports UNAVAILABLE, never invented numbers.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class EconomicsController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('economics')
  async economics(): Promise<AdminEconomicsResponse> {
    try {
      let settledAtomic: string | null = null;
      let settledStatus: AdminEconomicsResponse['settled']['status'] = 'UNAVAILABLE';
      let settledReason: string | undefined = 'NOT_CONFIGURED';

      try {
        const settled = await this.pool.query<{ total: string }>(
          `SELECT COALESCE(sum(net_amount_atomic), 0)::text AS total
           FROM withdrawals
           WHERE state = 'CONFIRMED'`,
        );
        settledAtomic = settled.rows[0]?.total ?? '0';
        settledStatus = 'READY';
        settledReason = undefined;
      } catch {
        settledStatus = 'UNAVAILABLE';
        settledReason = 'READ_FAILED';
        settledAtomic = null;
      }

      // Estimated eCPM / projected reward expense — only from configured ACTIVE rules.
      let estimatedAtomic: string | null = null;
      let estimatedStatus: AdminEconomicsResponse['estimated']['status'] = 'UNAVAILABLE';
      let estimatedReason: string | undefined = 'NOT_CONFIGURED';

      const exposureConfigured = await this.pool.query<{ c: string }>(
        `SELECT count(*)::text AS c
         FROM economic_exposure_limits
         WHERE status = 'ACTIVE'`,
      );
      const exposureCount = Number(exposureConfigured.rows[0]?.c ?? 0);
      if (exposureCount === 0) {
        estimatedStatus = 'UNAVAILABLE';
        estimatedReason = 'NOT_CONFIGURED';
        estimatedAtomic = null;
      } else {
        const reserved = await this.pool.query<{ total: string }>(
          `SELECT COALESCE(sum(reserved_atomic + consumed_atomic), 0)::text AS total
           FROM economic_exposure_periods`,
        );
        estimatedAtomic = reserved.rows[0]?.total ?? null;
        estimatedStatus = estimatedAtomic === null ? 'UNAVAILABLE' : 'READY';
        estimatedReason = estimatedAtomic === null ? 'NOT_CONFIGURED' : undefined;
      }

      return {
        contractVersion: '1',
        estimated: {
          kind: 'ESTIMATED',
          amountAtomic: estimatedAtomic,
          status: estimatedStatus,
          ...(estimatedReason !== undefined ? { reasonCode: estimatedReason } : {}),
        },
        settled: {
          kind: 'SETTLED',
          amountAtomic: settledAtomic,
          status: settledStatus,
          ...(settledReason !== undefined ? { reasonCode: settledReason } : {}),
        },
        note: 'estimates_are_not_settled',
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
