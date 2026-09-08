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
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
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
 * Create a simulated reward source identity.
 * Persists simulated_reward_sources (DB-authoritative) + Outbox audit event.
 * Never accepts client monetary amounts.
 */
export async function createSimulatedRewardSourceIdentity(
  db: LedgerDb,
  options?: { readonly userId?: string | null },
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
    await client.query(
      `INSERT INTO simulated_reward_sources (id, provider_id, user_id, status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CREATED')`,
      [sourceId, provider.id, options?.userId ?? null],
    );
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
 * Authorize a PROMOTION source_id against the server-controlled simulated registry.
 * Locks the row FOR UPDATE. Must be CREATED (not yet quoted/completed).
 */
export async function assertSimulatedSourceEligibleForQuote(
  client: PoolClient,
  input: {
    readonly sourceId: string;
    readonly providerId: string | null | undefined;
    readonly userId: string;
  },
): Promise<{ sourceId: string; providerId: string }> {
  const provider = await ensureSimulatedRewardProvider(client);
  if (provider.productionMonetaryStatus !== 'BLOCKED') {
    throw new RewardDomainError(
      'SOURCE_INVALID',
      'SIMULATED_REWARD_SOURCE must remain production_monetary_status BLOCKED',
    );
  }
  if (input.providerId !== undefined && input.providerId !== null && input.providerId !== provider.id) {
    throw new RewardDomainError(
      'SOURCE_INVALID',
      'simulated quotes must use SIMULATED_REWARD_SOURCE provider',
      { details: { expectedProviderId: provider.id } },
    );
  }

  const source = await client.query<{
    id: string;
    provider_id: string;
    user_id: string | null;
    status: string;
  }>(
    `SELECT id, provider_id, user_id, status
     FROM simulated_reward_sources
     WHERE id = $1
     FOR UPDATE`,
    [input.sourceId],
  );
  const row = source.rows[0];
  if (row === undefined) {
    throw new RewardDomainError(
      'SOURCE_NOT_REGISTERED',
      'simulated source identity is not registered',
      { details: { sourceId: input.sourceId } },
    );
  }
  if (row.provider_id !== provider.id) {
    throw new RewardDomainError('SOURCE_INVALID', 'simulated source provider mismatch');
  }
  if (row.status !== 'CREATED') {
    throw new RewardDomainError('SOURCE_INVALID', 'simulated source is not eligible for a new quote', {
      details: { status: row.status },
    });
  }
  if (row.user_id !== null && row.user_id !== input.userId) {
    throw new RewardDomainError('SOURCE_INVALID', 'simulated source is bound to a different user');
  }
  return { sourceId: row.id, providerId: provider.id };
}

export async function markSimulatedSourceQuoted(
  client: PoolClient,
  sourceId: string,
  asOf: Date,
): Promise<void> {
  const updated = await client.query(
    `UPDATE simulated_reward_sources
     SET status = 'QUOTED', quoted_at = $2::timestamptz
     WHERE id = $1 AND status = 'CREATED'`,
    [sourceId, asOf.toISOString()],
  );
  if (updated.rowCount !== 1) {
    throw new RewardDomainError('SOURCE_INVALID', 'failed to mark simulated source as QUOTED');
  }
}

/**
 * Server-only completion for a simulated source bound to an OPEN quote.
 * Enforces expiry before start: completedAt must be <= expires_at.
 * Bound to SIMULATED_REWARD_SOURCE / BLOCKED registry row.
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
      provider_id: string | null;
      status: string;
      source_started_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, user_id, source_type::text AS source_type, source_id, provider_id,
              status::text AS status, source_started_at, expires_at
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

    const provider = await ensureSimulatedRewardProvider(client);
    if (provider.productionMonetaryStatus !== 'BLOCKED') {
      throw new RewardDomainError(
        'SOURCE_INVALID',
        'SIMULATED_REWARD_SOURCE must remain production_monetary_status BLOCKED',
      );
    }
    if (row.provider_id !== provider.id) {
      throw new RewardDomainError(
        'SOURCE_INVALID',
        'quote provider is not the internal simulated provider',
      );
    }

    const registered = await client.query<{
      id: string;
      provider_id: string;
      status: string;
      completed_at: Date | null;
    }>(
      `SELECT id, provider_id, status, completed_at
       FROM simulated_reward_sources
       WHERE id = $1
       FOR UPDATE`,
      [command.sourceId],
    );
    const sourceRow = registered.rows[0];
    if (sourceRow === undefined) {
      throw new RewardDomainError('SOURCE_NOT_REGISTERED', 'simulated source identity missing');
    }
    if (sourceRow.provider_id !== provider.id) {
      throw new RewardDomainError('SOURCE_INVALID', 'simulated source provider mismatch');
    }
    if (sourceRow.status === 'COMPLETED' && sourceRow.completed_at !== null) {
      // Idempotent completion path if quote somehow lacks source_started_at — still require start.
    } else if (sourceRow.status !== 'QUOTED' && sourceRow.status !== 'CREATED') {
      throw new RewardDomainError('SOURCE_INVALID', 'simulated source is not eligible to complete', {
        details: { status: sourceRow.status },
      });
    }

    const completedAt = command.completedAt ?? new Date();
    // Boundary: startedAt <= expires_at is permitted; startedAt > expires_at is rejected.
    if (completedAt.getTime() > row.expires_at.getTime()) {
      throw new RewardDomainError('QUOTE_EXPIRED', 'cannot start simulated source after quote expiry', {
        details: {
          expiresAt: row.expires_at.toISOString(),
          completedAt: completedAt.toISOString(),
        },
      });
    }

    const updated = await client.query<{ source_started_at: Date }>(
      `UPDATE reward_quotes
       SET source_started_at = $2::timestamptz, updated_at = now()
       WHERE id = $1 AND source_started_at IS NULL
       RETURNING source_started_at`,
      [command.quoteId, completedAt.toISOString()],
    );
    const started = updated.rows[0]?.source_started_at;
    if (started === undefined) {
      throw new RewardDomainError('INTERNAL', 'failed to mark simulated source started');
    }

    await client.query(
      `UPDATE simulated_reward_sources
       SET status = 'COMPLETED', completed_at = $2::timestamptz
       WHERE id = $1 AND status IN ('CREATED', 'QUOTED')`,
      [command.sourceId, completedAt.toISOString()],
    );

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
