/**
 * Phase 12 remediation P12-03 — support ownership + deletion request idempotence.
 *
 * Opt-in destructive: PHASE12_SUPPORT_DATABASE_URL, or PHASE12_SUPPORT_TESTS=1 + DATABASE_URL.
 */
import { ACCOUNT_DELETION_REQUEST_CATEGORY } from '@alex-rewards/contracts';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createSupportTicket,
  getOwnSupportTicket,
  listOwnSupportTickets,
  postOwnSupportMessage,
  requestAccountDeletion,
  SupportDomainError,
} from '../src/index.js';
import { createTestUser, phase12SupportDatabaseUrl, resetAndMigrate } from './harness.js';

describe.skipIf(phase12SupportDatabaseUrl === '')('Phase 12 support domain', () => {
  let pool: Pool;
  let userA: string;
  let userB: string;

  beforeAll(async () => {
    await resetAndMigrate(phase12SupportDatabaseUrl);
    pool = new Pool({ connectionString: phase12SupportDatabaseUrl });
    userA = await createTestUser(pool, '912120300001');
    userB = await createTestUser(pool, '912120300002');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it('isolates ticket ownership across users', async () => {
    const created = await createSupportTicket(pool, {
      userId: userA,
      request: { subject: 'Help with wallet', category: 'WALLET', body: 'Cannot bind wallet' },
    });
    expect(created.created).toBe(true);
    expect(created.ticket.category).toBe('WALLET');

    const ownList = await listOwnSupportTickets(pool, { userId: userA });
    expect(ownList.tickets.some((t) => t.id === created.ticket.id)).toBe(true);

    const otherList = await listOwnSupportTickets(pool, { userId: userB });
    expect(otherList.tickets.some((t) => t.id === created.ticket.id)).toBe(false);

    await expect(
      getOwnSupportTicket(pool, { userId: userB, ticketId: created.ticket.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<SupportDomainError>);

    await expect(
      postOwnSupportMessage(pool, {
        userId: userB,
        ticketId: created.ticket.id,
        body: 'intrusion attempt',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const message = await postOwnSupportMessage(pool, {
      userId: userA,
      ticketId: created.ticket.id,
      body: 'Additional detail from owner',
    });
    expect(message.message.authorType).toBe('USER');
    expect(message.message.body).toBe('Additional detail from owner');

    const detail = await getOwnSupportTicket(pool, {
      userId: userA,
      ticketId: created.ticket.id,
    });
    expect(detail.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('creates an idempotent account deletion request without mutating balances', async () => {
    const first = await requestAccountDeletion(pool, { userId: userA, confirmed: true });
    expect(first.created).toBe(true);
    expect(first.ticket.category).toBe(ACCOUNT_DELETION_REQUEST_CATEGORY);
    expect(first.ticket.state).toBe('OPEN');

    const second = await requestAccountDeletion(pool, { userId: userA, confirmed: true });
    expect(second.created).toBe(false);
    expect(second.ticket.id).toBe(first.ticket.id);
    expect(second.ticket.publicId).toBe(first.ticket.publicId);

    const events = await pool.query<{ event_type: string; count: string }>(
      `SELECT event_type, count(*)::text AS count
       FROM support_events
       WHERE support_ticket_id = $1::uuid
         AND event_type = 'ACCOUNT_DELETION_REQUESTED'
       GROUP BY event_type`,
      [first.ticket.id],
    );
    expect(events.rows[0]?.count).toBe('1');

    // No anonymization / balance mutation path exists on this request surface.
    const user = await pool.query<{ status: string; anonymized_at: Date | null }>(
      `SELECT status::text AS status, anonymized_at FROM users WHERE id = $1::uuid`,
      [userA],
    );
    expect(user.rows[0]?.status).not.toBe('DELETED_ANONYMIZED');
    expect(user.rows[0]?.anonymized_at).toBeNull();

    await expect(
      requestAccountDeletion(pool, { userId: userA, confirmed: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
