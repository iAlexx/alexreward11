import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

/** Support tickets from schema when present. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class SupportAdminController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('support/tickets')
  async list(
    @Query('userId') userId?: string,
  ) {
    try {
      const rows =
        userId !== undefined && userId.trim() !== ''
          ? await this.pool.query(
              `SELECT id, public_id, user_id, state::text AS state,
                      priority::text AS priority, subject, created_at, updated_at
               FROM support_tickets
               WHERE user_id = $1::uuid
               ORDER BY created_at DESC
               LIMIT 100`,
              [userId.trim()],
            )
          : await this.pool.query(
              `SELECT id, public_id, user_id, state::text AS state,
                      priority::text AS priority, subject, created_at, updated_at
               FROM support_tickets
               ORDER BY created_at DESC
               LIMIT 100`,
            );
      return {
        contractVersion: '1' as const,
        items: rows.rows,
        status: rows.rows.length === 0 ? ('EMPTY' as const) : ('READY' as const),
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
