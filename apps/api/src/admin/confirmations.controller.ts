import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  confirmAdminWebConfirmation,
  prepareAdminWebConfirmation,
  type VerifiedAdminSession,
} from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';

import {
  AdminSessionGuard,
  CurrentAdminSession,
} from '../admin-auth/admin-session.guard.js';
import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  enforceAdminMutationCsrf,
  mapAdminDomainError,
  requireNonEmptyString,
} from './http.js';

/**
 * Server-issued high-impact confirmations (P13-01).
 * Client bindings never authorize — only prepare → confirm → consume.
 */
@Controller('v1/admin/confirmations')
@UseGuards(AdminSessionGuard)
export class ConfirmationsController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Post('prepare')
  @HttpCode(200)
  async prepare(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body()
    body: {
      readonly actionType?: unknown;
      readonly resourceType?: unknown;
      readonly resourceId?: unknown;
      readonly expectedVersion?: unknown;
      readonly payload?: unknown;
    },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const prepared = await prepareAdminWebConfirmation(this.pool, {
        session,
        actionType: requireNonEmptyString(body.actionType, 'actionType'),
        resourceType: requireNonEmptyString(body.resourceType, 'resourceType'),
        resourceId: requireNonEmptyString(body.resourceId, 'resourceId'),
        expectedVersion: requireNonEmptyString(body.expectedVersion, 'expectedVersion'),
        payload: body.payload ?? {},
      });
      return {
        contractVersion: '1' as const,
        confirmationId: prepared.confirmationId,
        expiresAt: prepared.expiresAt,
        payloadDigest: prepared.payloadDigest,
        confirmationPhrase: prepared.confirmationPhrase,
        actionType: prepared.actionType,
        resourceType: prepared.resourceType,
        resourceId: prepared.resourceId,
        expectedVersion: prepared.expectedVersion,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post(':id/confirm')
  @HttpCode(200)
  async confirm(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { readonly confirmationPhrase?: unknown },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const confirmed = await confirmAdminWebConfirmation(this.pool, {
        session,
        confirmationId: id,
        confirmationPhrase: requireNonEmptyString(
          body.confirmationPhrase,
          'confirmationPhrase',
        ),
      });
      return {
        contractVersion: '1' as const,
        confirmationId: confirmed.confirmationId,
        confirmedAt: confirmed.confirmedAt,
        expiresAt: confirmed.expiresAt,
        payloadDigest: confirmed.payloadDigest,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
