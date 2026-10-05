import { randomUUID } from 'node:crypto';

import {
  insertOutboxEvent,
  issueAdReward,
  releaseExposureReservationsForQuote,
  releaseMembershipBonusBudgetReservation,
  releaseRewardBudgetReservation,
  type IssuedRewardResult,
} from '@alex-rewards/rewards';
import type { PoolClient } from 'pg';

import { hardCeilingFor, loadProviderMonetaryFacts } from '../admin-read.js';
import { AD_REWARD_IDEMPOTENCY_PREFIX } from '../constants.js';
import { withLedgerTransaction, type AdsDb } from '../db.js';
import { AdsDomainError } from '../errors.js';
import { resolveEffectiveProviderLimits } from '../limits/resolve.js';
import {
  evaluateProviderMonetaryEligibility,
  type ProviderMonetaryEligibilityResult,
} from '../monetary/eligibility.js';
import type {
  AdSessionRecord,
  AdSessionSignalRecord,
  AdSessionState,
  AdSignalAuthenticity,
  AdSignalCorrelation,
  AdSignalType,
} from '../types.js';

import {
  appendAdSessionSignal,
  listAdSessionSignals,
  normalizeClientSignalType,
  normalizeProviderSignalType,
  redactSafePayload,
} from './signals.js';
import { deriveSessionState, isTerminalAdSessionState } from './state.js';

export interface RecordClientSignalInput {
  readonly adSessionId: string;
  readonly userId: string;
  readonly eventType: string;
  readonly payload?: unknown;
  readonly occurredAt?: Date;
  readonly asOf?: Date;
}

export interface RecordProviderSignalInput {
  readonly adSessionId: string;
  readonly providerCode: string;
  readonly eventType: string;
  readonly providerEventId?: string | null;
  readonly authenticity?: AdSignalAuthenticity;
  readonly correlation?: AdSignalCorrelation;
  readonly payload?: unknown;
  readonly occurredAt?: Date;
  readonly asOf?: Date;
}

export interface RecordAdSignalResult {
  readonly adSessionId: string;
  readonly signalType: AdSignalType;
  readonly signalCreated: boolean;
  readonly previousState: AdSessionState;
  readonly state: AdSessionState;
  readonly stateChanged: boolean;
  readonly evidenceOnly: boolean;
  readonly reasonCodes: readonly string[];
}

export interface AttemptVerifyAndIssueAdRewardInput {
  readonly adSessionId: string;
  readonly userId: string;
  readonly idempotencyKey?: string;
  readonly asOf?: Date;
}

export interface AttemptVerifyAndIssueAdRewardResult {
  readonly adSessionId: string;
  readonly state: AdSessionState;
  readonly issued: boolean;
  readonly alreadyRewarded: boolean;
  readonly monetary: ProviderMonetaryEligibilityResult | null;
  readonly reward: IssuedRewardResult | null;
  readonly reasonCodes: readonly string[];
}

export type AdSessionFailureOutcome = 'NO_FILL' | 'FAILED' | 'SKIPPED';

export interface RecordAdSessionOutcomeInput {
  readonly adSessionId: string;
  readonly userId: string;
  readonly outcome: AdSessionFailureOutcome;
  readonly failureCode?: string | null;
  readonly source?: 'CLIENT' | 'SYSTEM';
  readonly asOf?: Date;
}

export interface RecordAdSessionOutcomeResult {
  readonly adSessionId: string;
  readonly state: AdSessionState;
  readonly quoteReleased: boolean;
  readonly reasonCodes: readonly string[];
}

interface SessionRow {
  id: string;
  user_id: string;
  provider_id: string;
  ad_unit_id: string | null;
  reward_quote_id: string | null;
  state: AdSessionState;
  utc_day: string;
  provider_request_counted: boolean;
  successful_reward_counted: boolean;
  country_code: string | null;
  failure_code: string | null;
  expires_at: Date;
  created_at: Date;
}

const SESSION_COLUMNS = `id,
            user_id,
            provider_id,
            ad_unit_id,
            reward_quote_id,
            state::text AS state,
            utc_day::text AS utc_day,
            provider_request_counted,
            successful_reward_counted,
            country_code,
            failure_code,
            expires_at,
            created_at`;

function toSessionRecord(row: SessionRow): AdSessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    providerId: row.provider_id,
    adUnitId: row.ad_unit_id,
    rewardQuoteId: row.reward_quote_id,
    state: row.state,
    utcDay: row.utc_day,
    providerRequestCounted: row.provider_request_counted,
    successfulRewardCounted: row.successful_reward_counted,
    countryCode: row.country_code,
    failureCode: row.failure_code,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

