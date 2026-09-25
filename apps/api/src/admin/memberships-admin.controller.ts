import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  getFounderHistory,
  grantFounderMembership,
  issueFounderClaimCode,
  searchFounderMember,
  type VerifiedAdminSession,
} from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type {
  AdminFounderGrantRequest,
  AdminFounderGrantResponse,
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
  requireNonEmptyString,
} from './http.js';

@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class MembershipsAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('memberships/plans')
  async plans() {
    try {
      const rows = await this.pool.query(
        `SELECT id, code, name, status::text AS status,
                price_currency, price_decimals, price_atomic::text AS price_atomic
         FROM membership_plans
         ORDER BY code`,
      );
      return { contractVersion: '1' as const, items: rows.rows };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('memberships/founders/search')
  async searchFounders(
    @Query('founderNumber') founderNumber?: string,
    @Query('userId') userId?: string,
    @Query('telegramUserId') telegramUserId?: string,
    @Query('membershipId') membershipId?: string,
  ) {
    try {
      const result = await searchFounderMember(this.pool, {
        ...(founderNumber !== undefined ? { founderNumber: Number(founderNumber) } : {}),
        ...(userId !== undefined ? { userId } : {}),
        ...(telegramUserId !== undefined ? { telegramUserId } : {}),
        ...(membershipId !== undefined ? { membershipId } : {}),
      });
      return { contractVersion: '1' as const, result };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('memberships/founders/history')
  async history(
    @Query('userId') userId?: string,
    @Query('founderNumber') founderNumber?: string,
  ) {
    try {
      const result = await getFounderHistory(this.pool, {
        ...(userId !== undefined ? { userId } : {}),
        ...(founderNumber !== undefined ? { founderNumber: Number(founderNumber) } : {}),
      });
      return { contractVersion: '1' as const, result };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  /**
   * Founder grant — membership only. Zero ledger postings. Zero money.
   */
  @Post('memberships/founders/grant')
  @HttpCode(200)
  async grantFounder(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body() body: AdminFounderGrantRequest,
  ): Promise<AdminFounderGrantResponse> {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const targetUserId = requireNonEmptyString(body.targetUserId, 'targetUserId');
      const paymentReferenceRedacted = requireNonEmptyString(
        body.paymentReferenceRedacted,
        'paymentReferenceRedacted',
      );
      await assertOptionalConfirmation(body.confirmation, {
        action: 'memberships.founder_grant',
        resourceType: 'user',
        resourceId: targetUserId,
        expectedVersion: gated.expectedVersion,
        payload: { targetUserId, reason: gated.reason },
      });

      const granted = await grantFounderMembership(this.pool, {
        adminUserId: session.adminUserId,
        userId: targetUserId,
        reason: gated.reason,
        paymentReferenceRedacted,
        actorSource: 'WEB',
        ...(body.idempotencyKey !== undefined ? { idempotencyKey: body.idempotencyKey } : {}),
      });

      return {
        contractVersion: '1',
        membershipId: granted.membershipId,
        founderNumber: granted.founderNumber,
        planCode: granted.planCode,
        moneyIssued: false,
        ledgerPostingsCreated: false,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  /** Issue claim code — plaintext shown once in this response only. */
  @Post('memberships/claim-codes/issue')
  @HttpCode(200)
  async issueClaimCode(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Body()
    body: {
      readonly reason: string;
      readonly expectedVersion: string;
      readonly expiresAt?: string;
      readonly issuedForReference?: string;
      readonly reserveFounderNumber?: boolean;
    },
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const issued = await issueFounderClaimCode(this.pool, {
        adminUserId: session.adminUserId,
        actorSource: 'WEB',
        ...(body.expiresAt !== undefined ? { expiresAt: new Date(body.expiresAt) } : {}),
        ...(body.issuedForReference !== undefined
          ? { issuedForReference: body.issuedForReference }
          : {}),
        ...(body.reserveFounderNumber !== undefined
          ? { reserveFounderNumber: body.reserveFounderNumber }
          : {}),
      });
      return {
        contractVersion: '1' as const,
        claimCodeId: issued.claimCodeId,
        /** One-time display — never logged or re-fetched. */
        plaintextCode: issued.rawCode,
        expiresAt: issued.expiresAt,
        reservedFounderNumber: issued.founderNumberReserved,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
