import { createHash } from 'node:crypto';

import type { PoolClient } from 'pg';

import { AdsDomainError } from '../errors.js';
import type {
  AdSessionSignalRecord,
  AdSignalAuthenticity,
  AdSignalCorrelation,
  AdSignalSource,
  AdSignalType,
  SafePayload,
} from '../types.js';

const CLIENT_SIGNAL_TYPES: ReadonlySet<AdSignalType> = new Set([
  'REQUEST_APPROVED',
  'AD_LOADED',
  'AD_STARTED',
  'CLIENT_COMPLETION',
  'NO_FILL',
  'LOAD_FAILURE',
  'START_FAILURE',
  'TECHNICAL_FAILURE',
  'USER_SKIPPED',
]);

const PROVIDER_SIGNAL_TYPES: ReadonlySet<AdSignalType> = new Set([
  'PROVIDER_CONFIRMATION',
  'NO_FILL',
  'POLICY_REJECTION',
]);

const SYSTEM_SIGNAL_TYPES: ReadonlySet<AdSignalType> = new Set([
  'SESSION_CREATED',
  'QUOTE_COMMITTED',
  'AUTHORIZATION_PASSED',
  'MONETARY_GATE_BLOCKED',
  'VERIFICATION_PASSED',
  'REWARD_COMMITTED',
  'POLICY_REJECTION',
  'TECHNICAL_FAILURE',
  'NO_FILL',
  'USER_SKIPPED',
  'SESSION_EXPIRED',
]);

/** Raw client event names accepted from the mini app, mapped to canonical signals. */
const CLIENT_EVENT_ALIASES: Readonly<Record<string, AdSignalType>> = {
  request: 'REQUEST_APPROVED',
  requested: 'REQUEST_APPROVED',
  load: 'AD_LOADED',
  loaded: 'AD_LOADED',
  start: 'AD_STARTED',
  started: 'AD_STARTED',
  onstart: 'AD_STARTED',
  complete: 'CLIENT_COMPLETION',
  completed: 'CLIENT_COMPLETION',
  onreward: 'CLIENT_COMPLETION',
  reward: 'CLIENT_COMPLETION',
  nofill: 'NO_FILL',
  no_fill: 'NO_FILL',
  loaderror: 'LOAD_FAILURE',
  load_error: 'LOAD_FAILURE',
  starterror: 'START_FAILURE',
  start_error: 'START_FAILURE',
  error: 'TECHNICAL_FAILURE',
  onerror: 'TECHNICAL_FAILURE',
  skip: 'USER_SKIPPED',
  skipped: 'USER_SKIPPED',
  closed: 'USER_SKIPPED',
};

/** Raw provider callback event names, mapped to canonical signals. */
const PROVIDER_EVENT_ALIASES: Readonly<Record<string, AdSignalType>> = {
  reward: 'PROVIDER_CONFIRMATION',
  rewarded: 'PROVIDER_CONFIRMATION',
  reward_url: 'PROVIDER_CONFIRMATION',
  postback: 'PROVIDER_CONFIRMATION',
  nofill: 'NO_FILL',
  no_fill: 'NO_FILL',
  rejected: 'POLICY_REJECTION',
};

export interface AppendAdSessionSignalInput {
  readonly adSessionId: string;
  readonly source: AdSignalSource;
  readonly signalType: AdSignalType;
  readonly providerEventId?: string | null;
  readonly occurredAt?: Date | null;
  readonly authenticity?: AdSignalAuthenticity;
  readonly correlation?: AdSignalCorrelation;
  readonly safePayload?: SafePayload;
  readonly inboxEventId?: string | null;
}

export interface AppendAdSessionSignalResult {
  readonly signal: AdSessionSignalRecord;
  /** False when an identical signal was already stored (idempotent replay). */
  readonly created: boolean;
}

/**
 * Normalize an untrusted client event name. Client evidence is forensic only and is
 * always stored as UNVERIFIED regardless of what the client claims.
 */
export function normalizeClientSignalType(rawEventType: unknown): AdSignalType {
  if (typeof rawEventType !== 'string' || rawEventType.trim() === '') {
    throw new AdsDomainError('VALIDATION', 'client event type must be a non-empty string');
  }
  const key = rawEventType.trim().toLowerCase().replaceAll('-', '_');
  const direct = CLIENT_SIGNAL_TYPES.has(rawEventType.trim().toUpperCase() as AdSignalType)
    ? (rawEventType.trim().toUpperCase() as AdSignalType)
    : undefined;
  const mapped = direct ?? CLIENT_EVENT_ALIASES[key];
  if (mapped === undefined) {
    throw new AdsDomainError('SIGNAL_TYPE_UNKNOWN', 'unrecognized client ad event type', {
      details: { rawEventType },
    });
  }
  return mapped;
}

/** Normalize a provider server callback event name into the canonical vocabulary. */
export function normalizeProviderSignalType(rawEventType: unknown): AdSignalType {
  if (typeof rawEventType !== 'string' || rawEventType.trim() === '') {
    throw new AdsDomainError('VALIDATION', 'provider event type must be a non-empty string');
  }
  const key = rawEventType.trim().toLowerCase().replaceAll('-', '_');
  const direct = PROVIDER_SIGNAL_TYPES.has(rawEventType.trim().toUpperCase() as AdSignalType)
    ? (rawEventType.trim().toUpperCase() as AdSignalType)
    : undefined;
  const mapped = direct ?? PROVIDER_EVENT_ALIASES[key];
  if (mapped === undefined) {
    throw new AdsDomainError('SIGNAL_TYPE_UNKNOWN', 'unrecognized provider ad event type', {
      details: { rawEventType },
    });
  }
  return mapped;
}

