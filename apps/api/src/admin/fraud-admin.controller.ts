import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import type { AdminFraudReadResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

/** Existing risk read only — Phase 14 fraud engine marked unavailable. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class FraudAdminController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('fraud')
  async read(@Query('userId') userId?: string): Promise<AdminFraudReadResponse> {
    try {
      let existingRisk: AdminFraudReadResponse['existingRisk'] = {
        status: 'EMPTY',
        data: null,
        errorCode: 'NO_DATA',
      };

      if (userId !== undefined && userId.trim() !== '') {
        const snapshots = await this.pool.query(
          `SELECT id, score, risk_tier::text AS risk_tier, decision_scope::text AS decision_scope,
                  reason_codes, calculated_at
           FROM risk_snapshots
           WHERE user_id = $1::uuid
           ORDER BY calculated_at DESC
           LIMIT 20`,
          [userId.trim()],
        );
        const flags = await this.pool.query(
          `SELECT id, flag_type, status::text AS status, created_at
           FROM fraud_flags
           WHERE user_id = $1::uuid
           ORDER BY created_at DESC
           LIMIT 20`,
          [userId.trim()],
        ).catch(() => ({ rows: [] as Record<string, unknown>[] }));

        existingRisk = {
          status: snapshots.rows.length === 0 && flags.rows.length === 0 ? 'EMPTY' : 'READY',
          data: { snapshots: snapshots.rows, flags: flags.rows },
          ...(snapshots.rows.length === 0 && flags.rows.length === 0
            ? { errorCode: 'NO_DATA' as const }
            : {}),
        };
      }

      return {
        contractVersion: '1',
        existingRisk,
        phase14Engine: {
          status: 'UNAVAILABLE',
          reasonCode: 'ENGINE_NOT_ENABLED',
        },
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
