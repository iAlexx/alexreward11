import type { Pool, PoolClient } from 'pg';

import { ControlCenterError } from './errors.js';

type Db = Pool | PoolClient;

export type PublicationStatus = 'PENDING' | 'PUBLISHED' | 'FAILED' | 'SUPERSEDED';

export interface TelegramPublicationRow {
  readonly id: string;
  readonly destinationId: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly messageKind: string;
  readonly status: PublicationStatus;
  readonly telegramMessageId: string | null;
  readonly attempts: number;
}

/**
 * Idempotent publication identity: destination + subject + message_kind.
 * Never call Telegram inside a financial transaction — enqueue PENDING only.
 */
export async function enqueueTelegramPublication(
  db: Db,
  input: {
    readonly destinationId: string;
    readonly subjectType: string;
    readonly subjectId: string;
    readonly messageKind: string;
  },
): Promise<{ readonly publication: TelegramPublicationRow; readonly created: boolean }> {
  const existing = await db.query<{
    id: string;
    destination_id: string;
    subject_type: string;
    subject_id: string;
    message_kind: string;
    status: PublicationStatus;
    telegram_message_id: string | null;
    attempts: number;
  }>(
    `SELECT id, destination_id, subject_type, subject_id, message_kind, status,
            telegram_message_id::text AS telegram_message_id, attempts
     FROM telegram_publications
     WHERE destination_id = $1::uuid
       AND subject_type = $2
       AND subject_id = $3::uuid
       AND message_kind = $4`,
    [input.destinationId, input.subjectType, input.subjectId, input.messageKind],
  );
  if (existing.rows[0] !== undefined) {
    const row = existing.rows[0];
    return {
      created: false,
      publication: {
        id: row.id,
        destinationId: row.destination_id,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        messageKind: row.message_kind,
        status: row.status,
        telegramMessageId: row.telegram_message_id,
        attempts: row.attempts,
      },
    };
  }

  const inserted = await db.query<{
    id: string;
    destination_id: string;
    subject_type: string;
    subject_id: string;
    message_kind: string;
    status: PublicationStatus;
    telegram_message_id: string | null;
    attempts: number;
  }>(
    `INSERT INTO telegram_publications (
       destination_id, subject_type, subject_id, message_kind, status
     ) VALUES ($1::uuid, $2, $3::uuid, $4, 'PENDING')
     ON CONFLICT ON CONSTRAINT telegram_publications_subject_key
     DO UPDATE SET updated_at = telegram_publications.updated_at
     RETURNING id, destination_id, subject_type, subject_id, message_kind, status,
               telegram_message_id::text AS telegram_message_id, attempts`,
    [input.destinationId, input.subjectType, input.subjectId, input.messageKind],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('INTERNAL', undefined, {
      details: { reason: 'PUBLICATION_ENQUEUE_FAILED' },
    });
  }
  return {
    created: true,
    publication: {
      id: row.id,
      destinationId: row.destination_id,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      messageKind: row.message_kind,
      status: row.status,
      telegramMessageId: row.telegram_message_id,
      attempts: row.attempts,
    },
  };
}

export async function markPublicationPublished(
  db: Db,
  publicationId: string,
  telegramMessageId: string,
): Promise<void> {
  await db.query(
    `UPDATE telegram_publications
     SET status = 'PUBLISHED',
         telegram_message_id = $2,
         published_at = now(),
         updated_at = now(),
         last_error_redacted = NULL
     WHERE id = $1::uuid`,
    [publicationId, telegramMessageId],
  );
}

export async function markPublicationFailed(
  db: Db,
  publicationId: string,
  errorRedacted: string,
): Promise<void> {
  await db.query(
    `UPDATE telegram_publications
     SET status = 'FAILED',
         attempts = attempts + 1,
         last_error_redacted = $2,
         updated_at = now()
     WHERE id = $1::uuid`,
    [publicationId, errorRedacted.slice(0, 500)],
  );
}

/** Retry helper: leave PENDING/FAILED retryable without rolling back domain work. */
export async function requeueFailedPublication(db: Db, publicationId: string): Promise<void> {
  await db.query(
    `UPDATE telegram_publications
     SET status = 'PENDING', updated_at = now()
     WHERE id = $1::uuid AND status = 'FAILED'`,
    [publicationId],
  );
}

export async function withPublicationClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
