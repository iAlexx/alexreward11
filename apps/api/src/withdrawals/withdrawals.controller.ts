import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { ApiConfig } from '@alex-rewards/config';
import type { Pool } from '@alex-rewards/db';
import {
  cancelWithdrawalQuote,
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  withdrawalEngineConfigFromValidatedApi,
  type WithdrawalEngineConfig,
  type WithdrawalView,
} from '@alex-rewards/withdrawals';

import { API_CONFIG, DATABASE_POOL } from '../tokens.js';
import {
  AccessSessionGuard,
  CurrentAuthUser,
  ParseUuidPipe,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { requireString } from '../auth/http.js';
import { mapWithdrawalError, withdrawalNotFound } from './http.js';

function resolveWithdrawalEngineConfig(config: ApiConfig): WithdrawalEngineConfig {
  return withdrawalEngineConfigFromValidatedApi({
    DEPLOYMENT_ENV: config.DEPLOYMENT_ENV,
    WITHDRAWAL_QUOTE_TTL_SECONDS: config.WITHDRAWAL_QUOTE_TTL_SECONDS,
    WITHDRAWAL_RISK_POLICY_VERSION: config.WITHDRAWAL_RISK_POLICY_VERSION,
    WITHDRAWAL_NETWORK_CODE: config.WITHDRAWAL_NETWORK_CODE,
    WITHDRAWAL_ASSET_SYMBOL: config.WITHDRAWAL_ASSET_SYMBOL,
    WITHDRAWAL_FAKE_CHAIN_ENABLED: config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
  });
}

function mapWithdrawalRow(row: {
  id: string;
  public_id: string;
  user_id: string;
  withdrawal_quote_id: string;
  state: WithdrawalView['state'];
  requested_amount_atomic: string;
  fee_amount_atomic: string;
  net_amount_atomic: string;
  priority_review: boolean;
  risk_decision: string | null;
  workflow_id: string | null;
}): WithdrawalView {
  return {
    id: row.id,
    publicId: row.public_id,
    userId: row.user_id,
    quoteId: row.withdrawal_quote_id,
    state: row.state,
    requestedAmountAtomic: row.requested_amount_atomic,
    feeAmountAtomic: row.fee_amount_atomic,
    netAmountAtomic: row.net_amount_atomic,
    priorityReview: row.priority_review,
    riskDecision: row.risk_decision,
    workflowId: row.workflow_id,
  };
}

const USER_WITHDRAWAL_SELECT = `id, public_id, user_id, withdrawal_quote_id, state,
  requested_amount_atomic::text AS requested_amount_atomic,
  fee_amount_atomic::text AS fee_amount_atomic,
  net_amount_atomic::text AS net_amount_atomic,
  priority_review, risk_decision::text AS risk_decision, workflow_id`;

@Controller('v1')
@UseGuards(AccessSessionGuard)
export class WithdrawalsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  private engineConfig(): WithdrawalEngineConfig {
    return resolveWithdrawalEngineConfig(this.config);
  }

  @Post('withdrawals/quote')
  @HttpCode(200)
  async createQuote(@CurrentAuthUser() auth: AuthenticatedRequestUser, @Body() body: unknown) {
    const amountAtomic = requireString(body, 'amountAtomic');
    try {
      return await createWithdrawalQuote(this.pool, this.engineConfig(), {
        authenticatedUserId: auth.userId,
        amountAtomic,
      });
    } catch (error) {
      throw mapWithdrawalError(error);
    }
  }

  @Post('withdrawal-quotes/:id/cancel')
  @HttpCode(200)
  async cancelQuote(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    try {
      return await cancelWithdrawalQuote(this.pool, this.engineConfig(), {
        authenticatedUserId: auth.userId,
        quoteId: id,
      });
    } catch (error) {
      throw mapWithdrawalError(error);
    }
  }

  @Post('withdrawals')
  @HttpCode(200)
  async createWithdrawal(@CurrentAuthUser() auth: AuthenticatedRequestUser, @Body() body: unknown) {
    const quoteId = requireString(body, 'quoteId');
    const idempotencyKey = requireString(body, 'idempotencyKey');
    try {
      return await createWithdrawalFromQuote(this.pool, this.engineConfig(), {
        authenticatedUserId: auth.userId,
        quoteId,
        idempotencyKey,
      });
    } catch (error) {
      throw mapWithdrawalError(error);
    }
  }

  @Get('withdrawals')
  async listWithdrawals(@CurrentAuthUser() auth: AuthenticatedRequestUser) {
    try {
      const result = await this.pool.query<{
        id: string;
        public_id: string;
        user_id: string;
        withdrawal_quote_id: string;
        state: WithdrawalView['state'];
        requested_amount_atomic: string;
        fee_amount_atomic: string;
        net_amount_atomic: string;
        priority_review: boolean;
        risk_decision: string | null;
        workflow_id: string | null;
      }>(
        `SELECT ${USER_WITHDRAWAL_SELECT}
         FROM withdrawals
         WHERE user_id = $1::uuid
         ORDER BY requested_at DESC`,
        [auth.userId],
      );
      return { withdrawals: result.rows.map(mapWithdrawalRow) };
    } catch (error) {
      throw mapWithdrawalError(error);
    }
  }

  @Get('withdrawals/:id')
  async getWithdrawal(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('id', ParseUuidPipe) id: string,
  ) {
    try {
      const result = await this.pool.query<{
        id: string;
        public_id: string;
        user_id: string;
        withdrawal_quote_id: string;
        state: WithdrawalView['state'];
        requested_amount_atomic: string;
        fee_amount_atomic: string;
        net_amount_atomic: string;
        priority_review: boolean;
        risk_decision: string | null;
        workflow_id: string | null;
      }>(
        `SELECT ${USER_WITHDRAWAL_SELECT}
         FROM withdrawals
         WHERE id = $1::uuid AND user_id = $2::uuid`,
        [id, auth.userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw withdrawalNotFound();
      }
      return mapWithdrawalRow(row);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof HttpException) {
        throw error;
      }
      throw mapWithdrawalError(error);
    }
  }
}
