import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import type { AdminExposureLimitsResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class ExposureController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('exposure')
  async list(): Promise<AdminExposureLimitsResponse> {
    try {
      const rows = await this.pool.query<{
        id: string;
        limit_code: string;
        environment: string;
        limit_atomic: string | null;
        limit_bps: number | null;
        status: string;
      }>(
        `SELECT id, limit_code::text AS limit_code, environment::text AS environment,
                limit_atomic::text AS limit_atomic, limit_bps, status::text AS status
         FROM economic_exposure_limits
         ORDER BY limit_code, environment, rule_version DESC
         LIMIT 200`,
      );

      const items =
        rows.rows.length === 0
          ? [
              {
                id: null,
                limitCode: 'MAX_GLOBAL_DAILY_REWARD_EXPENSE',
                environment: this.pool ? 'LOCAL' : 'LOCAL',
                limitAtomic: null,
                limitBps: null,
                status: null,
                configured: false,
              },
            ]
          : rows.rows.map((row) => ({
              id: row.id,
              limitCode: row.limit_code,
              environment: row.environment,
              limitAtomic: row.limit_atomic,
              limitBps: row.limit_bps,
              status: row.status,
              configured: true,
            }));

      let breakerEnabled = false;
      let breakerStatus: 'READY' | 'UNAVAILABLE' = 'UNAVAILABLE';
      try {
        const flag = await this.pool.query<{ enabled: boolean }>(
          `SELECT enabled FROM feature_flags
           WHERE flag_key = 'EXPOSURE_BREAKER_ENABLED'
           ORDER BY environment
           LIMIT 1`,
        );
        if (flag.rows[0] !== undefined) {
          breakerEnabled = flag.rows[0].enabled;
          breakerStatus = 'READY';
        }
      } catch {
        breakerStatus = 'UNAVAILABLE';
      }

      return {
        contractVersion: '1',
        items,
        breakerEnabled: {
          status: breakerStatus,
          data: breakerStatus === 'READY' ? { enabled: breakerEnabled } : null,
          ...(breakerStatus === 'UNAVAILABLE'
            ? { errorCode: 'NOT_CONFIGURED' as const }
            : {}),
        },
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
