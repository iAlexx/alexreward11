import type { PoolClient } from 'pg';

import { withLedgerTransaction, type AdsDb } from './db.js';
import { AdsDomainError } from './errors.js';
import type { ProviderHealth, ProviderHealthStatus } from './types.js';

export interface SetProviderHealthInput {
  readonly providerId: string;
  readonly status: ProviderHealthStatus;
  readonly reasonCode: string;
  readonly detailsRedacted?: Readonly<Record<string, string | number | boolean | null>>;
  readonly observedAt?: Date;
}

interface HealthRow {
  provider_id: string;
  status: ProviderHealthStatus;
  reason_code: string;
  observed_at: Date;
  details_redacted: Record<string, unknown>;
}

const HEALTH_COLUMNS = `provider_id,
            status::text AS status,
            reason_code,
            observed_at,
            details_redacted`;

function toProviderHealth(row: HealthRow): ProviderHealth {
  return {
    providerId: row.provider_id,
    status: row.status,
    reasonCode: row.reason_code,
    observedAt: row.observed_at.toISOString(),
    detailsRedacted: row.details_redacted,
  };
}

/**
 * Read the latest provider health observation.
 *
 * Health controls whether NEW sessions may be authorized. It never rewrites the outcome
 * of an existing session and never reverses an already-earned reward (migration 0030).
 * A provider with no observation at all is treated as UNAVAILABLE, not healthy.
 */
export async function getProviderHealth(db: AdsDb, providerId: string): Promise<ProviderHealth> {
  return withLedgerTransaction(db, (client) => getProviderHealthOnClient(client, providerId));
}

export async function getProviderHealthOnClient(
  client: PoolClient,
  providerId: string,
): Promise<ProviderHealth> {
  const result = await client.query<HealthRow>(
    `SELECT ${HEALTH_COLUMNS}
     FROM provider_health_snapshots
     WHERE provider_id = $1::uuid
     ORDER BY observed_at DESC, created_at DESC, id DESC
     LIMIT 1`,
    [providerId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      providerId,
      status: 'UNAVAILABLE',
      reasonCode: 'NO_HEALTH_OBSERVATION',
      observedAt: new Date(0).toISOString(),
      detailsRedacted: {},
    };
  }
  return toProviderHealth(row);
}

/** Append a health observation. Snapshots are append-only; nothing is updated in place. */
export async function setProviderHealth(
  db: AdsDb,
  input: SetProviderHealthInput,
): Promise<ProviderHealth> {
  return withLedgerTransaction(db, (client) => setProviderHealthOnClient(client, input));
}

export async function setProviderHealthOnClient(
  client: PoolClient,
  input: SetProviderHealthInput,
): Promise<ProviderHealth> {
  if (input.reasonCode.trim() === '') {
    throw new AdsDomainError('VALIDATION', 'health reasonCode is required');
  }
  const result = await client.query<HealthRow>(
    `INSERT INTO provider_health_snapshots (
       provider_id, status, reason_code, details_redacted, observed_at
     ) VALUES ($1::uuid, $2::provider_health_status, $3, $4::jsonb, $5::timestamptz)
     RETURNING ${HEALTH_COLUMNS}`,
    [
      input.providerId,
      input.status,
      input.reasonCode,
      JSON.stringify(input.detailsRedacted ?? {}),
      (input.observedAt ?? new Date()).toISOString(),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AdsDomainError('INTERNAL', 'provider health snapshot insert returned no row');
  }
  return toProviderHealth(row);
}
