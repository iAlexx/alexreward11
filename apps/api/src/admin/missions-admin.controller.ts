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

import type { VerifiedAdminSession } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';
import {
  MissionDomainError,
  parseMissionEligibilityPolicy,
  validateMissionVersionStructure,
} from '@alex-rewards/tasks';

import {
  AdminSessionGuard,
  CurrentAdminSession,
} from '../admin-auth/admin-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  enforceAdminMutationCsrf,
  gateHighImpactMutation,
  mapAdminDomainError,
  requireConsumedConfirmation,
  requireNonEmptyString,
} from './http.js';

const ALLOWED_ADMIN_CONDITIONS = new Set([
  'DAILY_LOGIN',
  'VALID_AD_COUNT',
  'STREAK_MILESTONE',
]);

function parseRequiredIsoTimestamp(value: unknown, field: string): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw Object.assign(new Error(`${field} is required`), { code: 'VALIDATION' });
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw Object.assign(new Error(`${field} must be a finite ISO timestamp`), {
      code: 'VALIDATION',
    });
  }
  return parsed;
}

async function assertMissionRewardRuleActivatable(
  pool: Pool,
  rewardRuleId: string,
  versionStartAt: Date,
): Promise<void> {
  const rule = await pool.query<{
    source_type: string;
    fixed_reward_atomic: string | null;
    status: string;
    valid_from: Date;
    valid_to: Date | null;
  }>(
    `SELECT source_type::text AS source_type,
            fixed_reward_atomic::text AS fixed_reward_atomic,
            status::text AS status, valid_from, valid_to
     FROM reward_rules
     WHERE id = $1::uuid
     FOR SHARE`,
    [rewardRuleId],
  );
  const row = rule.rows[0];
  if (row === undefined) {
    throw Object.assign(new Error('reward rule not found'), { code: 'VALIDATION' });
  }
  if (row.source_type !== 'MISSION') {
    throw Object.assign(new Error('reward source must be MISSION'), { code: 'VALIDATION' });
  }
  if (row.fixed_reward_atomic === null || BigInt(row.fixed_reward_atomic) <= 0n) {
    throw Object.assign(new Error('mission reward rule fixed amount invalid'), {
      code: 'VALIDATION',
    });
  }
  if (row.status !== 'ACTIVE') {
    throw Object.assign(new Error(`reward rule status ${row.status} blocks activation`), {
      code: 'VALIDATION',
    });
  }
  if (versionStartAt < row.valid_from) {
    throw Object.assign(new Error('mission start_at before reward rule valid_from'), {
      code: 'VALIDATION',
    });
  }
  if (row.valid_to !== null && !(versionStartAt < row.valid_to)) {
    throw Object.assign(new Error('mission start_at outside reward rule validity window'), {
      code: 'VALIDATION',
    });
  }
}