function assertSourceAllowsSignal(source: AdSignalSource, signalType: AdSignalType): void {
  const allowed =
    source === 'CLIENT'
      ? CLIENT_SIGNAL_TYPES
      : source === 'PROVIDER'
        ? PROVIDER_SIGNAL_TYPES
        : SYSTEM_SIGNAL_TYPES;
  if (!allowed.has(signalType)) {
    throw new AdsDomainError('SIGNAL_REJECTED', 'signal type is not valid for this source', {
      details: { source, signalType },
    });
  }
}

/**
 * Keep only primitive values with stable keys. Raw provider bodies, tokens, headers and
 * anything object-shaped are dropped before the payload reaches the database.
 */
export function redactSafePayload(payload: unknown): SafePayload {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const redacted: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) continue;
    if (/secret|token|signature|password|authorization|cookie|key/i.test(key)) continue;
    if (value === null) {
      redacted[key] = null;
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      redacted[key] = value;
    } else if (typeof value === 'string') {
      redacted[key] = value.length > 256 ? `${value.slice(0, 256)}…` : value;
    }
  }
  return redacted;
}

/** Deterministic hash over the canonicalized safe payload (key-sorted JSON). */
export function hashSafePayload(payload: SafePayload): string {
  const canonical = JSON.stringify(
    Object.fromEntries([...Object.entries(payload)].sort(([a], [b]) => (a < b ? -1 : 1))),
  );
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Append one ad session signal. Idempotent on
 * `(ad_session_id, source, signal_type, provider_event_id)` — the append-only uniqueness
 * constraint from migration 0003 — so provider retries and duplicate client callbacks
 * can never create a second piece of evidence.
 */
export async function appendAdSessionSignal(
  client: PoolClient,
  input: AppendAdSessionSignalInput,
): Promise<AppendAdSessionSignalResult> {
  assertSourceAllowsSignal(input.source, input.signalType);

  const safePayload = redactSafePayload(input.safePayload ?? {});
  const payloadHash = hashSafePayload(safePayload);
  const authenticity: AdSignalAuthenticity =
    input.source === 'CLIENT' ? 'UNVERIFIED' : (input.authenticity ?? 'UNVERIFIED');
  const correlation: AdSignalCorrelation = input.correlation ?? 'UNCORRELATED';

  const inserted = await client.query<SignalRow>(
    `INSERT INTO ad_session_signals (
       ad_session_id, source, signal_type, provider_event_id, occurred_at,
       authenticity_status, correlation_status, safe_payload_hash, safe_payload_redacted,
       inbox_event_id
     ) VALUES (
       $1::uuid, $2::ad_signal_source, $3, $4, $5::timestamptz,
       $6::ad_signal_authenticity_status, $7::ad_signal_correlation_status, $8, $9::jsonb,
       $10::uuid
     )
     ON CONFLICT (ad_session_id, source, signal_type, provider_event_id) DO NOTHING
     RETURNING ${SIGNAL_COLUMNS}`,
    [
      input.adSessionId,
      input.source,
      input.signalType,
      input.providerEventId ?? null,
      (input.occurredAt ?? null)?.toISOString() ?? null,
      authenticity,
      correlation,
      payloadHash,
      JSON.stringify(safePayload),
      input.inboxEventId ?? null,
    ],
  );

  const insertedRow = inserted.rows[0];
  if (insertedRow !== undefined) {
    return { signal: toSignalRecord(insertedRow), created: true };
  }

  const existing = await client.query<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS}
     FROM ad_session_signals
     WHERE ad_session_id = $1::uuid
       AND source = $2::ad_signal_source
       AND signal_type = $3
       AND provider_event_id IS NOT DISTINCT FROM $4`,
    [input.adSessionId, input.source, input.signalType, input.providerEventId ?? null],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) {
    throw new AdsDomainError('INTERNAL', 'signal insert conflicted but no existing row found', {
      details: { adSessionId: input.adSessionId, signalType: input.signalType },
    });
  }
  return { signal: toSignalRecord(existingRow), created: false };
}

export async function listAdSessionSignals(
  client: PoolClient,
  adSessionId: string,
): Promise<readonly AdSessionSignalRecord[]> {
  const result = await client.query<SignalRow>(
    `SELECT ${SIGNAL_COLUMNS}
     FROM ad_session_signals
     WHERE ad_session_id = $1::uuid
     ORDER BY received_at, id`,
    [adSessionId],
  );
  return result.rows.map(toSignalRecord);
}

const SIGNAL_COLUMNS = `id,
            ad_session_id,
            source::text AS source,
            signal_type,
            provider_event_id,
            occurred_at,
            received_at,
            authenticity_status::text AS authenticity_status,
            correlation_status::text AS correlation_status,
            safe_payload_hash,
            safe_payload_redacted`;

interface SignalRow {
  id: string;
  ad_session_id: string;
  source: AdSignalSource;
  signal_type: string;
  provider_event_id: string | null;
  occurred_at: Date | null;
  received_at: Date;
  authenticity_status: AdSignalAuthenticity;
  correlation_status: AdSignalCorrelation;
  safe_payload_hash: string;
  safe_payload_redacted: Record<string, string | number | boolean | null>;
}

function toSignalRecord(row: SignalRow): AdSessionSignalRecord {
  return {
    id: row.id,
    adSessionId: row.ad_session_id,
    source: row.source,
    signalType: row.signal_type as AdSignalType,
    providerEventId: row.provider_event_id,
    occurredAt: row.occurred_at === null ? null : row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    authenticity: row.authenticity_status,
    correlation: row.correlation_status,
    safePayloadHash: row.safe_payload_hash,
    safePayload: row.safe_payload_redacted,
  };
}
