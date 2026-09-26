import { Body, Controller, Get, Inject, Param, Post, UseGuards } from '@nestjs/common';

import type {
  AccountDeletionRequestResponse,
  CreateSupportTicketRequest,
  CreateSupportTicketResponse,
  PostSupportMessageRequest,
  PostSupportMessageResponse,
  SupportTicketDetailDto,
  SupportTicketsListResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import {
  createSupportTicket,
  getOwnSupportTicket,
  listOwnSupportTickets,
  postOwnSupportMessage,
  requestAccountDeletion,
} from '@alex-rewards/support';

import {
  AccessSessionGuard,
  CurrentAuthUser,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';

import { mapSupportError, requireObjectBody } from './http.js';

/**
 * Authenticated user support surface (Phase 12 remediation P12-03).
 *
 * Ownership isolation only. Account deletion is a review request ticket + append-only event —
 * never anonymization, balance mutation, or ledger/audit deletion.
 */
@Controller('v1/support')
@UseGuards(AccessSessionGuard)
export class SupportController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Post('tickets')
  async createTicket(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Body() body: unknown,
  ): Promise<CreateSupportTicketResponse> {
    try {
      const request = parseCreateTicketBody(body);
      return await createSupportTicket(this.pool, { userId: auth.userId, request });
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  @Get('tickets')
  async listTickets(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<SupportTicketsListResponse> {
    try {
      return await listOwnSupportTickets(this.pool, { userId: auth.userId });
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  @Get('tickets/:id')
  async getTicket(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('id') ticketId: string,
  ): Promise<SupportTicketDetailDto> {
    try {
      return await getOwnSupportTicket(this.pool, { userId: auth.userId, ticketId });
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  @Post('tickets/:id/messages')
  async postMessage(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Param('id') ticketId: string,
    @Body() body: unknown,
  ): Promise<PostSupportMessageResponse> {
    try {
      const parsed = parsePostMessageBody(body);
      return await postOwnSupportMessage(this.pool, {
        userId: auth.userId,
        ticketId,
        body: parsed.body,
      });
    } catch (error) {
      throw mapSupportError(error);
    }
  }

  @Post('account-deletion-requests')
  async requestDeletion(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Body() body: unknown,
  ): Promise<AccountDeletionRequestResponse> {
    try {
      const confirmed = parseDeletionConfirmation(body);
      return await requestAccountDeletion(this.pool, {
        userId: auth.userId,
        confirmed,
      });
    } catch (error) {
      throw mapSupportError(error);
    }
  }
}

function parseCreateTicketBody(body: unknown): CreateSupportTicketRequest {
  const source = requireObjectBody(body);
  const request: CreateSupportTicketRequest = {
    subject: typeof source['subject'] === 'string' ? source['subject'] : '',
  };
  const category = source['category'];
  const messageBody = source['body'];
  return {
    ...request,
    ...(typeof category === 'string' || category === null ? { category } : {}),
    ...(typeof messageBody === 'string' ? { body: messageBody } : {}),
  };
}

function parsePostMessageBody(body: unknown): PostSupportMessageRequest {
  const source = requireObjectBody(body);
  return { body: typeof source['body'] === 'string' ? source['body'] : '' };
}

function parseDeletionConfirmation(body: unknown): boolean {
  const source = requireObjectBody(body);
  return source['confirmed'] === true;
}
