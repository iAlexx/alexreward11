import type {
  CreateSupportTicketRequest,
  CreateSupportTicketResponse,
  PostSupportMessageResponse,
  SupportTicketDetailDto,
  SupportTicketsListResponse,
} from '@alex-rewards/contracts';
import type { Pool } from 'pg';

import {
  insertSupportEvent,
  insertUserMessage,
  loadOwnedTicket,
  mapTicketSummary,
  normalizeMessageBody,
  normalizeOptionalCategory,
  normalizeSubject,
  requireNonEmptyUserId,
  toTicketDetail,
  type TicketRow,
} from './db.js';
import { SupportDomainError } from './errors.js';

export async function createSupportTicket(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly request: CreateSupportTicketRequest;
  },
): Promise<CreateSupportTicketResponse> {
  const userId = requireNonEmptyUserId(input.userId);
  const subject = normalizeSubject(input.request.subject);
  const category = normalizeOptionalCategory(input.request.category);
  const openingBody =
    input.request.body === undefined || input.request.body === null || input.request.body === ''
      ? null
      : normalizeMessageBody(input.request.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<TicketRow>(
      `INSERT INTO support_tickets (user_id, subject, category, state)
       VALUES ($1::uuid, $2, $3, 'OPEN')
       RETURNING id, public_id, subject, category, state::text AS state,
                 created_at, updated_at, last_message_at`,
      [userId, subject, category],
    );
    const ticket = inserted.rows[0];
    if (ticket === undefined) {
      throw new SupportDomainError('INTERNAL', 'Failed to create support ticket');
    }

    await insertSupportEvent(client, {
      ticketId: ticket.id,
      eventType: 'TICKET_CREATED',
      actorUserId: userId,
      fromState: null,
      toState: 'OPEN',
      details: { category },
    });

    if (openingBody !== null) {
      await insertUserMessage(client, {
        ticketId: ticket.id,
        userId,
        body: openingBody,
      });
      await insertSupportEvent(client, {
        ticketId: ticket.id,
        eventType: 'USER_MESSAGE_POSTED',
        actorUserId: userId,
        details: { opening: true },
      });
    }

    await client.query('COMMIT');
    const refreshed = await loadOwnedTicket(pool, { userId, ticketId: ticket.id });
    return { ticket: mapTicketSummary(refreshed), created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof SupportDomainError) throw error;
    throw new SupportDomainError('INTERNAL', 'Failed to create support ticket', { cause: error });
  } finally {
    client.release();
  }
}

export async function listOwnSupportTickets(
  pool: Pool,
  input: { readonly userId: string },
): Promise<SupportTicketsListResponse> {
  const userId = requireNonEmptyUserId(input.userId);
  const result = await pool.query<TicketRow>(
    `SELECT id, public_id, subject, category, state::text AS state,
            created_at, updated_at, last_message_at
     FROM support_tickets
     WHERE user_id = $1::uuid
     ORDER BY created_at DESC`,
    [userId],
  );
  return { tickets: result.rows.map(mapTicketSummary) };
}

export async function getOwnSupportTicket(
  pool: Pool,
  input: { readonly userId: string; readonly ticketId: string },
): Promise<SupportTicketDetailDto> {
  const userId = requireNonEmptyUserId(input.userId);
  const ticketId = input.ticketId.trim();
  if (ticketId === '') {
    throw new SupportDomainError('VALIDATION', 'Invalid ticket id');
  }
  const row = await loadOwnedTicket(pool, { userId, ticketId });
  return toTicketDetail(pool, row);
}

export async function postOwnSupportMessage(
  pool: Pool,
  input: {
    readonly userId: string;
    readonly ticketId: string;
    readonly body: unknown;
  },
): Promise<PostSupportMessageResponse> {
  const userId = requireNonEmptyUserId(input.userId);
  const ticketId = input.ticketId.trim();
  if (ticketId === '') {
    throw new SupportDomainError('VALIDATION', 'Invalid ticket id');
  }
  const body = normalizeMessageBody(input.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ticket = await loadOwnedTicket(client, { userId, ticketId });
    if (ticket.state === 'CLOSED' || ticket.state === 'RESOLVED') {
      throw new SupportDomainError('CONFLICT', 'Support ticket is closed');
    }
    const message = await insertUserMessage(client, { ticketId, userId, body });
    await insertSupportEvent(client, {
      ticketId,
      eventType: 'USER_MESSAGE_POSTED',
      actorUserId: userId,
    });
    await client.query('COMMIT');
    return { message };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof SupportDomainError) throw error;
    throw new SupportDomainError('INTERNAL', 'Failed to post support message', { cause: error });
  } finally {
    client.release();
  }
}
