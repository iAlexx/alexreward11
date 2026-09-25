import { Controller, Get, Inject, ParseIntPipe, Query, UseGuards } from '@nestjs/common';

import type { AdminAuditLogsResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

/** Append-only audit log read. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class AuditController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('audit')
  async list(
    @Query('limit', new ParseIntPipe({ optional: true })) limitRaw?: number,
  ): Promise<AdminAuditLogsResponse> {
    try {
      const limit = Math.min(200, Math.max(1, limitRaw ?? 50));
      const rows = await this.pool.query(
        `SELECT id, admin_user_id, actor_type::text AS actor_type, action_type,
                resource_type, resource_id, reason, source::text AS source, created_at
         FROM audit_logs
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );
      return {
        contractVersion: '1',
        items: rows.rows,
        appendOnly: true,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
