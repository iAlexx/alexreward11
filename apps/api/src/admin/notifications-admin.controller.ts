import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { VerifiedAdminSession } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { AdminNotificationCampaignDraftRequest } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import {
  AdminSessionGuard,
  CurrentAdminSession,
} from '../admin-auth/admin-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  enforceAdminMutationCsrf,
  gateHighImpactMutation,
  mapAdminDomainError,
  requireNonEmptyString,
} from './http.js';

/** Notification campaign foundation — draft metadata only. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class NotificationsAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('notifications/campaigns')
  async list() {
    try {
      const rows = await this.pool.query(
        `SELECT id, public_id, code, title, category::text AS category,
                status::text AS status, created_at
         FROM notification_campaigns
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

  @Post('notifications/campaigns/draft')
  @HttpCode(200)
  async createDraft(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body() body: AdminNotificationCampaignDraftRequest & { readonly expectedVersion: string },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const code = requireNonEmptyString(body.code, 'code');
      const title = requireNonEmptyString(body.title, 'title');
      const category = requireNonEmptyString(body.category, 'category');
      if (category === 'SECURITY') {
        throw Object.assign(new Error('SECURITY category campaigns are forbidden'), {
          code: 'VALIDATION',
        });
      }

      const inserted = await this.pool.query<{ id: string; public_id: string }>(
        `INSERT INTO notification_campaigns (
           code, title, category, segment_code, status, created_by_admin_id
         ) VALUES (
           $1, $2, $3::notification_category, 'ALL_ELIGIBLE'::notification_segment_code,
           'DRAFT'::notification_campaign_status, $4::uuid
         )
         RETURNING id, public_id`,
        [code, title, category, session.adminUserId],
      );
      const row = inserted.rows[0];
      return {
        contractVersion: '1' as const,
        campaign: row,
        status: 'DRAFT' as const,
        note: 'draft metadata only — no send/dispatch in this phase',
        reason: gated.reason,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
