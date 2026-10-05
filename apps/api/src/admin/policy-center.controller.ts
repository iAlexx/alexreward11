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
import type { AdminPolicyFamiliesResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import {
  createExposureLimitVersion,
  withLedgerTransaction,
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
  refuseArbitraryPolicyPayload,
  requireNonEmptyString,
} from './http.js';

const POLICY_FAMILIES = [
  'PROVIDER_LIMITS',
  'FEATURE_FLAGS',
  'EXPOSURE_LIMITS',
  'REWARD_RULES',
  'BENEFIT_RULES',
  'WITHDRAWAL_LIMITS',
] as const;

/**
 * Policy Center — typed rule families only.
 * Arbitrary JS / eval / SQL execution payloads are refused.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class PolicyCenterController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('policy/families')
  families(): AdminPolicyFamiliesResponse {
    return {
      contractVersion: '1',
      families: POLICY_FAMILIES.map((family) => ({
        family,
        typedOnly: true as const,
        acceptsArbitraryCode: false as const,
      })),
    };
  }

  @Post('policy/change')
  @HttpCode(200)
  async typedChange(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body() body: Record<string, unknown>,
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      refuseArbitraryPolicyPayload(body);
      const gated = gateHighImpactMutation(session, body);
      const family = requireNonEmptyString(body.family, 'family');
      if (!(POLICY_FAMILIES as readonly string[]).includes(family)) {
        return mapAdminDomainError(
          Object.assign(new Error(`unknown policy family: ${family}`), {
            code: 'VALIDATION',
          }),
        );
      }

      await requireConsumedConfirmation(this.pool, session, body.confirmationId, {
        action: `policy.${family}`,
        resourceType: 'policy_family',
        resourceId: family,
        expectedVersion: gated.expectedVersion,
        payload: { family, reason: gated.reason, typed: body.typed },
      });

      // FEATURE_FLAGS: use dedicated POST /v1/admin/feature-flags only (P19-SEC-009).
      // Do not mutate flags here — weaker version/audit/silent-flip stack than dedicated route.

      if (family === 'EXPOSURE_LIMITS') {
        const typed = body.typed as {
          limitCode?: string;
          environment?: string;
          ruleVersion?: number;
          limitAtomic?: string;
          limitBps?: number;
          activate?: boolean;
        };
        const created = await withLedgerTransaction(this.pool, (client) =>
          createExposureLimitVersion(client, {
            limitCode: requireNonEmptyString(typed?.limitCode, 'typed.limitCode') as never,
            environment: requireNonEmptyString(
              typed?.environment,
              'typed.environment',
            ) as 'LOCAL' | 'STAGING' | 'PRODUCTION',
            ruleVersion: Number(typed?.ruleVersion ?? gated.expectedVersion),
            reason: gated.reason,
            ...(typed?.limitAtomic !== undefined ? { limitAtomic: typed.limitAtomic } : {}),
            ...(typed?.limitBps !== undefined ? { limitBps: typed.limitBps } : {}),
            activate: typed?.activate === true,
          }),
        );
        return { contractVersion: '1' as const, family, applied: true, created };
      }

      // FEATURE_FLAGS / PROVIDER_LIMITS / REWARD_RULES / BENEFIT_RULES / WITHDRAWAL_LIMITS:
      // typed change must use dedicated Admin endpoints — Policy Center only routes metadata.
      return {
        contractVersion: '1' as const,
        family,
        applied: false,
        note: 'use dedicated typed Admin endpoint for this family',
        reason: gated.reason,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
