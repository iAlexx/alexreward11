import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';

import type { AdminUserDetailResponse, AdminUsersListResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { ParseUuidPipe } from '../auth/access-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class UsersController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('users')
  async listUsers(
    @Query('page', new ParseIntPipe({ optional: true })) pageRaw?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSizeRaw?: number,
  ): Promise<AdminUsersListResponse> {
    try {
      const page = Math.max(1, pageRaw ?? 1);
      const pageSize = Math.min(100, Math.max(1, pageSizeRaw ?? 25));
      const offset = (page - 1) * pageSize;

      const count = await this.pool.query<{ c: string }>(`SELECT count(*)::text AS c FROM users`);
      const total = Number(count.rows[0]?.c ?? 0);

      const rows = await this.pool.query<{
        id: string;
        telegram_user_id: string | null;
        username: string | null;
        locale: string | null;
        country_code: string | null;
        status: string;
        risk_tier: string | null;
        last_active_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, telegram_user_id::text AS telegram_user_id, username,
                preferred_locale AS locale,
                country_code, status::text AS status, risk_tier::text AS risk_tier,
                last_active_at, created_at
         FROM users
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      );

      return {
        contractVersion: '1',
        items: rows.rows.map((row) => ({
          id: row.id,
          telegramUserId: row.telegram_user_id,
          username: row.username,
          locale: row.locale,
          countryCode: row.country_code,
          status: row.status,
          riskTier: row.risk_tier,
          lastActiveAt: row.last_active_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
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

  @Get('users/:id')
  async userDetail(@Param('id', ParseUuidPipe) id: string): Promise<AdminUserDetailResponse> {
    try {
      const user = await this.pool.query<{
        id: string;
        telegram_user_id: string | null;
        username: string | null;
        locale: string | null;
        country_code: string | null;
        status: string;
        risk_tier: string | null;
        last_active_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, telegram_user_id::text AS telegram_user_id, username,
                preferred_locale AS locale,
                country_code, status::text AS status, risk_tier::text AS risk_tier,
                last_active_at, created_at
         FROM users WHERE id = $1::uuid`,
        [id],
      );
      const row = user.rows[0];
      if (row === undefined) {
        throw new NotFoundException({ error: 'NOT_FOUND', message: 'user not found' });
      }

      const userDto = {
        id: row.id,
        telegramUserId: row.telegram_user_id,
        username: row.username,
        locale: row.locale,
        countryCode: row.country_code,
        status: row.status,
        riskTier: row.risk_tier,
        lastActiveAt: row.last_active_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      };

      const withdrawals = await this.pool.query(
        `SELECT id, public_id, state::text AS state,
                requested_amount_atomic::text AS requested_amount_atomic,
                requested_at
         FROM withdrawals WHERE user_id = $1::uuid
         ORDER BY requested_at DESC LIMIT 20`,
        [id],
      );
      const wallets = await this.pool.query(
        `SELECT id, friendly_address, status::text AS status, is_primary
         FROM user_wallets WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 20`,
        [id],
      );
      const risk = await this.pool.query(
        `SELECT id, score, risk_tier::text AS tier, calculated_at AS created_at
         FROM risk_snapshots WHERE user_id = $1::uuid
         ORDER BY calculated_at DESC LIMIT 5`,
        [id],
      ).catch(() => ({ rows: [] as Record<string, unknown>[] }));

      return {
        contractVersion: '1',
        user: userDto,
        tabs: {
          overview: { status: 'READY', data: { user: userDto } },
          ledger: {
            status: 'READY',
            data: {
              note: 'Balances are ledger-derived; no direct balance editor exists on Admin.',
            },
          },
          rewards: { status: 'READY', data: { recent: [] } },
          ads: { status: 'READY', data: { recent: [] } },
          withdrawals: {
            status: withdrawals.rows.length === 0 ? 'EMPTY' : 'READY',
            data: { items: withdrawals.rows },
            ...(withdrawals.rows.length === 0 ? { errorCode: 'NO_DATA' as const } : {}),
          },
          wallets: {
            status: wallets.rows.length === 0 ? 'EMPTY' : 'READY',
            data: { items: wallets.rows },
            ...(wallets.rows.length === 0 ? { errorCode: 'NO_DATA' as const } : {}),
          },
          referrals: {
            status: 'UNAVAILABLE',
            data: null,
            errorCode: 'ENGINE_NOT_ENABLED',
          },
          risk: {
            status: risk.rows.length === 0 ? 'EMPTY' : 'READY',
            data: { snapshots: risk.rows },
          },
          security: { status: 'READY', data: { status: row.status } },
          support: { status: 'EMPTY', data: { tickets: [] }, errorCode: 'NO_DATA' },
          audit: { status: 'READY', data: { note: 'See /v1/admin/audit for append-only logs' } },
        },
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
