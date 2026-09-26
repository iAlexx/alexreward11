import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  assertProviderMonetaryApprovalAllowed,
  getProviderAdminView,
  listProviderClarifications,
  type ProviderMonetaryStatus,
} from '@alex-rewards/ads';
import type { VerifiedAdminSession } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type {
  AdminProviderMonetaryApprovalRequest,
  AdminProvidersListResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import {
  AdminSessionGuard,
  CurrentAdminSession,
} from '../admin-auth/admin-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  requireConsumedConfirmation,
  enforceAdminMutationCsrf,
  gateHighImpactMutation,
  mapAdminDomainError,
} from './http.js';

@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class AdsAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('ads/providers')
  async listProviders(): Promise<AdminProvidersListResponse> {
    try {
      const rows = await this.pool.query<{
        id: string;
        code: string;
        name: string;
        status: string;
        production_monetary_status: string;
        lifecycle_state: string;
      }>(
        `SELECT id, code, name, status::text AS status,
                production_monetary_status::text AS production_monetary_status,
                lifecycle_state::text AS lifecycle_state
         FROM ad_providers
         ORDER BY code`,
      );
      return {
        contractVersion: '1',
        items: rows.rows.map((row) => ({
          providerId: row.id,
          providerCode: row.code,
          name: row.name,
          status: row.status,
          productionMonetaryStatus: row.production_monetary_status,
          lifecycleState: row.lifecycle_state,
        })),
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('ads/providers/:code')
  async providerDetail(@Param('code') code: string) {
    try {
      const view = await getProviderAdminView(this.pool, { providerCode: code });
      return { contractVersion: '1' as const, provider: view };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  /**
   * Monetary status mutation — APPROVED without clarification gate is refused.
   * Does not invent Owner production values; AdsGram stays BLOCKED until clarifications close.
   */
  @Post('ads/providers/:code/monetary-status')
  @HttpCode(200)
  async setMonetaryStatus(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('code') code: string,
    @Body() body: AdminProviderMonetaryApprovalRequest,
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const targetStatus = body.targetStatus as ProviderMonetaryStatus;

      const provider = await this.pool.query<{ id: string }>(
        `SELECT id FROM ad_providers WHERE code = $1`,
        [code],
      );
      const providerId = provider.rows[0]?.id;
      if (providerId === undefined) {
        mapAdminDomainError(
          Object.assign(new Error('provider not found'), { code: 'PROVIDER_NOT_FOUND' }),
        );
      }

      const client = await this.pool.connect();
      try {
        const clarifications = await listProviderClarifications(client, providerId!);
        const openCount = clarifications.filter((item) => item.status === 'OPEN').length;
        assertProviderMonetaryApprovalAllowed({
          providerCode: code,
          targetStatus,
          openClarificationCount: openCount,
        });
      } finally {
        client.release();
      }

      await requireConsumedConfirmation(this.pool, session, body.confirmationId, {
        action: 'ads.monetary_status',
        resourceType: 'ad_provider',
        resourceId: code,
        expectedVersion: gated.expectedVersion,
        payload: { targetStatus, reason: gated.reason },
      });

      // Even after gate, we only allow non-APPROVED updates without additional Owner ceremony
      // for production unlock — APPROVED path still requires closed clarifications above.
      const updated = await this.pool.query(
        `UPDATE ad_providers
         SET production_monetary_status = $2::provider_monetary_status,
             updated_at = now()
         WHERE code = $1
         RETURNING id, code, production_monetary_status::text AS production_monetary_status`,
        [code, targetStatus],
      );

      await this.pool.query(
        `INSERT INTO audit_logs (
           admin_user_id, actor_type, action_type, resource_type, resource_id,
           after_snapshot, reason, source
         ) VALUES (
           $1::uuid, 'ADMIN', 'ads.provider_monetary_status', 'ad_provider', $2,
           $3::jsonb, $4, 'WEB'
         )`,
        [
          session.adminUserId,
          updated.rows[0]?.id ?? code,
          JSON.stringify({
            providerCode: code,
            productionMonetaryStatus: targetStatus,
            expectedVersion: gated.expectedVersion,
          }),
          gated.reason,
        ],
      );

      return {
        contractVersion: '1' as const,
        providerCode: code,
        productionMonetaryStatus: targetStatus,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
