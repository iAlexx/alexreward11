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
import type {
  AdminReviewQueueActionRequest,
  AdminReviewQueueListResponse,
} from '@alex-rewards/contracts';
import {
  assignReviewCase,
  assertFutureDomainMutationAvailable,
  commentReviewCase,
  escalateReviewCase,
  listReviewQueue,
  resolveReviewCaseAfterDomainSuccess,
} from '@alex-rewards/control-center';
import type { Pool } from '@alex-rewards/db';

import {
  AdminSessionGuard,
  CurrentAdminSession,
} from '../admin-auth/admin-session.guard.js';
import { ParseUuidPipe } from '../auth/access-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  assertOptionalConfirmation,
  enforceAdminMutationCsrf,
  gateHighImpactMutation,
  mapAdminDomainError,
} from './http.js';

/**
 * Review Queue — actions call control-center / domain wrappers.
 * Never mutates ledger truth tables alone.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class ReviewQueueController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('review-queue')
  async list(): Promise<AdminReviewQueueListResponse> {
    try {
      const items = await listReviewQueue(this.pool, { limit: 100 });
      return {
        contractVersion: '1',
        items: items.map((item) => ({
          id: item.id,
          caseType: item.caseType,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          priority: item.priority,
          state: item.state,
          assignedAdminId: item.assignedAdminId,
          summary: item.summary,
          createdAt: item.createdAt.toISOString(),
          updatedAt: item.updatedAt.toISOString(),
        })),
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('review-queue/:id')
  async detail(@Param('id', ParseUuidPipe) id: string) {
    try {
      const row = await this.pool.query(
        `SELECT id, case_type::text AS case_type, resource_type, resource_id,
                priority::text AS priority, state::text AS state,
                assigned_admin_id, summary, resolution_notes,
                created_at, updated_at, resolved_at
         FROM review_cases WHERE id = $1::uuid`,
        [id],
      );
      const events = await this.pool.query(
        `SELECT id, event_type::text AS event_type, from_state::text AS from_state,
                to_state::text AS to_state, note, created_at
         FROM review_case_events
         WHERE review_case_id = $1::uuid
         ORDER BY created_at ASC
         LIMIT 100`,
        [id],
      );
      return {
        contractVersion: '1' as const,
        case: row.rows[0] ?? null,
        events: events.rows,
        note: 'Review Queue is not financial source of truth; domain commands own money state.',
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('review-queue/:id/actions')
  @HttpCode(200)
  async action(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('id', ParseUuidPipe) id: string,
    @Body() body: AdminReviewQueueActionRequest,
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      await assertOptionalConfirmation(body.confirmation, {
        action: `review_queue.${body.action}`,
        resourceType: 'review_case',
        resourceId: id,
        expectedVersion: gated.expectedVersion,
        payload: { action: body.action, reason: gated.reason },
      });

      switch (body.action) {
        case 'ASSIGN':
          return {
            contractVersion: '1' as const,
            result: await assignReviewCase(this.pool, {
              reviewCaseId: id,
              adminUserId: session.adminUserId,
              assigneeAdminId: session.adminUserId,
            }),
            ledgerWrite: false,
          };
        case 'COMMENT':
          return {
            contractVersion: '1' as const,
            result: await commentReviewCase(this.pool, {
              reviewCaseId: id,
              adminUserId: session.adminUserId,
              note: body.note ?? gated.reason,
            }),
            ledgerWrite: false,
          };
        case 'ESCALATE':
          return {
            contractVersion: '1' as const,
            result: await escalateReviewCase(this.pool, {
              reviewCaseId: id,
              adminUserId: session.adminUserId,
              note: body.note ?? gated.reason,
            }),
            ledgerWrite: false,
          };
        case 'RESOLVE_AFTER_DOMAIN':
          return {
            contractVersion: '1' as const,
            result: await resolveReviewCaseAfterDomainSuccess(this.pool, {
              reviewCaseId: id,
              adminUserId: session.adminUserId,
              disposition: 'RESOLVED',
              resolutionNotes: body.note ?? gated.reason,
              domainSucceeded: true,
              actionInvoked: 'ADMIN_API_RESOLVE_AFTER_DOMAIN',
            }),
            ledgerWrite: false,
            note: 'Resolution records queue state only after domain command success elsewhere',
          };
        default:
          // Future domain mutations (fraud mark-safe, monetary unlock, etc.) stay unavailable.
          assertFutureDomainMutationAvailable(String(body.action));
      }
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