/**
 * Mission administration (Phase 16).
 * Allowlisted conditions only. Activation uses Phase 13 high-impact confirmation.
 * No ledger mutation from Admin.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class MissionsAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('missions')
  async list() {
    try {
      const definitions = await this.pool.query(
        `SELECT md.id, md.code, md.name_key, md.status::text AS status, md.created_at,
                (SELECT count(*)::int FROM mission_versions mv WHERE mv.mission_definition_id = md.id) AS version_count,
                (SELECT count(*)::int FROM mission_progress mp
                   JOIN mission_versions mv ON mv.id = mp.mission_version_id
                  WHERE mv.mission_definition_id = md.id) AS progress_count,
                (SELECT count(*)::int FROM mission_claims mc
                   JOIN mission_versions mv ON mv.id = mc.mission_version_id
                  WHERE mv.mission_definition_id = md.id) AS claim_count,
                (SELECT count(*)::int FROM mission_claims mc
                   JOIN mission_versions mv ON mv.id = mc.mission_version_id
                  WHERE mv.mission_definition_id = md.id
                    AND mc.status = 'GRANTED') AS granted_count
         FROM mission_definitions md
         ORDER BY md.code ASC`,
      );
      const versions = await this.pool.query(
        `SELECT mv.id, mv.mission_definition_id, mv.mission_version, mv.name_key,
                mv.condition_type::text AS condition_type, mv.target,
                mv.reset_policy::text AS reset_policy, mv.status::text AS status,
                mv.start_at, mv.end_at, mv.required_membership_plan_id, mv.reward_rule_id,
                mv.reward_source_type::text AS reward_source_type,
                md.code AS definition_code
         FROM mission_versions mv
         JOIN mission_definitions md ON md.id = mv.mission_definition_id
         ORDER BY md.code ASC, mv.mission_version ASC`,
      );
      return {
        contractVersion: '1' as const,
        status: 'READY' as const,
        reasonCode: undefined,
        data: {
          definitions: definitions.rows,
          versions: versions.rows,
          allowlistedConditions: [...ALLOWED_ADMIN_CONDITIONS],
        },
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('missions/definitions')
  @HttpCode(200)
  async createDefinition(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body()
    body: {
      readonly code?: unknown;
      readonly nameKey?: unknown;
      readonly reason?: unknown;
    },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const reason = requireNonEmptyString(body.reason, 'reason');
      const code = requireNonEmptyString(body.code, 'code');
      const nameKey = requireNonEmptyString(body.nameKey, 'nameKey');
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
        throw Object.assign(new Error('mission code format invalid'), {
          code: 'VALIDATION',
        });
      }

      const client = await this.pool.connect();
      let id: string;
      try {
        await client.query('BEGIN');
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO mission_definitions (code, name_key, status)
           VALUES ($1, $2, 'DRAFT'::content_status)
           RETURNING id`,
          [code, nameKey],
        );
        id = inserted.rows[0]?.id ?? '';
        if (id === '') throw new Error('definition insert failed');

        await client.query(
          `INSERT INTO audit_logs (
             admin_user_id, actor_type, action_type, resource_type, resource_id,
             after_snapshot, reason, source
           ) VALUES (
             $1::uuid, 'ADMIN', 'missions.definition_create', 'mission_definition', $2,
             $3::jsonb, $4, 'WEB'
           )`,
          [
            session.adminUserId,
            id,
            JSON.stringify({ code, nameKey, status: 'DRAFT' }),
            reason,
          ],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      return { contractVersion: '1' as const, id, status: 'DRAFT' as const };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('missions/versions')
  @HttpCode(200)
  async createVersion(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body()
    body: {
      readonly missionDefinitionId?: unknown;
      readonly conditionType?: unknown;
      readonly target?: unknown;
      readonly resetPolicy?: unknown;
      readonly nameKey?: unknown;
      readonly descriptionKey?: unknown;
      readonly rewardRuleId?: unknown;
      readonly requiredMembershipPlanId?: unknown;
      readonly eligibilityPolicy?: unknown;
      readonly startAt?: unknown;
      readonly reason?: unknown;
    },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const reason = requireNonEmptyString(body.reason, 'reason');
      const missionDefinitionId = requireNonEmptyString(
        body.missionDefinitionId,
        'missionDefinitionId',
      );
      const conditionType = requireNonEmptyString(body.conditionType, 'conditionType');
      if (!ALLOWED_ADMIN_CONDITIONS.has(conditionType)) {
        throw Object.assign(new Error('conditionType not allowlisted for Phase16 admin create'), {
          code: 'VALIDATION',
        });
      }
      const nameKey = requireNonEmptyString(body.nameKey, 'nameKey');
      const resetPolicy = requireNonEmptyString(body.resetPolicy, 'resetPolicy');
      const startAt = parseRequiredIsoTimestamp(body.startAt, 'startAt');
      if (resetPolicy === 'WEEKLY') {
        throw Object.assign(new Error('WEEKLY reset is OWNER_POLICY_REQUIRED'), {
          code: 'OWNER_POLICY_REQUIRED',
        });
      }
      const target = typeof body.target === 'number' ? body.target : Number(body.target);
      if (!Number.isInteger(target) || target <= 0) {
        throw Object.assign(new Error('target must be a positive integer'), {
          code: 'VALIDATION',
        });
      }

      const eligibilityPolicy =
        body.eligibilityPolicy === undefined || body.eligibilityPolicy === null
          ? {}
          : body.eligibilityPolicy;
      parseMissionEligibilityPolicy(eligibilityPolicy);
      const parsed = parseMissionEligibilityPolicy(eligibilityPolicy);
      if (parsed.countryGroup !== null) {
        throw Object.assign(
          new Error('countryGroup configured but COUNTRY_AUTHORITY_UNAVAILABLE'),
          { code: 'OWNER_POLICY_REQUIRED' },
        );
      }
      if (conditionType === 'STREAK_MILESTONE' && parsed.streak === null) {
        throw Object.assign(new Error('STREAK_MILESTONE requires explicit streak eligibilityPolicy'), {
          code: 'VALIDATION',
        });
      }

      const rewardRuleId =
        body.rewardRuleId === undefined || body.rewardRuleId === null || body.rewardRuleId === ''
          ? null
          : requireNonEmptyString(body.rewardRuleId, 'rewardRuleId');
      const requiredMembershipPlanId =
        body.requiredMembershipPlanId === undefined ||
        body.requiredMembershipPlanId === null ||
        body.requiredMembershipPlanId === ''
          ? null
          : requireNonEmptyString(body.requiredMembershipPlanId, 'requiredMembershipPlanId');

      const client = await this.pool.connect();
      let id: string;
      let missionVersion: number;
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT id FROM mission_definitions WHERE id = $1::uuid FOR UPDATE`,
          [missionDefinitionId],
        );
        const nextVersion = await client.query<{ n: number }>(
          `SELECT COALESCE(MAX(mission_version), 0) + 1 AS n
           FROM mission_versions WHERE mission_definition_id = $1::uuid`,
          [missionDefinitionId],
        );
        missionVersion = nextVersion.rows[0]?.n ?? 1;

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO mission_versions (
             mission_definition_id, mission_version, name_key, description_key,
             condition_type, target, reset_policy, eligibility_policy,
             required_membership_plan_id, reward_source_type, reward_rule_id,
             status, start_at, created_by_admin_id
           ) VALUES (
             $1::uuid, $2, $3, $4,
             $5::mission_condition_type, $6, $7::mission_reset_policy, $8::jsonb,
             $9::uuid, 'MISSION'::reward_source_type, $10::uuid,
             'DRAFT'::rule_version_status, $11::timestamptz, $12::uuid
           )
           RETURNING id`,
          [
            missionDefinitionId,
            missionVersion,
            nameKey,
            typeof body.descriptionKey === 'string' ? body.descriptionKey : null,
            conditionType,
            target,
            resetPolicy,
            JSON.stringify(eligibilityPolicy),
            requiredMembershipPlanId,
            rewardRuleId,
            startAt.toISOString(),
            session.adminUserId,
          ],
        );
        id = inserted.rows[0]?.id ?? '';
        if (id === '') throw new Error('version insert failed');

        const loaded = await client.query(
          `SELECT id, mission_definition_id, mission_version, name_key, description_key,
                  condition_type::text AS condition_type, target, reset_policy::text AS reset_policy,
                  eligibility_policy, required_membership_plan_id,
                  reward_source_type::text AS reward_source_type, reward_rule_id,
                  status::text AS status, start_at, end_at, created_at
           FROM mission_versions WHERE id = $1::uuid`,
          [id],
        );
        const { mapMissionVersionRow } = await import('@alex-rewards/tasks');
        validateMissionVersionStructure(mapMissionVersionRow(loaded.rows[0]!));

        await client.query(
          `INSERT INTO audit_logs (
             admin_user_id, actor_type, action_type, resource_type, resource_id,
             after_snapshot, reason, source
           ) VALUES (
             $1::uuid, 'ADMIN', 'missions.version_create', 'mission_version', $2,
             $3::jsonb, $4, 'WEB'
           )`,
          [
            session.adminUserId,
            id,
            JSON.stringify({
              missionDefinitionId,
              missionVersion,
              conditionType,
              target,
              resetPolicy,
              rewardRuleId,
              startAt: startAt.toISOString(),
            }),
            reason,
          ],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      return {
        contractVersion: '1' as const,
        id,
        missionVersion,
        status: 'DRAFT' as const,
      };
    } catch (error) {
      if (error instanceof MissionDomainError) {
        mapAdminDomainError(
          Object.assign(new Error(error.message), { code: error.code }),
        );
      }
      mapAdminDomainError(error);
    }
  }

  @Post('missions/versions/:versionId/activate')
  @HttpCode(200)
  async activateVersion(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('versionId') versionId: string,
    @Body()
    body: {
      readonly reason?: unknown;
      readonly expectedVersion?: unknown;
      readonly confirmationId?: unknown;
      readonly startAt?: unknown;
    },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);

      const current = await this.pool.query<{
        id: string;
        mission_definition_id: string;
        mission_version: number;
        condition_type: string;
        status: string;
        reward_rule_id: string | null;
        reward_source_type: string;
        eligibility_policy: unknown;
        reset_policy: string;
        start_at: Date | null;
      }>(
        `SELECT id, mission_definition_id, mission_version,
                condition_type::text AS condition_type, status::text AS status,
                reward_rule_id, reward_source_type::text AS reward_source_type,
                eligibility_policy, reset_policy::text AS reset_policy, start_at
         FROM mission_versions WHERE id = $1::uuid`,
        [versionId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        throw Object.assign(new Error('mission version not found'), { code: 'NOT_FOUND' });
      }
      if (String(row.mission_version) !== gated.expectedVersion) {
        throw Object.assign(new Error('expectedVersion mismatch'), {
          code: 'VERSION_CONFLICT',
          details: {
            expectedVersion: gated.expectedVersion,
            actualVersion: row.mission_version,
          },
        });
      }
      if (!ALLOWED_ADMIN_CONDITIONS.has(row.condition_type)) {
        throw Object.assign(new Error('conditionType not allowlisted'), { code: 'VALIDATION' });
      }
      if (row.reset_policy === 'WEEKLY') {
        throw Object.assign(new Error('WEEKLY reset is OWNER_POLICY_REQUIRED'), {
          code: 'OWNER_POLICY_REQUIRED',
        });
      }
      const eligibility = parseMissionEligibilityPolicy(row.eligibility_policy);
      if (eligibility.countryGroup !== null) {
        throw Object.assign(new Error('countryGroup activation blocked'), {
          code: 'OWNER_POLICY_REQUIRED',
        });
      }
      if (
        row.condition_type === 'VALID_AD_COUNT' &&
        row.reward_rule_id !== null &&
        this.config.DEPLOYMENT_ENV === 'production'
      ) {
        throw Object.assign(
          new Error(
            'PRODUCTION monetary VALID_AD_COUNT activation blocked: post-grant AD reversal OWNER_POLICY_REQUIRED',
          ),
          { code: 'OWNER_POLICY_REQUIRED' },
        );
      }
      if (row.reward_rule_id !== null && row.reward_source_type !== 'MISSION') {
        throw Object.assign(new Error('reward source must be MISSION'), { code: 'VALIDATION' });
      }
      if (row.status !== 'DRAFT') {
        throw Object.assign(new Error('only DRAFT mission versions may be activated'), {
          code: 'VALIDATION',
        });
      }
      if (row.start_at === null) {
        throw Object.assign(new Error('mission version start_at is not configured'), {
          code: 'MISSION_START_AT_NOT_CONFIGURED',
        });
      }
      const effectiveStartAt = row.start_at;
      if (row.reward_rule_id !== null) {
        await assertMissionRewardRuleActivatable(
          this.pool,
          row.reward_rule_id,
          effectiveStartAt,
        );
      }

      await requireConsumedConfirmation(this.pool, session, body.confirmationId, {
        action: 'MISSION_VERSION_ACTIVATE',
        resourceType: 'mission_version',
        resourceId: versionId,
        expectedVersion: gated.expectedVersion,
        payload: {
          versionId,
          reason: gated.reason,
          startAt: effectiveStartAt.toISOString(),
        },
      });

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT id FROM mission_definitions WHERE id = $1::uuid FOR UPDATE`,
          [row.mission_definition_id],
        );
        await client.query(
          `SELECT id FROM mission_versions WHERE id = $1::uuid FOR UPDATE`,
          [versionId],
        );
        await client.query(
          `UPDATE mission_definitions
           SET status = 'ACTIVE'::content_status, updated_at = now()
           WHERE id = $1::uuid`,
          [row.mission_definition_id],
        );
        await client.query(
          `UPDATE mission_versions
           SET status = 'SUPERSEDED'::rule_version_status,
               end_at = COALESCE(end_at, $2::timestamptz),
               updated_at = now()
           WHERE mission_definition_id = $1::uuid
             AND status = 'ACTIVE'
             AND id <> $3::uuid
             AND end_at IS NULL`,
          [row.mission_definition_id, effectiveStartAt.toISOString(), versionId],
        );
        await client.query(
          `UPDATE mission_versions
           SET status = 'ACTIVE'::rule_version_status,
               updated_at = now()
           WHERE id = $1::uuid
             AND status = 'DRAFT'::rule_version_status`,
          [versionId],
        );
        await client.query(
          `INSERT INTO audit_logs (
             admin_user_id, actor_type, action_type, resource_type, resource_id,
             before_snapshot, after_snapshot, reason, source
           ) VALUES (
             $1::uuid, 'ADMIN', 'missions.version_activate', 'mission_version', $2,
             $3::jsonb, $4::jsonb, $5, 'WEB'
           )`,
          [
            session.adminUserId,
            versionId,
            JSON.stringify({ status: row.status }),
            JSON.stringify({ status: 'ACTIVE', startAt: effectiveStartAt.toISOString() }),
            gated.reason,
          ],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      return { contractVersion: '1' as const, id: versionId, status: 'ACTIVE' as const };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
