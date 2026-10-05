import type { PoolClient } from 'pg';

import { PROVIDER_SIGNAL_CORRELATION_WINDOW_SECONDS } from '../constants.js';
import { withLedgerTransaction, type AdsDb } from '../db.js';
import { AdsDomainError } from '../errors.js';
import { adsGramProvider, parseAdsGramRewardQuery } from '../providers/adsgram/adapter.js';
import { ADSGRAM_CODE, ADSGRAM_PROVIDER_ID } from '../providers/adsgram/manifest.js';
import { recordProviderSignal } from '../sessions/lifecycle.js';
import { hashSafePayload } from '../sessions/signals.js';
import type {
  AdProviderEventStatus,
  AdSessionState,
  AdSignalAuthenticity,
  AdSignalCorrelation,
} from '../types.js';

export interface WebhookRateLimitDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
}

/**
 * Rate-limit hook. The production limiter lives at the HTTP edge; this seam exists so the
 * ingestion command can be limited (and tested) without the domain owning transport
 * concerns. When no hook is supplied, ingestion proceeds — the limiter is a defence
 * against abuse, never the control that stops money.
 */
export type WebhookRateLimitHook = (input: {
  readonly key: string;
  readonly receivedAt: Date;
}) => Promise<WebhookRateLimitDecision> | WebhookRateLimitDecision;

export interface IngestAdsGramRewardUrlInput {
  /** Parsed query string of the Reward URL call. Never the raw request object. */
  readonly query: unknown;
  readonly receivedAt?: Date;
  readonly rateLimitHook?: WebhookRateLimitHook;
  readonly remoteIpRedacted?: string | null;
}

export interface IngestAdsGramRewardUrlResult {
  readonly providerEventId: string | null;
  readonly providerEventRowId: string | null;
  readonly duplicate: boolean;
  readonly processingStatus: AdProviderEventStatus;
  readonly authenticity: AdSignalAuthenticity;
  readonly correlation: AdSignalCorrelation;
  readonly adSessionId: string | null;
  readonly adSessionState: AdSessionState | null;
  readonly telegramUserId: string | null;
  /** Always false. This path can never credit money (Spec V1.3 §20). */
  readonly rewardCredited: false;
  readonly reasonCodes: readonly string[];
}

interface CandidateSessionRow {
  id: string;
  state: AdSessionState;
}

/**
 * Ingest one AdsGram Reward URL call.
 *
 * Pipeline: validate query → rate-limit hook → store the normalized provider event →
 * best-effort correlate to one live session → append PROVIDER evidence.
 *
 * Hard rules enforced here:
 *  - the signal is stored as UNVERIFIED with authentication method NONE, because the
 *    documented Reward URL carries no signature for this integration;
 *  - more than one plausible session yields AMBIGUOUS, never a guess;
 *  - nothing on this path credits money. `Reward URL -> UPDATE balance` does not exist.
 *    Reward issuance is a separate, gated command that requires an APPROVED provider.
 */
export async function ingestAdsGramRewardUrl(
  db: AdsDb,
  input: IngestAdsGramRewardUrlInput,
): Promise<IngestAdsGramRewardUrlResult> {
  const receivedAt = input.receivedAt ?? new Date();
  const parsed = parseAdsGramRewardQuery(input.query);

  if (input.rateLimitHook !== undefined) {
    const decision = await input.rateLimitHook({
      key: `adsgram-reward/${parsed.telegramUserId ?? 'unidentified'}`,
      receivedAt,
    });
    if (!decision.allowed) {
      throw new AdsDomainError('RATE_LIMITED', 'reward URL ingestion is rate limited', {
        details: {
          retryAfterSeconds: decision.retryAfterSeconds ?? null,
          telegramUserId: parsed.telegramUserId,
        },
      });
    }
  }

  const verification = await adsGramProvider.verifyServerSignal(input.query, {
    providerId: ADSGRAM_PROVIDER_ID,
    receivedAt,
    remoteIpRedacted: input.remoteIpRedacted ?? null,
  });

  return withLedgerTransaction(db, async (client) => {
    const reasonCodes = [...verification.reasonCodes];

    const userId =
      verification.telegramUserId === null
        ? null
        : await resolveUserIdByTelegramId(client, verification.telegramUserId);
    if (verification.telegramUserId !== null && userId === null) {
      reasonCodes.push('USER_NOT_FOUND');
    }

    const candidates =
      userId === null
        ? []
        : await findCorrelationCandidates(client, {
            userId,
            declaredSessionId: parsed.adSessionId,
            receivedAt,
          });

    let correlation: AdSignalCorrelation = 'UNCORRELATED';
    let correlatedSessionId: string | null = null;
    if (candidates.length === 1) {
      correlation = 'CORRELATED';
      correlatedSessionId = candidates[0]?.id ?? null;
    } else if (candidates.length > 1) {
      correlation = 'AMBIGUOUS';
      reasonCodes.push('MULTIPLE_CANDIDATE_SESSIONS');
    } else {
      reasonCodes.push('NO_CANDIDATE_SESSION');
    }

    const stored = await storeProviderEvent(client, {
      providerEventId: verification.providerEventId,
      telegramUserId: verification.telegramUserId,
      payloadHash: hashSafePayload(verification.safePayload),
      safePayload: verification.safePayload,
      correlation,
      correlatedSessionId,
      receivedAt,
    });

    if (stored.duplicate) {
      reasonCodes.push('DUPLICATE_PROVIDER_EVENT');
      return {
        providerEventId: verification.providerEventId,
        providerEventRowId: stored.id,
        duplicate: true,
        processingStatus: 'DUPLICATE',
        authenticity: verification.authenticity,
        correlation,
        adSessionId: correlatedSessionId,
        adSessionState: null,
        telegramUserId: verification.telegramUserId,
        rewardCredited: false,
        reasonCodes,
      };
    }

    let adSessionState: AdSessionState | null = null;
    if (correlatedSessionId !== null) {
      const signalResult = await recordProviderSignal(client, {
        adSessionId: correlatedSessionId,
        providerCode: ADSGRAM_CODE,
        eventType: 'REWARD',
        providerEventId: verification.providerEventId,
        authenticity: verification.authenticity,
        correlation,
        payload: verification.safePayload,
        occurredAt: receivedAt,
        asOf: receivedAt,
      });
      adSessionState = signalResult.state;
      reasonCodes.push(...signalResult.reasonCodes);
    }

    const processingStatus: AdProviderEventStatus =
      correlatedSessionId === null ? 'IGNORED' : 'PROCESSED';
    await client.query(
      `UPDATE ad_provider_events
       SET processing_status = $2::ad_provider_event_status,
           processed_at = $3::timestamptz,
           correlated_ad_session_id = $4::uuid
       WHERE id = $1::uuid`,
      [stored.id, processingStatus, receivedAt.toISOString(), correlatedSessionId],
    );

    return {
      providerEventId: verification.providerEventId,
      providerEventRowId: stored.id,
      duplicate: false,
      processingStatus,
      authenticity: verification.authenticity,
      correlation,
      adSessionId: correlatedSessionId,
      adSessionState,
      telegramUserId: verification.telegramUserId,
      rewardCredited: false,
      reasonCodes,
    };
  });
}

