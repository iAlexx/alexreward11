import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { VerifiedAdminSession } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type {
  AdminWithdrawalDecisionRequest,
  AdminWithdrawalsListResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import {
  decideWithdrawal,
  getWithdrawal,
  withdrawalEngineConfigFromValidatedApi,
  type WithdrawalState,
} from '@alex-rewards/withdrawals';

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
  requireNonEmptyString,
} from './http.js';

@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class WithdrawalsAdminController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private engineConfig() {
    return withdrawalEngineConfigFromValidatedApi({
      DEPLOYMENT_ENV: this.config.DEPLOYMENT_ENV,
      WITHDRAWAL_QUOTE_TTL_SECONDS: this.config.WITHDRAWAL_QUOTE_TTL_SECONDS,
      WITHDRAWAL_RISK_POLICY_VERSION: this.config.WITHDRAWAL_RISK_POLICY_VERSION,
      WITHDRAWAL_NETWORK_CODE: this.config.WITHDRAWAL_NETWORK_CODE,
      WITHDRAWAL_ASSET_SYMBOL: this.config.WITHDRAWAL_ASSET_SYMBOL,
      WITHDRAWAL_FAKE_CHAIN_ENABLED: this.config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
    });
  }

  @Get('withdrawals')
  async list(
    @Query('page', new ParseIntPipe({ optional: true })) pageRaw?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSizeRaw?: number,
  ): Promise<AdminWithdrawalsListResponse> {
    try {
      const page = Math.max(1, pageRaw ?? 1);
      const pageSize = Math.min(100, Math.max(1, pageSizeRaw ?? 25));
      const offset = (page - 1) * pageSize;
      const rows = await this.pool.query<{
        id: string;
        public_id: string;
        user_id: string;
        state: string;
        requested_amount_atomic: string;
        fee_amount_atomic: string;
        net_amount_atomic: string;
        requested_at: Date;
      }>(
        `SELECT id, public_id, user_id, state::text AS state,
                requested_amount_atomic::text AS requested_amount_atomic,
                fee_amount_atomic::text AS fee_amount_atomic,
                net_amount_atomic::text AS net_amount_atomic,
                requested_at
         FROM withdrawals
         ORDER BY requested_at DESC
         LIMIT $1 OFFSET $2`,
        [pageSize, offset],
      );
      return {
        contractVersion: '1',
        items: rows.rows.map((row) => ({
          id: row.id,
          publicId: row.public_id,
          userId: row.user_id,
          state: row.state,
          requestedAmountAtomic: row.requested_amount_atomic,
          feeAmountAtomic: row.fee_amount_atomic,
          netAmountAtomic: row.net_amount_atomic,
          requestedAt: row.requested_at.toISOString(),
        })),
        page,
        pageSize,
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Get('withdrawals/:id')
  async detail(@Param('id', ParseUuidPipe) id: string) {
    try {
      const view = await getWithdrawal(this.pool, { withdrawalId: id });
      return { contractVersion: '1' as const, withdrawal: view };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }

  @Post('withdrawals/:id/approve')
  @HttpCode(200)
  async approve(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('id', ParseUuidPipe) id: string,
    @Body() body: AdminWithdrawalDecisionRequest,
  ) {
    return this.decide(request, session, id, { ...body, decision: 'APPROVE' });
  }

  @Post('withdrawals/:id/hold')
  @HttpCode(200)
  async hold(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('id', ParseUuidPipe) id: string,
    @Body() body: AdminWithdrawalDecisionRequest,
  ) {
    return this.decide(request, session, id, { ...body, decision: 'HOLD' });
  }

  @Post('withdrawals/:id/reject')
  @HttpCode(200)
  async reject(
    @Req() request: FastifyRequest,
    @CurrentAdminSession() session: VerifiedAdminSession,
    @Param('id', ParseUuidPipe) id: string,
    @Body() body: AdminWithdrawalDecisionRequest,
  ) {
    return this.decide(request, session, id, { ...body, decision: 'REJECT' });
  }

  private async decide(
    request: FastifyRequest,
    session: VerifiedAdminSession,
    id: string,
    body: AdminWithdrawalDecisionRequest,
  ) {
    try {
      enforceAdminMutationCsrf(request, this.config);
      const gated = gateHighImpactMutation(session, body);
      const expectedState = requireNonEmptyString(body.expectedState, 'expectedState');
      const idempotencyKey = requireNonEmptyString(body.idempotencyKey, 'idempotencyKey');
      await assertOptionalConfirmation(body.confirmation, {
        action: `withdrawal.${body.decision.toLowerCase()}`,
        resourceType: 'withdrawal',
        resourceId: id,
        expectedVersion: gated.expectedVersion,
        payload: {
          decision: body.decision,
          expectedState,
          reason: gated.reason,
        },
      });

      const result = await decideWithdrawal(this.pool, this.engineConfig(), {
        withdrawalId: id,
        expectedState: expectedState as WithdrawalState,
        decision: body.decision,
        reason: gated.reason,
        idempotencyKey,
        trustedOwnerActorContext: { adminUserId: session.adminUserId },
        decisionSource: 'WEB',
      });
      return { contractVersion: '1' as const, result };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
