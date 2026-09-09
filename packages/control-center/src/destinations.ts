import type { Pool, PoolClient } from 'pg';

import { ControlCenterError } from './errors.js';
import type {
  ControlCenterDestinationPurpose,
  ControlCenterEnvironment,
  TelegramDestinationRow,
} from './types.js';

type Db = Pool | PoolClient;

function mapDestination(row: {
  id: string;
  environment: ControlCenterEnvironment;
  purpose: ControlCenterDestinationPurpose;
  chat_id: string;
  topic_thread_id: string | null;
  title: string | null;
  enabled: boolean;
}): TelegramDestinationRow {
  return {
    id: row.id,
    environment: row.environment,
    purpose: row.purpose,
    chatId: row.chat_id,
    topicThreadId: row.topic_thread_id,
    title: row.title,
    enabled: row.enabled,
  };
}

export async function resolveDestination(
  db: Db,
  input: {
    readonly environment: ControlCenterEnvironment;
    readonly purpose: ControlCenterDestinationPurpose;
  },
): Promise<TelegramDestinationRow> {
  const result = await db.query<{
    id: string;
    environment: ControlCenterEnvironment;
    purpose: ControlCenterDestinationPurpose;
    chat_id: string;
    topic_thread_id: string | null;
    title: string | null;
    enabled: boolean;
  }>(
    `SELECT id, environment, purpose, chat_id::text AS chat_id,
            topic_thread_id::text AS topic_thread_id, title, enabled
     FROM telegram_destinations
     WHERE environment = $1::environment_name
       AND purpose = $2::telegram_destination_purpose
     ORDER BY enabled DESC, created_at ASC
     LIMIT 1`,
    [input.environment, input.purpose],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'DESTINATION_NOT_FOUND', purpose: input.purpose },
    });
  }
  return mapDestination(row);
}

export async function getDestinationById(
  db: Db,
  destinationId: string,
): Promise<TelegramDestinationRow> {
  const result = await db.query<{
    id: string;
    environment: ControlCenterEnvironment;
    purpose: ControlCenterDestinationPurpose;
    chat_id: string;
    topic_thread_id: string | null;
    title: string | null;
    enabled: boolean;
  }>(
    `SELECT id, environment, purpose, chat_id::text AS chat_id,
            topic_thread_id::text AS topic_thread_id, title, enabled
     FROM telegram_destinations WHERE id = $1::uuid`,
    [destinationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('VALIDATION', undefined, {
      details: { reason: 'DESTINATION_NOT_FOUND' },
    });
  }
  return mapDestination(row);
}

/**
 * Fail-closed compare of callback chat/topic/environment against destination binding.
 */
export function assertCallbackDestination(
  destination: TelegramDestinationRow,
  input: {
    readonly chatId: string;
    readonly topicThreadId: string | null;
    readonly environment: ControlCenterEnvironment;
    readonly requireEnabled?: boolean;
  },
): void {
  if (destination.environment !== input.environment) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'ENVIRONMENT_MISMATCH' },
    });
  }
  if (input.requireEnabled !== false && !destination.enabled) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'DESTINATION_DISABLED' },
    });
  }
  if (destination.chatId !== input.chatId) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'CHAT_MISMATCH' },
    });
  }
  const boundTopic = destination.topicThreadId;
  const callbackTopic = input.topicThreadId;
  if (boundTopic === null && callbackTopic === null) return;
  if (boundTopic === null || callbackTopic === null || boundTopic !== callbackTopic) {
    throw new ControlCenterError('NOT_AUTHORIZED', undefined, {
      details: { reason: 'TOPIC_MISMATCH' },
    });
  }
}

export async function upsertTestDestination(
  db: Db,
  input: {
    readonly environment: ControlCenterEnvironment;
    readonly purpose: ControlCenterDestinationPurpose;
    readonly chatId: string;
    readonly topicThreadId: string | null;
    readonly enabled?: boolean;
    readonly title?: string;
  },
): Promise<TelegramDestinationRow> {
  const result = await db.query<{
    id: string;
    environment: ControlCenterEnvironment;
    purpose: ControlCenterDestinationPurpose;
    chat_id: string;
    topic_thread_id: string | null;
    title: string | null;
    enabled: boolean;
  }>(
    `INSERT INTO telegram_destinations (
       environment, purpose, chat_id, topic_thread_id, title, enabled
     ) VALUES (
       $1::environment_name, $2::telegram_destination_purpose, $3::bigint, $4::bigint, $5, $6
     )
     ON CONFLICT ON CONSTRAINT telegram_destinations_target_key
     DO UPDATE SET enabled = EXCLUDED.enabled, title = EXCLUDED.title, updated_at = now()
     RETURNING id, environment, purpose, chat_id::text AS chat_id,
               topic_thread_id::text AS topic_thread_id, title, enabled`,
    [
      input.environment,
      input.purpose,
      input.chatId,
      input.topicThreadId,
      input.title ?? input.purpose,
      input.enabled ?? true,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new ControlCenterError('INTERNAL', undefined, {
      details: { reason: 'DESTINATION_UPSERT_FAILED' },
    });
  }
  return mapDestination(row);
}
