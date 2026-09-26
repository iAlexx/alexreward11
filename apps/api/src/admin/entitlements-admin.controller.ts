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
import type { Pool } from '@alex-rewards/db';
import {
  createBenefitRuleVersion,
  withLedgerTransaction,
  type CreateBenefitRuleVersionCommand,
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
export class EntitlementsAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('entitlements/benefit-rules')
  async listVersions() {
    try {
      const rows = await this.pool.query(
        `SELECT id, entitlement_id, membership_plan_id, rule_version,
                value_boolean, value_bps, value_integer::text AS value_integer,
                value_atomic::text AS value_atomic, value_enum,
                status::text AS status, effective_from, effective_to, reason
         FROM membership_benefit_rule_versions
         ORDER BY entitlement_id, rule_version DESC
         LIMIT 200`,
      );
      return { contractVersion: '1' as const, items: rows.rows };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('entitlements/benefit-rules')
  @HttpCode(200)
  async createVersion(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body()
    body: {
      readonly entitlementId: string;
      readonly ruleVersion: number;
      readonly reason: string;
      readonly expectedVersion: string;
      readonly membershipPlanId?: string | null;
      readonly valueBoolean?: boolean | null;
      readonly valueBps?: number | null;
      readonly valueInteger?: string | null;
      readonly valueAtomic?: string | null;
      readonly valueEnum?: string | null;
      readonly assetId?: string | null;
      readonly activate?: boolean;
      readonly confirmationId?: string;
    },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const entitlementId = requireNonEmptyString(body.entitlementId, 'entitlementId');
      await requireConsumedConfirmation(this.pool, session, body.confirmationId, {
        action: 'entitlements.benefit_rule_version',
        resourceType: 'entitlement',
        resourceId: entitlementId,
        expectedVersion: gated.expectedVersion,
        payload: { entitlementId, ruleVersion: body.ruleVersion, reason: gated.reason },
      });

      const command: CreateBenefitRuleVersionCommand = {
        entitlementId,
        ruleVersion: body.ruleVersion,
        reason: gated.reason,
        membershipPlanId: body.membershipPlanId ?? null,
        valueBoolean: body.valueBoolean ?? null,
        valueBps: body.valueBps ?? null,
        valueInteger: body.valueInteger ?? null,
        valueAtomic: body.valueAtomic ?? null,
        valueEnum: body.valueEnum ?? null,
        assetId: body.assetId ?? null,
        activate: body.activate === true,
      };

      const created = await withLedgerTransaction(this.pool, (client) =>
        createBenefitRuleVersion(client, command),
      );
      return { contractVersion: '1' as const, rule: created };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
