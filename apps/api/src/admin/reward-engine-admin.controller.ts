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
import type {
  AdminCreateRewardRuleVersionRequest,
  AdminRewardRulesListResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import {
  createRewardRuleVersion,
  withLedgerTransaction,
  type CreateRewardRuleVersionCommand,
  type RewardSourceType,
} from '@alex-rewards/rewards';

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
  requireNonEmptyString,
} from './http.js';

@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class RewardEngineAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('reward-rules')
  async list(): Promise<AdminRewardRulesListResponse> {
    try {
      const rows = await this.pool.query(
        `SELECT id, code, rule_version, source_type::text AS source_type,
                provider_id, country_group, asset_id,
                user_share_bps, safety_factor_bps,
                estimated_ecpm_atomic::text AS estimated_ecpm_atomic,
                min_reward_atomic::text AS min_reward_atomic,
                max_reward_atomic::text AS max_reward_atomic,
                fixed_reward_atomic::text AS fixed_reward_atomic,
                status::text AS status, valid_from, valid_to, reason
         FROM reward_rules
         ORDER BY code, rule_version DESC
         LIMIT 200`,
      );
      return { contractVersion: '1', items: rows.rows };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  /** Create a new rule version — never mutate historical rows in place. */
  @Post('reward-rules')
  @HttpCode(200)
  async createVersion(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body() body: AdminCreateRewardRuleVersionRequest,
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const code = requireNonEmptyString(body.code, 'code');
      const assetId = requireNonEmptyString(body.assetId, 'assetId');
      await requireConsumedConfirmation(this.pool, session, body.confirmationId, {
        action: 'reward_rules.create_version',
        resourceType: 'reward_rule',
        resourceId: code,
        expectedVersion: gated.expectedVersion,
        payload: { code, assetId, reason: gated.reason },
      });

      const command: CreateRewardRuleVersionCommand = {
        code,
        sourceType: body.sourceType as RewardSourceType,
        assetId,
        reason: gated.reason,
        createdByAdminId: session.adminUserId,
        activate: body.activate === true,
        userShareBps: body.userShareBps ?? null,
        safetyFactorBps: body.safetyFactorBps ?? null,
        estimatedEcpmAtomic: body.estimatedEcpmAtomic ?? null,
        minRewardAtomic: body.minRewardAtomic ?? null,
        maxRewardAtomic: body.maxRewardAtomic ?? null,
        fixedRewardAtomic: body.fixedRewardAtomic ?? null,
        ...(body.pendingHoldSeconds !== undefined
          ? { pendingHoldSeconds: body.pendingHoldSeconds }
          : {}),
        ...(body.quoteTtlSeconds !== undefined
          ? { quoteTtlSeconds: body.quoteTtlSeconds }
          : {}),
        providerId: body.providerId ?? null,
        countryGroup: body.countryGroup ?? null,
      };

      const rule = await withLedgerTransaction(this.pool, (client) =>
        createRewardRuleVersion(client, command),
      );
      return { contractVersion: '1' as const, rule };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