async function resolveUserIdByTelegramId(
  client: PoolClient,
  telegramUserId: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE telegram_user_id = $1::bigint`,
    [telegramUserId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Candidate sessions for an unsigned provider signal.
 *
 * When the provider echoed a session id we use only that session. Otherwise we look at
 * live AdsGram sessions inside the correlation window; returning more than one row is what
 * produces AMBIGUOUS.
 */
async function findCorrelationCandidates(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly declaredSessionId: string | null;
    readonly receivedAt: Date;
  },
): Promise<readonly CandidateSessionRow[]> {
  if (input.declaredSessionId !== null) {
    const declared = await client.query<CandidateSessionRow>(
      `SELECT id, state::text AS state
       FROM ad_sessions
       WHERE id = $1::uuid AND user_id = $2::uuid AND provider_id = $3::uuid`,
      [input.declaredSessionId, input.userId, ADSGRAM_PROVIDER_ID],
    );
    return declared.rows;
  }

  const windowStart = new Date(
    input.receivedAt.getTime() - PROVIDER_SIGNAL_CORRELATION_WINDOW_SECONDS * 1000,
  );
  const result = await client.query<CandidateSessionRow>(
    `SELECT id, state::text AS state
     FROM ad_sessions
     WHERE user_id = $1::uuid
       AND provider_id = $2::uuid
       AND created_at >= $3::timestamptz
       AND state NOT IN ('REWARDED', 'NO_FILL', 'FAILED', 'SKIPPED', 'REJECTED', 'EXPIRED')
     ORDER BY created_at DESC
     LIMIT 5`,
    [input.userId, ADSGRAM_PROVIDER_ID, windowStart.toISOString()],
  );
  return result.rows;
}

async function storeProviderEvent(
  client: PoolClient,
  input: {
    readonly providerEventId: string | null;
    readonly telegramUserId: string | null;
    readonly payloadHash: string;
    readonly safePayload: Readonly<Record<string, string | number | boolean | null>>;
    readonly correlation: AdSignalCorrelation;
    readonly correlatedSessionId: string | null;
    readonly receivedAt: Date;
  },
): Promise<{ readonly id: string; readonly duplicate: boolean }> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ad_provider_events (
       provider_id, provider_event_id, telegram_user_id, normalized_event_type,
       raw_payload_redacted, payload_hash, authenticity_status, processing_status,
       correlated_ad_session_id, received_at
     ) VALUES (
       $1::uuid, $2, $3::bigint, 'REWARD_URL_CALLBACK',
       $4::jsonb, $5, 'UNVERIFIED', 'RECEIVED',
       NULL, $6::timestamptz
     )
     ON CONFLICT (provider_id, provider_event_id) DO NOTHING
     RETURNING id`,
    [
      ADSGRAM_PROVIDER_ID,
      input.providerEventId,
      input.telegramUserId,
      JSON.stringify(input.safePayload),
      input.payloadHash,
      input.receivedAt.toISOString(),
    ],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow !== undefined) {
    return { id: insertedRow.id, duplicate: false };
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ad_provider_events
     WHERE provider_id = $1::uuid AND provider_event_id IS NOT DISTINCT FROM $2`,
    [ADSGRAM_PROVIDER_ID, input.providerEventId],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) {
    throw new AdsDomainError('INTERNAL', 'provider event conflicted but no existing row found');
  }
  return { id: existingRow.id, duplicate: true };
}
