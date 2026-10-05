import {
  ACCOUNT_DELETION_REQUEST_CATEGORY,
  type AccountDeletionRequestResponse,
} from '@alex-rewards/contracts';
import type { Pool } from 'pg';

import {
  insertSupportEvent,
  isOpenTicketState,
  mapTicketSummary,
  requireNonEmptyUserId,
  type TicketRow,
} from './db.js';
import { SupportDomainError } from './errors.js';

const DELETION_SUBJECT = 'Account deletion request';

/**
 * Idempotent account deletion *request* for review.
 *
 * Creates a support ticket with category ACCOUNT_DELETION_REQUEST and an append-only
 * support_event. Does not anonymize the user, mutate balances, or delete ledger/audit rows.
 * A duplicate open request returns the existing ticket.
 */
export async function requestAccountDeletion(
  pool: Pool,
  input: {
    readonly userId: string;
    /** Confirmation ceremony: must be exactly `true`. */
    readonly confirmed: unknown;
  },
): Promise<AccountDeletionRequestResponse> {
  const userId = requireNonEmptyUserId(input.userId);
  if (input.confirmed !== true) {
    throw new SupportDomainError(
      'VALIDATION',
      'Account deletion request requires explicit confirmation',
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialize concurrent deletion requests for the same user.
    await client.query(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [userId]);

    const existing = await client.query<TicketRow>(
      `SELECT id, public_id, subject, category, state::text AS state,
              created_at, updated_at, last_message_at
       FROM support_tickets
       WHERE user_id = $1::uuid
         AND category = $2
         AND state IN ('OPEN', 'WAITING_USER', 'WAITING_SUPPORT')
       ORDER BY created_at ASC
       LIMIT 1`,
      [userId, ACCOUNT_DELETION_REQUEST_CATEGORY],
    );
    const openTicket = existing.rows[0];
    if (openTicket !== undefined && isOpenTicketState(openTicket.state)) {
      await client.query('COMMIT');
      return { ticket: mapTicketSummary(openTicket), created: false };
    }

    const inserted = await client.query<TicketRow>(
      `INSERT INTO support_tickets (user_id, subject, category, state, priority)
       VALUES ($1::uuid, $2, $3, 'OPEN', 'NORMAL')
       RETURNING id, public_id, subject, category, state::text AS state,
                 created_at, updated_at, last_message_at`,
      [userId, DELETION_SUBJECT, ACCOUNT_DELETION_REQUEST_CATEGORY],
    );
    const ticket = inserted.rows[0];
    if (ticket === undefined) {
      throw new SupportDomainError('INTERNAL', 'Failed to create deletion request');
    }

    await insertSupportEvent(client, {
      ticketId: ticket.id,
      eventType: 'ACCOUNT_DELETION_REQUESTED',
      actorUserId: userId,
      fromState: null,
      toState: 'OPEN',
      details: {
        category: ACCOUNT_DELETION_REQUEST_CATEGORY,
        // Request for review only — no anonymization or balance mutation.
        reviewOnly: true,
      },
    });

    await client.query('COMMIT');
    return { ticket: mapTicketSummary(ticket), created: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error instanceof SupportDomainError) throw error;
    throw new SupportDomainError('INTERNAL', 'Failed to create deletion request', { cause: error });
  } finally {
    client.release();
  }
}
