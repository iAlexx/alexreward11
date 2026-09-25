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
  AdminFeatureFlagMutateRequest,
  AdminFeatureFlagsListResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import { setFeatureFlagEnabled, withLedgerTransaction } from '@alex-rewards/rewards';

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
  PHASE10_PAYOUT_DISPATCH_PAUSE_BASELINE,
  requireNonEmptyString,
} from './http.js';

/**
 * Feature flags Admin API.
 * PAYOUT_DISPATCH_PAUSE may be displayed; silent flip of accepted Phase 10 baseline
 * is refused without explicit reason + recent reauth + expectedVersion.
 * Owner may still change with full ceremony — never auto-changed by this surface.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class FeatureFlagsController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('feature-flags')
  async list(): Promise<AdminFeatureFlagsListResponse> {
    try {
      const rows = await this.pool.query<{
        id: string;
        flag_key: string;
        environment: string;
        enabled: boolean;
        description: string | null;
        version: string;
      }>(
        `SELECT f.id, f.flag_key, f.environment::text AS environment, f.enabled, f.description,
                COALESCE((
                  SELECT MAX(v.flag_version)::text
                  FROM feature_flag_versions v
                  WHERE v.feature_flag_id = f.id
                ), '0') AS version
         FROM feature_flags f
         ORDER BY f.flag_key, f.environment`,
      );
      return {
        contractVersion: '1',
        items: rows.rows.map((row) => ({
          flagKey: row.flag_key,
          environment: row.environment,
          enabled: row.enabled,
          description: row.description,
          version: Number(row.version),
          requiresExplicitCeremony:
            row.flag_key === 'PAYOUT_DISPATCH_PAUSE' ||
            row.flag_key === 'PAYOUT_DISPATCH_ENABLED',
        })),
        phase10BaselineNote: PHASE10_PAYOUT_DISPATCH_PAUSE_BASELINE,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('feature-flags')
  @HttpCode(200)
  async mutate(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body() body: AdminFeatureFlagMutateRequest,
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const flagKey = requireNonEmptyString(body.flagKey, 'flagKey');
      const environment = requireNonEmptyString(
        body.environment,
        'environment',
      ) as 'LOCAL' | 'STAGING' | 'PRODUCTION';
      if (typeof body.enabled !== 'boolean') {
        throw Object.assign(new Error('enabled boolean required'), { code: 'VALIDATION' });
      }

      // Silent flip refusal: empty/whitespace reason already blocked by gateHighImpactMutation.
      // Additionally refuse if reason is a no-op placeholder for PAYOUT_DISPATCH_PAUSE.
      if (
        flagKey === 'PAYOUT_DISPATCH_PAUSE' &&
        /^(flip|toggle|auto|silent)$/i.test(gated.reason)
      ) {
        throw Object.assign(
          new Error(
            'PAYOUT_DISPATCH_PAUSE requires an explicit Owner ceremony reason; silent flip refused',
          ),
          { code: 'FORBIDDEN' },
        );
      }

      await assertOptionalConfirmation(body.confirmation, {
        action: 'feature_flags.mutate',
        resourceType: 'feature_flag',
        resourceId: `${flagKey}:${environment}`,
        expectedVersion: gated.expectedVersion,
        payload: { flagKey, environment, enabled: body.enabled, reason: gated.reason },
      });

      const current = await this.pool.query<{
        id: string;
        enabled: boolean;
        version: string;
      }>(
        `SELECT f.id, f.enabled,
                COALESCE((
                  SELECT MAX(v.flag_version)::text FROM feature_flag_versions v
                  WHERE v.feature_flag_id = f.id
                ), '0') AS version
         FROM feature_flags f
         WHERE f.flag_key = $1 AND f.environment = $2::environment_name`,
        [flagKey, environment],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw Object.assign(new Error('feature flag not found'), { code: 'VALIDATION' });
      }
      if (row.version !== gated.expectedVersion) {
        throw Object.assign(new Error('expectedVersion mismatch'), {
          code: 'VALIDATION',
          details: { expectedVersion: gated.expectedVersion, actualVersion: row.version },
        });
      }

      await withLedgerTransaction(this.pool, async (client) => {
        await setFeatureFlagEnabled(client, {
          flagKey,
          environment,
          enabled: body.enabled,
        });
        await client.query(
          `INSERT INTO feature_flag_versions (
             feature_flag_id, flag_version, old_enabled, new_enabled, reason, changed_by_admin_id
           ) VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)`,
          [
            row.id,
            Number(row.version) + 1,
            row.enabled,
            body.enabled,
            gated.reason,
            session.adminUserId,
          ],
        );
        await client.query(
          `INSERT INTO audit_logs (
             admin_user_id, actor_type, action_type, resource_type, resource_id,
             after_snapshot, reason, source
           ) VALUES (
             $1::uuid, 'ADMIN', 'feature_flags.mutate', 'feature_flag', $2,
             $3::jsonb, $4, 'WEB'
           )`,
          [
            session.adminUserId,
            row.id,
            JSON.stringify({
              flagKey,
              environment,
              oldEnabled: row.enabled,
              newEnabled: body.enabled,
              expectedVersion: gated.expectedVersion,
            }),
            gated.reason,
          ],
        );
      });

      return {
        contractVersion: '1' as const,
        flagKey,
        environment,
        enabled: body.enabled,
        version: Number(row.version) + 1,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
