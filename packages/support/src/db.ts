import type {
  SupportMessageDto,
  SupportTicketDetailDto,
  SupportTicketStateDto,
  SupportTicketSummaryDto,
} from '@alex-rewards/contracts';
import type { Pool, PoolClient } from 'pg';

import { SupportDomainError } from './errors.js';

export type SupportDb = Pool | PoolClient;

const OPEN_TICKET_STATES = ['OPEN', 'WAITING_USER', 'WAITING_SUPPORT'] as const;

const MAX_SUBJECT_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 4_000;

export interface TicketRow {
  readonly id: string;
  readonly public_id: string;
  readonly subject: string;
  readonly category: string | null;
  readonly state: SupportTicketStateDto;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly last_message_at: Date | null;
}

export function mapTicketSummary(row: TicketRow): SupportTicketSummaryDto {
  return {
    id: row.id,
    publicId: row.public_id,
    subject: row.subject,
    category: row.category,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
  };
}

export function requireNonEmptyUserId(userId: string): string {
  const trimmed = userId.trim();
  if (trimmed === '') {
    throw new SupportDomainError('UNAUTHORIZED', 'Authentication required');
  }
  return trimmed;
}

export function normalizeSubject(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SupportDomainError('VALIDATION', 'Invalid subject');
  }
  const subject = raw.trim();
  if (subject === '' || subject.length > MAX_SUBJECT_LENGTH) {
    throw new SupportDomainError('VALIDATION', 'Invalid subject');
  }
  return subject;
}

export function normalizeOptionalCategory(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new SupportDomainError('VALIDATION', 'Invalid category');
  }
  const category = raw.trim();
  if (category === '') return null;
  if (category.length > MAX_CATEGORY_LENGTH) {
    throw new SupportDomainError('VALIDATION', 'Invalid category');
  }
  return category;
}

export function normalizeMessageBody(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SupportDomainError('VALIDATION', 'Invalid message body');
  }
  const body = raw.trim();
  if (body === '' || body.length > MAX_MESSAGE_LENGTH) {
    throw new SupportDomainError('VALIDATION', 'Invalid message body');
  }
  return body;
}

export function isOpenTicketState(state: string): boolean {
  return (OPEN_TICKET_STATES as readonly string[]).includes(state);
}

export async function insertSupportEvent(
  db: SupportDb,
  input: {
    readonly ticketId: string;
    readonly eventType: string;
    readonly actorUserId: string | null;
    readonly fromState?: SupportTicketStateDto | null;
    readonly toState?: SupportTicketStateDto | null;
    readonly details?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO support_events (
       support_ticket_id, event_type, actor_type, actor_user_id,
       from_state, to_state, details
     ) VALUES (
       $1::uuid, $2, 'USER', $3::uuid,
       $4::support_ticket_state, $5::support_ticket_state, $6::jsonb
     )`,
    [
      input.ticketId,
      input.eventType,
      input.actorUserId,
      input.fromState ?? null,
      input.toState ?? null,
      JSON.stringify(input.details ?? {}),
    ],
  );
}

export async function insertUserMessage(
  db: SupportDb,
  input: { readonly ticketId: string; readonly userId: string; readonly body: string },
): Promise<SupportMessageDto> {
  const result = await db.query<{
    id: string;
    author_type: 'USER';
    body: string;
    created_at: Date;
  }>(
    `INSERT INTO support_messages (
       support_ticket_id, author_type, author_user_id, body, is_internal_note
     ) VALUES ($1::uuid, 'USER', $2::uuid, $3, false)
     RETURNING id, author_type::text AS author_type, body, created_at`,
    [input.ticketId, input.userId, input.body],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SupportDomainError('INTERNAL', 'Failed to store support message');
  }
  await db.query(
    `UPDATE support_tickets
     SET last_message_at = $2
     WHERE id = $1::uuid`,
    [input.ticketId, row.created_at],
  );
  return {
    id: row.id,
    authorType: row.author_type,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

export async function loadOwnedTicket(
  db: SupportDb,
  input: { readonly userId: string; readonly ticketId: string },
): Promise<TicketRow> {
  const result = await db.query<TicketRow>(
    `SELECT id, public_id, subject, category, state::text AS state,
            created_at, updated_at, last_message_at
     FROM support_tickets
     WHERE id = $1::uuid AND user_id = $2::uuid`,
    [input.ticketId, input.userId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SupportDomainError('NOT_FOUND', 'Support ticket was not found');
  }
  return row;
}

export async function loadTicketMessages(
  db: SupportDb,
  ticketId: string,
): Promise<readonly SupportMessageDto[]> {
  const result = await db.query<{
    id: string;
    author_type: SupportMessageDto['authorType'];
    body: string;
    created_at: Date;
  }>(
    `SELECT id, author_type::text AS author_type, body, created_at
     FROM support_messages
     WHERE support_ticket_id = $1::uuid
       AND is_internal_note = false
     ORDER BY created_at ASC`,
    [ticketId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    authorType: row.author_type,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function toTicketDetail(
  db: SupportDb,
  row: TicketRow,
): Promise<SupportTicketDetailDto> {
  return {
    ...mapTicketSummary(row),
    messages: await loadTicketMessages(db, row.id),
  };
}
