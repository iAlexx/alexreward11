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
  createProviderLimitRuleVersion,
  getProviderAdminView,
  type ProviderLimitMetric,
  type ProviderLimitScope,
  type ProviderLimitSourceType,
  type ProviderLimitWindow,
} from '@alex-rewards/ads';
import type { VerifiedAdminSession } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type {
  AdminProviderLimitChangeRequest,
  AdminProviderLimitChangeResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import {
  AdminSessionGuard,
  CurrentAdminSession,
} from '../admin-auth/admin-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  assertOptionalConfirmation,
  enforceAdminMutationCsrf,
  gateHighImpactMutation,
  mapAdminDomainError,
} from './http.js';

@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class ProvidersAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('providers/:code')
  async contractsAndCapabilities(@Param('code') code: string) {
    try {
      const view = await getProviderAdminView(this.pool, { providerCode: code });
      const contracts = await this.pool.query(
        `SELECT id, status::text AS status, effective_from, effective_to, source_reference
         FROM provider_contracts
         WHERE provider_id = $1::uuid
         ORDER BY effective_from DESC
         LIMIT 20`,
        [view.providerId],
      );
      return {
        contractVersion: '1' as const,
        provider: {
          providerId: view.providerId,
          providerCode: view.providerCode,
          name: view.name,
          capabilities: view.capabilities,
          adapterCapabilities: view.adapterCapabilities,
          limits: view.limits,
          monetary: view.monetary,
          clarifications: view.clarifications,
        },
        contracts: contracts.rows,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('providers/:code/limits')
  async limits(@Param('code') code: string) {
    try {
      const view = await getProviderAdminView(this.pool, { providerCode: code });
      return {
        contractVersion: '1' as const,
        providerCode: code,
        limits: view.limits,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('providers/:code/limits')
  @HttpCode(200)
  async changeLimit(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('code') code: string,
    @Body() body: AdminProviderLimitChangeRequest,
  ): Promise<AdminProviderLimitChangeResponse> {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      await assertOptionalConfirmation(body.confirmation, {
        action: 'providers.limit_change',
        resourceType: 'ad_provider',
        resourceId: code,
        expectedVersion: gated.expectedVersion,
        payload: {
          limitScope: body.limitScope,
          limitMetric: body.limitMetric,
          maxCount: body.maxCount,
          oldMaxCount: body.oldMaxCount,
          reason: gated.reason,
        },
      });

      const result = await createProviderLimitRuleVersion(this.pool, {
        providerCode: code,
        limitScope: body.limitScope as ProviderLimitScope,
        limitMetric: body.limitMetric as ProviderLimitMetric,
        limitWindow: (body.limitWindow as ProviderLimitWindow) || 'UTC_DAY',
        maxCount: body.maxCount,
        sourceType: body.sourceType as ProviderLimitSourceType,
        sourceReference: body.sourceReference,
        reason: gated.reason,
        oldMaxCount: body.oldMaxCount,
        expectedVersion: Number(gated.expectedVersion),
        adminUserId: session.adminUserId,
        activate: body.activate === true,
        countryCode: body.countryCode ?? null,
        riskTier: body.riskTier ?? null,
        impactPreview: body.impactPreview ?? null,
      });

      await this.pool.query(
        `INSERT INTO audit_logs (
           admin_user_id, actor_type, action_type, resource_type, resource_id,
           after_snapshot, reason, source
         ) VALUES (
           $1::uuid, 'ADMIN', 'providers.limit_change', 'provider_limit_rule', $2,
           $3::jsonb, $4, 'WEB'
         )`,
        [
          session.adminUserId,
          result.ruleId,
          JSON.stringify({
            providerCode: code,
            oldMaxCount: result.oldMaxCount,
            newMaxCount: result.newMaxCount,
            sourceType: result.sourceType,
            sourceReference: result.sourceReference,
            impactPreview: result.impactPreview,
            ruleVersion: result.ruleVersion,
            hardCeilingMaxCount: result.hardCeilingMaxCount,
          }),
          gated.reason,
        ],
      );

      return {
        contractVersion: '1',
        ruleId: result.ruleId,
        ruleVersion: result.ruleVersion,
        oldMaxCount: result.oldMaxCount,
        newMaxCount: result.newMaxCount,
        sourceType: result.sourceType,
        sourceReference: result.sourceReference,
        impactPreview: result.impactPreview,
        status: result.status,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
