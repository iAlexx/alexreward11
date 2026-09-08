import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { withLedgerTransaction, type LedgerDb } from './db.js';
import { RewardDomainError } from './errors.js';
import { insertOutboxEvent } from './outbox.js';
import {
  SIMULATED_REWARD_SOURCE_CODE,
  type CompleteSimulatedSourceCommand,
  type SimulatedSourceIdentity,
} from './types.js';

/** Deterministic UUID for MEMBERSHIP_BONUS reward_events.source_id derived from base event. */
export function membershipBonusSourceIdFromBase(baseRewardEventId: string): string {
  const digest = createHash('sha256')
    .update(`alex-rewards:membership-bonus:${baseRewardEventId}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5-ish
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function ensureSimulatedRewardProvider(
  client: PoolClient,
): Promise<{ id: string; code: string; productionMonetaryStatus: string }> {
  const existing = await client.query<{
    id: string;
    code: string;
    production_monetary_status: string;
  }>(
    `SELECT id, code, production_monetary_status::text AS production_monetary_status
     FROM ad_providers WHERE code = $1`,
    [SIMULATED_REWARD_SOURCE_CODE],
  );
  if (existing.rows[0] !== undefined) {
    return {
      id: existing.rows[0].id,
      code: existing.rows[0].code,
      productionMonetaryStatus: existing.rows[0].production_monetary_status,
    };
  }
  const inserted = await client.query<{
    id: string;
    code: string;
    production_monetary_status: string;
  }>(
    `INSERT INTO ad_providers (
       code, name, status, lifecycle_state, production_monetary_status,
       rewarded_use_allowed, incentivized_crypto_allowed, server_verification_supported
     ) VALUES (
       $1, 'Simulated reward source (Phase 5 test/internal)', 'DISABLED', 'CONTRACTED', 'BLOCKED',
       false, false, true
     )
     RETURNING id, code, production_monetary_status::text AS production_monetary_status`,
    [SIMULATED_REWARD_SOURCE_CODE],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new RewardDomainError('INTERNAL', 'simulated provider insert failed');
  }
  return {
    id: row.id,
    code: row.code,
    productionMonetaryStatus: row.production_monetary_status,
  };
}

/**
 * Create a simulated reward source identity. source_id is a server UUID.
 * Never accepts client monetary amounts.
 */
export async function createSimulatedRewardSourceIdentity(
  db: LedgerDb,
): Promise<SimulatedSourceIdentity> {
  return withLedgerTransaction(db, async (client) => {
    const provider = await ensureSimulatedRewardProvider(client);
    if (provider.productionMonetaryStatus !== 'BLOCKED') {
      throw new RewardDomainError(
        'SOURCE_INVALID',
        'SIMULATED_REWARD_SOURCE must remain production_monetary_status BLOCKED',
      );
    }
    const sourceId = randomUUID();
    await insertOutboxEvent(client, {
      aggregateType: 'simulated_reward_source',
      aggregateId: sourceId,
      eventType: 'simulated_reward_source.created',
      dedupeKey: `simulated-source-created/${sourceId}`,
      payload: {
        sourceId,
        providerId: provider.id,
        providerCode: SIMULATED_REWARD_SOURCE_CODE,
      },
    });
    return {
      sourceId,
      providerId: provider.id,
      providerCode: SIMULATED_REWARD_SOURCE_CODE,
      productionMonetaryStatus: 'BLOCKED',
    };
  });
}

/**
 * Server-only completion mark for a simulated source bound to an OPEN quote.
 * Sets reward_quotes.source_started_at (protected start).
 */
export async function completeSimulatedRewardSource(
  db: LedgerDb,
  command: CompleteSimulatedSourceCommand,
): Promise<{ quoteId: string; sourceStartedAt: string }> {
  return withLedgerTransaction(db, async (client) => {
    const quote = await client.query<{
      id: string;
      user_id: string;
      source_type: string;
      source_id: string;
      status: string;
      source_started_at: Date | null;
    }>(
      `SELECT id, user_id, source_type::text AS source_type, source_id, status::text AS status,
              source_started_at
       FROM reward_quotes
       WHERE id = $1
       FOR UPDATE`,
      [command.quoteId],
    );
    const row = quote.rows[0];
    if (row === undefined) {
      throw new RewardDomainError('QUOTE_NOT_FOUND', 'reward quote not found', {
        details: { quoteId: command.quoteId },
      });
    }
    if (row.user_id !== command.userId) {
      throw new RewardDomainError('SOURCE_INVALID', 'quote does not belong to user');
    }
    if (row.source_type !== 'PROMOTION' || row.source_id !== command.sourceId) {
      throw new RewardDomainError('SOURCE_INVALID', 'simulated source does not match quote');
    }
    if (row.status !== 'OPEN') {
      throw new RewardDomainError('QUOTE_NOT_OPEN', 'quote is not OPEN', {
        details: { status: row.status },
      });
    }
    if (row.source_started_at !== null) {
      return {
        quoteId: row.id,
        sourceStartedAt: row.source_started_at.toISOString(),
      };
    }

    const completedAt = command.completedAt ?? new Date();
    const updated = await client.query<{ source_started_at: Date }>(
      `UPDATE reward_quotes
       SET source_started_at = $2::timestamptz, updated_at = now()
       WHERE id = $1
       RETURNING source_started_at`,
      [command.quoteId, completedAt.toISOString()],
    );
    const started = updated.rows[0]?.source_started_at;
    if (started === undefined) {
      throw new RewardDomainError('INTERNAL', 'failed to mark simulated source started');
    }
    await insertOutboxEvent(client, {
      aggregateType: 'reward_quote',
      aggregateId: command.quoteId,
      eventType: 'reward_quote.source_started',
      dedupeKey: `reward-quote-source-started/${command.quoteId}`,
      payload: { quoteId: command.quoteId, sourceId: command.sourceId },
    });
    return { quoteId: command.quoteId, sourceStartedAt: started.toISOString() };
  });
}

export async function markSimulatedSourceStarted(
  db: LedgerDb,
  input: { readonly quoteId: string; readonly startedAt?: Date },
): Promise<{ quoteId: string; sourceStartedAt: string }> {
  return withLedgerTransaction(db, async (client) => {
    const quote = await client.query<{
      id: string;
      status: string;
      source_started_at: Date | null;
    }>(
      `SELECT id, status::text AS status, source_started_at
       FROM reward_quotes WHERE id = $1 FOR UPDATE`,
      [input.quoteId],
    );
    const row = quote.rows[0];
    if (row === undefined) {
      throw new RewardDomainError('QUOTE_NOT_FOUND', 'reward quote not found');
    }
    if (row.source_started_at !== null) {
      return { quoteId: row.id, sourceStartedAt: row.source_started_at.toISOString() };
    }
    if (row.status !== 'OPEN') {
      throw new RewardDomainError('QUOTE_NOT_OPEN', 'quote is not OPEN');
    }
    const startedAt = input.startedAt ?? new Date();
    const updated = await client.query<{ source_started_at: Date }>(
      `UPDATE reward_quotes
       SET source_started_at = $2::timestamptz, updated_at = now()
       WHERE id = $1
       RETURNING source_started_at`,
      [input.quoteId, startedAt.toISOString()],
    );
    const started = updated.rows[0]?.source_started_at;
    if (started === undefined) {
      throw new RewardDomainError('INTERNAL', 'failed to mark source started');
    }
    return { quoteId: input.quoteId, sourceStartedAt: started.toISOString() };
  });
}