async function lockSession(client: PoolClient, adSessionId: string): Promise<SessionRow> {
  const result = await client.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM ad_sessions WHERE id = $1::uuid FOR UPDATE`,
    [adSessionId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new AdsDomainError('SESSION_NOT_FOUND', 'ad session not found', {
      details: { adSessionId },
    });
  }
  return row;
}

function assertSessionOwnedBy(row: SessionRow, userId: string): void {
  if (row.user_id !== userId) {
    throw new AdsDomainError('SESSION_USER_MISMATCH', 'ad session does not belong to this user', {
      details: { adSessionId: row.id },
    });
  }
}

/** Timestamp column that records the first entry into a derived state. */
const STATE_TIMESTAMP_COLUMN: Readonly<Partial<Record<AdSessionState, string>>> = {
  STARTED: 'started_at',
  CLIENT_COMPLETION_RECEIVED: 'client_completed_at',
  PROVIDER_CONFIRMATION_RECEIVED: 'provider_confirmed_at',
  PENDING_VERIFICATION: 'provider_confirmed_at',
  VERIFIED: 'verified_at',
  REWARDED: 'rewarded_at',
};

async function persistSessionState(
  client: PoolClient,
  adSessionId: string,
  state: AdSessionState,
  asOf: Date,
  failureCode: string | null,
): Promise<void> {
  const timestampColumn = STATE_TIMESTAMP_COLUMN[state];
  // Placeholders are numbered as they are bound: an unused parameter leaves PostgreSQL
  // unable to infer its type and fails the whole update.
  const params: (string | null)[] = [adSessionId, state];
  const assignments = ['state = $2::ad_session_state', 'updated_at = now()'];
  if (timestampColumn !== undefined) {
    params.push(asOf.toISOString());
    assignments.push(
      `${timestampColumn} = COALESCE(${timestampColumn}, $${params.length}::timestamptz)`,
    );
  }
  if (failureCode !== null) {
    params.push(failureCode);
    assignments.push(`failure_code = COALESCE(failure_code, $${params.length})`);
  }
  await client.query(
    `UPDATE ad_sessions SET ${assignments.join(', ')} WHERE id = $1::uuid`,
    params,
  );
}

async function deriveAndPersist(
  client: PoolClient,
  row: SessionRow,
  signals: readonly AdSessionSignalRecord[],
  asOf: Date,
  domain: {
    readonly verificationPassed: boolean;
    readonly rewardCommitted: boolean;
    readonly failureCode?: string | null;
  },
): Promise<{
  readonly state: AdSessionState;
  readonly previousState: AdSessionState;
  readonly changed: boolean;
  readonly evidenceOnly: boolean;
  readonly reasonCodes: readonly string[];
}> {
  const derived = deriveSessionState({
    currentState: row.state,
    signals,
    expiresAt: row.expires_at,
    asOf,
    quoteCommitted: row.reward_quote_id !== null,
    authorizationPassed: signals.some((signal) => signal.signalType === 'AUTHORIZATION_PASSED'),
    verificationPassed: domain.verificationPassed,
    rewardCommitted: domain.rewardCommitted,
  });

  if (derived.changed) {
    await persistSessionState(client, row.id, derived.state, asOf, domain.failureCode ?? null);
  }

  return {
    state: derived.state,
    previousState: derived.previousState,
    changed: derived.changed,
    evidenceOnly: derived.evidenceOnly,
    reasonCodes: derived.reasonCodes,
  };
}

/**
 * Record one client-reported ad event.
 *
 * Client evidence is forensic: it is stored as UNVERIFIED, it can move the session
 * forward through REQUESTED/LOADED/STARTED/CLIENT_COMPLETION_RECEIVED, and it can never
 * reach PENDING_VERIFICATION, VERIFIED or REWARDED on its own (Spec V1.3 §20).
 */
export async function recordClientSignal(
  db: AdsDb,
  input: RecordClientSignalInput,
): Promise<RecordAdSignalResult> {
  const signalType = normalizeClientSignalType(input.eventType);
  return withLedgerTransaction(db, async (client) => {
    const asOf = input.asOf ?? new Date();
    const row = await lockSession(client, input.adSessionId);
    assertSessionOwnedBy(row, input.userId);

    const safePayload = redactSafePayload(input.payload);

    // Forensic client event log (never financial, retention-bound).
    await client.query(
      `INSERT INTO ad_client_events (ad_session_id, event_type, safe_payload)
       VALUES ($1::uuid, $2, $3::jsonb)`,
      [row.id, signalType, JSON.stringify(safePayload)],
    );

    if (isTerminalAdSessionState(row.state)) {
      return {
        adSessionId: row.id,
        signalType,
        signalCreated: false,
        previousState: row.state,
        state: row.state,
        stateChanged: false,
        evidenceOnly: true,
        reasonCodes: ['TERMINAL_STATE_IMMUTABLE'],
      };
    }

    const appended = await appendAdSessionSignal(client, {
      adSessionId: row.id,
      source: 'CLIENT',
      signalType,
      occurredAt: input.occurredAt ?? asOf,
      // Session-bound by id, but client-asserted and therefore never authenticated.
      // REQUEST_APPROVED is client-observed attempt evidence only (P11-01) — it must NOT
      // increment authoritative ad_daily_counters.provider_requests.
      correlation: 'CORRELATED',
      safePayload,
    });

    const signals = await listAdSessionSignals(client, row.id);
    const derived = await deriveAndPersist(client, row, signals, asOf, {
      verificationPassed: false,
      rewardCommitted: false,
      failureCode: signalType === 'CLIENT_COMPLETION' ? null : `CLIENT_${signalType}`,
    });

    return {
      adSessionId: row.id,
      signalType,
      signalCreated: appended.created,
      previousState: derived.previousState,
      state: derived.state,
      stateChanged: derived.changed,
      evidenceOnly: derived.evidenceOnly,
      reasonCodes: derived.reasonCodes,
    };
  });
}

/**
 * Record one provider server signal against a known session.
 *
 * The caller supplies the authenticity and correlation it could actually prove. This
 * function never upgrades either value, so an unsigned callback stays UNVERIFIED.
 */
export async function recordProviderSignal(
  db: AdsDb,
  input: RecordProviderSignalInput,
): Promise<RecordAdSignalResult> {
  const signalType = normalizeProviderSignalType(input.eventType);
  return withLedgerTransaction(db, async (client) => {
    const asOf = input.asOf ?? new Date();
    const row = await lockSession(client, input.adSessionId);

    const providerCheck = await client.query<{ code: string }>(
      `SELECT code FROM ad_providers WHERE id = $1::uuid`,
      [row.provider_id],
    );
    if (providerCheck.rows[0]?.code !== input.providerCode) {
      throw new AdsDomainError('SIGNAL_REJECTED', 'provider does not own this ad session', {
        details: { adSessionId: row.id, providerCode: input.providerCode },
      });
    }

    const appended = await appendAdSessionSignal(client, {
      adSessionId: row.id,
      source: 'PROVIDER',
      signalType,
      providerEventId: input.providerEventId ?? null,
      occurredAt: input.occurredAt ?? null,
      authenticity: input.authenticity ?? 'UNVERIFIED',
      correlation: input.correlation ?? 'UNCORRELATED',
      safePayload: redactSafePayload(input.payload),
    });

    if (isTerminalAdSessionState(row.state)) {
      return {
        adSessionId: row.id,
        signalType,
        signalCreated: appended.created,
        previousState: row.state,
        state: row.state,
        stateChanged: false,
        evidenceOnly: true,
        reasonCodes: ['TERMINAL_STATE_IMMUTABLE'],
      };
    }

    const signals = await listAdSessionSignals(client, row.id);
    const derived = await deriveAndPersist(client, row, signals, asOf, {
      verificationPassed: false,
      rewardCommitted: false,
    });

    return {
      adSessionId: row.id,
      signalType,
      signalCreated: appended.created,
      previousState: derived.previousState,
      state: derived.state,
      stateChanged: derived.changed,
      evidenceOnly: derived.evidenceOnly,
      reasonCodes: derived.reasonCodes,
    };
  });
}

/**
 * Run the production-money gate for a session and, only when it passes, issue the reward
 * through the Reward Engine.
 *
 * Order matters: required evidence → monetary eligibility → VERIFIED → issuance →
 * REWARDED. A blocked gate is recorded as evidence and leaves the session recoverable;
 * it never partially credits anything.
 */
export async function attemptVerifyAndIssueAdReward(
  db: AdsDb,
  input: AttemptVerifyAndIssueAdRewardInput,
): Promise<AttemptVerifyAndIssueAdRewardResult> {
  return withLedgerTransaction(db, async (client) => {
    const asOf = input.asOf ?? new Date();
    const row = await lockSession(client, input.adSessionId);
    assertSessionOwnedBy(row, input.userId);

    if (row.state === 'REWARDED') {
      return {
        adSessionId: row.id,
        state: row.state,
        issued: false,
        alreadyRewarded: true,
        monetary: null,
        reward: null,
        reasonCodes: ['ALREADY_REWARDED'],
      };
    }
    if (isTerminalAdSessionState(row.state)) {
      throw new AdsDomainError('SESSION_TERMINAL', 'terminal session cannot create a reward', {
        details: { adSessionId: row.id, state: row.state },
      });
    }

    const signals = await listAdSessionSignals(client, row.id);
    const clientCompletion = signals.find(
      (signal) => signal.signalType === 'CLIENT_COMPLETION' && signal.authenticity !== 'REJECTED',
    );
    const providerConfirmation = signals.find(
      (signal) => signal.signalType === 'PROVIDER_CONFIRMATION' && signal.source === 'PROVIDER',
    );

    if (clientCompletion === undefined || providerConfirmation === undefined) {
      const derived = await deriveAndPersist(client, row, signals, asOf, {
        verificationPassed: false,
        rewardCommitted: false,
      });
      return {
        adSessionId: row.id,
        state: derived.state,
        issued: false,
        alreadyRewarded: false,
        monetary: null,
        reasonCodes: [
          ...derived.reasonCodes,
          clientCompletion === undefined
            ? 'CLIENT_COMPLETION_MISSING'
            : 'PROVIDER_CONFIRMATION_MISSING',
        ],
        reward: null,
      };
    }

    const facts = await loadProviderMonetaryFacts(client, row.provider_id);
    const limits = await resolveEffectiveProviderLimits(client, {
      providerId: row.provider_id,
      asOf,
      countryCode: row.country_code,
    });
    const counters = await client.query<{
      provider_requests: number;
      successful_rewards: number;
    }>(
      `SELECT provider_requests, successful_rewards
       FROM ad_daily_counters
       WHERE user_id = $1::uuid AND provider_id = $2::uuid AND utc_day = $3::date
       FOR UPDATE`,
      [row.user_id, row.provider_id, row.utc_day],
    );
    const providerRequests = counters.rows[0]?.provider_requests ?? 0;
    const successfulRewards = counters.rows[0]?.successful_rewards ?? 0;
    const requestCeiling = hardCeilingFor(limits, 'REQUEST');
    const successCeiling = hardCeilingFor(limits, 'SUCCESS');

    const monetary = evaluateProviderMonetaryEligibility({
      providerId: facts.providerId,
      providerCode: facts.providerCode,
      productionMonetaryStatus: facts.productionMonetaryStatus,
      cashRewardPolicyApproved: facts.capabilities.cashRewardPolicyApproved,
      serverSignalAuthentication: facts.capabilities.serverSignalAuthentication,
      sessionOrImpressionCorrelation: facts.capabilities.sessionOrImpressionCorrelation,
      health: facts.health.status,
      openClarificationCount: facts.openClarificationCount,
      requestHardLimitExceeded: requestCeiling !== null && providerRequests > requestCeiling,
      successHardLimitExceeded: successCeiling !== null && successfulRewards >= successCeiling,
      signalAuthenticity: providerConfirmation.authenticity,
      signalCorrelation: providerConfirmation.correlation,
    });

    if (!monetary.eligible) {
      await appendAdSessionSignal(client, {
        adSessionId: row.id,
        source: 'SYSTEM',
        signalType: 'MONETARY_GATE_BLOCKED',
        occurredAt: asOf,
        correlation: 'CORRELATED',
        safePayload: {
          status: monetary.status,
          reasonCodes: monetary.reasonCodes.join(','),
        },
      });
      const signalsAfter = await listAdSessionSignals(client, row.id);
      const derived = await deriveAndPersist(client, row, signalsAfter, asOf, {
        verificationPassed: false,
        rewardCommitted: false,
      });
      return {
        adSessionId: row.id,
        state: derived.state,
        issued: false,
        alreadyRewarded: false,
        monetary,
        reward: null,
        reasonCodes: monetary.reasonCodes,
      };
    }

    const rewardQuoteId = row.reward_quote_id;
    if (rewardQuoteId === null) {
      throw new AdsDomainError('QUOTE_MISSING', 'session has no reward quote to consume', {
        details: { adSessionId: row.id },
      });
    }

    await appendAdSessionSignal(client, {
      adSessionId: row.id,
      source: 'SYSTEM',
      signalType: 'VERIFICATION_PASSED',
      occurredAt: asOf,
      correlation: 'CORRELATED',
      safePayload: { rewardQuoteId },
    });
    await persistSessionState(client, row.id, 'VERIFIED', asOf, null);

    const reward = await issueAdReward(client, {
      quoteId: rewardQuoteId,
      userId: row.user_id,
      adSessionId: row.id,
      idempotencyKey: input.idempotencyKey ?? `${AD_REWARD_IDEMPOTENCY_PREFIX}/${row.id}`,
      asOf,
    });

    // issueAdReward atomically posts ledger, consumes budget, increments success counter,
    // and transitions the session to REWARDED. Append evidence only.
    await appendAdSessionSignal(client, {
      adSessionId: row.id,
      source: 'SYSTEM',
      signalType: 'REWARD_COMMITTED',
      occurredAt: asOf,
      correlation: 'CORRELATED',
      safePayload: {
        rewardQuoteId,
        baseRewardEventId: reward.baseRewardEventId,
        amountAtomic: reward.baseAmountAtomic,
      },
    });

    return {
      adSessionId: row.id,
      state: 'REWARDED',
      issued: true,
      alreadyRewarded: false,
      monetary,
      reward,
      reasonCodes: [],
    };
  });
}

/**
 * Record a terminal non-reward outcome (NO_FILL / FAILED / SKIPPED).
 *
 * No money is created, and the reward quote's budget reservation is released when that is
 * safe: the quote must still be OPEN and the source must not have an authoritative start.
 * A protected start is left alone so a started-then-failed session cannot silently drop a
 * reservation that issuance may still need.
 */
export async function recordAdSessionOutcome(
  db: AdsDb,
  input: RecordAdSessionOutcomeInput,
): Promise<RecordAdSessionOutcomeResult> {
  return withLedgerTransaction(db, async (client) => {
    const asOf = input.asOf ?? new Date();
    const row = await lockSession(client, input.adSessionId);
    assertSessionOwnedBy(row, input.userId);

    if (isTerminalAdSessionState(row.state)) {
      return {
        adSessionId: row.id,
        state: row.state,
        quoteReleased: false,
        reasonCodes: ['TERMINAL_STATE_IMMUTABLE'],
      };
    }

    const signalType: AdSignalType =
      input.outcome === 'NO_FILL'
        ? 'NO_FILL'
        : input.outcome === 'SKIPPED'
          ? 'USER_SKIPPED'
          : 'TECHNICAL_FAILURE';

    await appendAdSessionSignal(client, {
      adSessionId: row.id,
      source: input.source ?? 'CLIENT',
      signalType,
      occurredAt: asOf,
      correlation: 'CORRELATED',
      safePayload: { outcome: input.outcome, failureCode: input.failureCode ?? null },
    });

    const signals = await listAdSessionSignals(client, row.id);
    const derived = await deriveAndPersist(client, row, signals, asOf, {
      verificationPassed: false,
      rewardCommitted: false,
      failureCode: input.failureCode ?? input.outcome,
    });

    let quoteReleased = false;
    if (row.reward_quote_id !== null && isTerminalAdSessionState(derived.state)) {
      quoteReleased = await releaseAdSessionQuote(client, {
        rewardQuoteId: row.reward_quote_id,
        adSessionId: row.id,
        asOf,
        reason: input.outcome,
      });
    }

    return {
      adSessionId: row.id,
      state: derived.state,
      quoteReleased,
      reasonCodes: derived.reasonCodes,
    };
  });
}

/**
 * Expire a stale session. Evidence-window expiry is a terminal, non-monetary outcome;
 * it never rewrites an earlier fact and never reverses an issued reward.
 */
export async function expireAdSession(
  db: AdsDb,
  input: { readonly adSessionId: string; readonly asOf?: Date },
): Promise<RecordAdSessionOutcomeResult> {
  return withLedgerTransaction(db, async (client) => {
    const asOf = input.asOf ?? new Date();
    const row = await lockSession(client, input.adSessionId);

    if (isTerminalAdSessionState(row.state)) {
      return {
        adSessionId: row.id,
        state: row.state,
        quoteReleased: false,
        reasonCodes: ['TERMINAL_STATE_IMMUTABLE'],
      };
    }
    if (asOf.getTime() <= row.expires_at.getTime()) {
      throw new AdsDomainError('VALIDATION', 'ad session evidence window has not closed yet', {
        details: { expiresAt: row.expires_at.toISOString(), asOf: asOf.toISOString() },
      });
    }

    await appendAdSessionSignal(client, {
      adSessionId: row.id,
      source: 'SYSTEM',
      signalType: 'SESSION_EXPIRED',
      occurredAt: asOf,
      correlation: 'CORRELATED',
      safePayload: { expiresAt: row.expires_at.toISOString() },
    });
    await persistSessionState(client, row.id, 'EXPIRED', asOf, 'SESSION_EXPIRED');

    let quoteReleased = false;
    if (row.reward_quote_id !== null) {
      quoteReleased = await releaseAdSessionQuote(client, {
        rewardQuoteId: row.reward_quote_id,
        adSessionId: row.id,
        asOf,
        reason: 'EXPIRED',
      });
    }

    return {
      adSessionId: row.id,
      state: 'EXPIRED',
      quoteReleased,
      reasonCodes: ['EVIDENCE_WINDOW_EXPIRED'],
    };
  });
}

interface ReleaseAdSessionQuoteInput {
  readonly rewardQuoteId: string;
  readonly adSessionId: string;
  readonly asOf: Date;
  readonly reason: string;
}

/**
 * Release a quote's reservations through the Reward Engine primitives. This cancels a
 * promise, it does not move money — packages/ads never posts a ledger transaction.
 */
async function releaseAdSessionQuote(
  client: PoolClient,
  input: ReleaseAdSessionQuoteInput,
): Promise<boolean> {
  const quote = await client.query<{
    id: string;
    status: string;
    source_started_at: Date | null;
  }>(
    `SELECT id, status::text AS status, source_started_at
     FROM reward_quotes
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.rewardQuoteId],
  );
  const row = quote.rows[0];
  if (row === undefined || row.status !== 'OPEN' || row.source_started_at !== null) {
    return false;
  }

  const baseReservation = await client.query<{ id: string; state: string }>(
    `SELECT id, state::text AS state FROM reward_budget_reservations
     WHERE reward_quote_id = $1::uuid FOR UPDATE`,
    [input.rewardQuoteId],
  );
  const baseRow = baseReservation.rows[0];
  if (baseRow !== undefined && baseRow.state === 'ACTIVE') {
    await releaseRewardBudgetReservation(client, baseRow.id);
  }

  const bonusReservations = await client.query<{ id: string; state: string }>(
    `SELECT id, state::text AS state FROM membership_bonus_budget_reservations
     WHERE reward_quote_id = $1::uuid
     ORDER BY id
     FOR UPDATE`,
    [input.rewardQuoteId],
  );
  for (const bonusRow of bonusReservations.rows) {
    if (bonusRow.state === 'ACTIVE') {
      await releaseMembershipBonusBudgetReservation(client, bonusRow.id);
    }
  }

  await releaseExposureReservationsForQuote(client, input.rewardQuoteId);

  await client.query(
    `UPDATE reward_quotes
     SET status = 'CANCELLED', cancelled_at = $2::timestamptz, updated_at = now()
     WHERE id = $1::uuid`,
    [input.rewardQuoteId, input.asOf.toISOString()],
  );

  await insertOutboxEvent(client, {
    aggregateType: 'reward_quote',
    aggregateId: input.rewardQuoteId,
    eventType: 'reward_quote.cancelled',
    dedupeKey: `ad-session-quote-cancelled/${input.adSessionId}`,
    payload: {
      quoteId: input.rewardQuoteId,
      adSessionId: input.adSessionId,
      reason: input.reason,
    },
  });

  return true;
}

export async function getAdSession(db: AdsDb, adSessionId: string): Promise<AdSessionRecord> {
  return withLedgerTransaction(db, async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM ad_sessions WHERE id = $1::uuid`,
      [adSessionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AdsDomainError('SESSION_NOT_FOUND', 'ad session not found', {
        details: { adSessionId },
      });
    }
    return toSessionRecord(row);
  });
}

/** Deterministic idempotency key for an ad reward issuance attempt. */
export function adRewardIdempotencyKey(adSessionId: string): string {
  return `${AD_REWARD_IDEMPOTENCY_PREFIX}/${adSessionId}`;
}

/** Fresh correlation id for operational logs that must not reuse a session id. */
export function newAdOperationId(): string {
  return randomUUID();
}
