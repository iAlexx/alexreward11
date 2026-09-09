import type { PoolClient } from 'pg';

import type { WithdrawalEngineConfig } from './config.js';
import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import {
  fakeCorrelationReference,
  isAuthoritativePayoutObservation,
  type AuthoritativePayoutObservation,
  type FakePayoutObservation,
  type PayoutChainAdapter,
} from './fake-chain.js';
import { settleWithdrawalReservation } from './settlement.js';
import { transitionWithdrawal } from './transitions.js';
import type { WithdrawalState } from './state-machine.js';

export type ReconcileResolution =
  'UNRESOLVED' | 'INTENDED_PAYOUT_PROVEN' | 'DEFINITIVE_NONPAYMENT' | 'AMBIGUOUS';

export interface ReconcileFromAdapterInput {
  readonly withdrawalId: string;
  readonly attemptId: string;
  readonly evidenceSummary?: Readonly<Record<string, unknown>>;
}

export interface ReconcileWithdrawalAttemptResult {
  readonly reconciliationId: string;
  readonly resolution: ReconcileResolution;
  readonly state: WithdrawalState;
}

function addressesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Match observation vs expected recipient (wallet address), net amount,
 * asset symbol, query_id. Wrong any field → not INTENDED_PAYOUT_PROVEN.
 */
export function matchIntendedPayout(input: {
  readonly expectedRecipient: string;
  readonly expectedNetAtomic: string;
  readonly expectedAssetSymbol: string;
  readonly expectedQueryId: string;
  readonly observedRecipient: string | null | undefined;
  readonly observedAmountAtomic: string | null | undefined;
  readonly observedAssetSymbol: string | null | undefined;
  readonly observedQueryId: string | null | undefined;
}): boolean {
  if (
    input.observedRecipient == null ||
    input.observedAmountAtomic == null ||
    input.observedAssetSymbol == null ||
    input.observedQueryId == null
  ) {
    return false;
  }
  if (!addressesEqual(input.observedRecipient, input.expectedRecipient)) {
    return false;
  }
  if (input.observedAmountAtomic !== input.expectedNetAtomic) {
    return false;
  }
  if (input.observedAssetSymbol !== input.expectedAssetSymbol) {
    return false;
  }
  if (input.observedQueryId !== input.expectedQueryId) {
    return false;
  }
  return true;
}

/**
 * Prove observation belongs to the exact expected payout attempt.
 * Required before INTENDED_PAYOUT_PROVEN or DEFINITIVE_NONPAYMENT.
 */
export function observationMatchesExpectedAttempt(input: {
  readonly observation: AuthoritativePayoutObservation;
  readonly expectedWithdrawalId: string;
  readonly expectedAttemptId: string;
  readonly expectedRecipient: string;
  readonly expectedNetAtomic: string;
  readonly expectedAssetSymbol: string;
  readonly expectedQueryId: string;
  readonly expectedCanonicalMessageHash: string;
  readonly expectedAttemptNumber: number;
}): boolean {
  const obs = input.observation;
  if (obs.withdrawalId !== input.expectedWithdrawalId) return false;
  if (obs.attemptId !== input.expectedAttemptId) return false;
  if (obs.queryId.toString(10) !== input.expectedQueryId) return false;
  if (obs.canonicalMessageHash !== input.expectedCanonicalMessageHash) return false;
  if (
    obs.correlationReference !==
    fakeCorrelationReference(input.expectedWithdrawalId, input.expectedAttemptNumber)
  ) {
    return false;
  }
  return matchIntendedPayout({
    expectedRecipient: input.expectedRecipient,
    expectedNetAtomic: input.expectedNetAtomic,
    expectedAssetSymbol: input.expectedAssetSymbol,
    expectedQueryId: input.expectedQueryId,
    observedRecipient: obs.recipientAddress,
    observedAmountAtomic: obs.amountAtomic,
    observedAssetSymbol: obs.assetSymbol,
    observedQueryId: obs.queryId.toString(10),
  });
}

function deriveResolution(input: {
  readonly observation: unknown;
  readonly expectedWithdrawalId: string;
  readonly expectedAttemptId: string;
  readonly expectedRecipient: string;
  readonly expectedNetAtomic: string;
  readonly expectedAssetSymbol: string;
  readonly expectedQueryId: string;
  readonly expectedCanonicalMessageHash: string;
  readonly expectedAttemptNumber: number;
}): ReconcileResolution {
  // TypeScript interface is not a trust boundary — require adapter provenance brand.
  if (!isAuthoritativePayoutObservation(input.observation)) {
    return 'AMBIGUOUS';
  }
  const obs = input.observation;
  const bound = observationMatchesExpectedAttempt({
    observation: obs,
    expectedWithdrawalId: input.expectedWithdrawalId,
    expectedAttemptId: input.expectedAttemptId,
    expectedRecipient: input.expectedRecipient,
    expectedNetAtomic: input.expectedNetAtomic,
    expectedAssetSymbol: input.expectedAssetSymbol,
    expectedQueryId: input.expectedQueryId,
    expectedCanonicalMessageHash: input.expectedCanonicalMessageHash,
    expectedAttemptNumber: input.expectedAttemptNumber,
  });
  if (!bound) {
    // Wrong attempt/withdrawal/query/correlation — never definitive financial proof.
    return 'AMBIGUOUS';
  }
  if (obs.phase === 'CONFIRMED') {
    return 'INTENDED_PAYOUT_PROVEN';
  }
  if (obs.phase === 'DEFINITIVE_NONPAYMENT') {
    return 'DEFINITIVE_NONPAYMENT';
  }
  return 'AMBIGUOUS';
}

/**
 * Runtime reconciliation: obtain observation from the trusted chain adapter only.
 * Callers supply withdrawalId + attemptId — never a self-built financial observation.
 */
export async function reconcileWithdrawalAttemptFromAdapter(
  db: WithdrawalDb,
  config: WithdrawalEngineConfig,
  adapter: PayoutChainAdapter,
  input: ReconcileFromAdapterInput,
): Promise<ReconcileWithdrawalAttemptResult> {
  return withWithdrawalTransaction(db, async (client) =>
    reconcileWithdrawalAttemptFromAdapterInTxn(client, config, adapter, input),
  );
}

export async function reconcileWithdrawalAttemptFromAdapterInTxn(
  client: PoolClient,
  config: WithdrawalEngineConfig,
  adapter: PayoutChainAdapter,
  input: ReconcileFromAdapterInput,
): Promise<ReconcileWithdrawalAttemptResult> {
  const observation = adapter.observeForAttempt({
    withdrawalId: input.withdrawalId,
    attemptId: input.attemptId,
  });
  if (observation === null) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'No authoritative chain observation for withdrawal/attempt',
    );
  }
  return applyObservationInTxn(client, config, {
    withdrawalId: input.withdrawalId,
    attemptId: input.attemptId,
    observation,
    evidenceSummary: {
      ...(input.evidenceSummary ?? {}),
      adapterSourced: true,
    },
  });
}

/**
 * Internal apply path. Accepts only branded authoritative observations.
 * Plain FakePayoutObservation objects resolve to AMBIGUOUS (no definitive proof).
 *
 * NOT exported from the package index. Tests may import this module path to prove
 * forgeability fails closed.
 */
export async function applyObservationInTxn(
  client: PoolClient,
  config: WithdrawalEngineConfig | undefined,
  input: {
    readonly withdrawalId: string;
    readonly attemptId: string;
    readonly observation: unknown;
    readonly evidenceSummary?: Readonly<Record<string, unknown>>;
  },
): Promise<ReconcileWithdrawalAttemptResult> {
  const locked = await client.query<{
    id: string;
    state: WithdrawalState;
    net_amount_atomic: string;
    wallet_id: string;
  }>(
    `SELECT id, state, net_amount_atomic::text, wallet_id
     FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
    [input.withdrawalId],
  );
  const w = locked.rows[0];
  if (w === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
  }
  if (w.state !== 'RECONCILE_REQUIRED' && w.state !== 'HELD' && w.state !== 'QUEUED') {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Reconcile requires RECONCILE_REQUIRED, HELD, or QUEUED',
      { details: { state: w.state } },
    );
  }

  // Exact withdrawal/attempt association — fail closed on mismatch.
  const attempt = await client.query<{
    id: string;
    withdrawal_id: string;
    query_id: string;
    attempt_number: number;
    canonical_message_hash: string;
  }>(
    `SELECT id, withdrawal_id, query_id::text, attempt_number, canonical_message_hash
     FROM withdrawal_attempts
     WHERE id = $1::uuid
       AND withdrawal_id = $2::uuid`,
    [input.attemptId, input.withdrawalId],
  );
  if (attempt.rows[0] === undefined) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'Attempt not found for withdrawal (withdrawal/attempt association failed)',
    );
  }
  const a = attempt.rows[0];

  const wallet = await client.query<{ friendly_address: string; raw_address: string }>(
    `SELECT friendly_address, raw_address FROM user_wallets WHERE id = $1::uuid`,
    [w.wallet_id],
  );
  const expectedRecipient = wallet.rows[0]?.friendly_address ?? wallet.rows[0]?.raw_address ?? '';
  const expectedAssetSymbol = config?.usdtSymbol ?? 'USDT';

  const resolution = deriveResolution({
    observation: input.observation,
    expectedWithdrawalId: input.withdrawalId,
    expectedAttemptId: input.attemptId,
    expectedRecipient,
    expectedNetAtomic: w.net_amount_atomic,
    expectedAssetSymbol,
    expectedQueryId: a.query_id,
    expectedCanonicalMessageHash: a.canonical_message_hash,
    expectedAttemptNumber: a.attempt_number,
  });

  const obsRecord =
    typeof input.observation === 'object' && input.observation !== null
      ? (input.observation as Partial<FakePayoutObservation>)
      : {};
  const observedRecipient =
    typeof obsRecord.recipientAddress === 'string' ? obsRecord.recipientAddress : null;
  const observedAmountAtomic =
    typeof obsRecord.amountAtomic === 'string' ? obsRecord.amountAtomic : null;
  const observedAssetSymbol =
    typeof obsRecord.assetSymbol === 'string' ? obsRecord.assetSymbol : null;
  const observedQueryId =
    typeof obsRecord.queryId === 'bigint'
      ? obsRecord.queryId.toString(10)
      : obsRecord.queryId != null
        ? String(obsRecord.queryId)
        : null;
  const correlationReference =
    typeof obsRecord.correlationReference === 'string' ? obsRecord.correlationReference : null;
  const phase = typeof obsRecord.phase === 'string' ? obsRecord.phase : 'UNKNOWN';
  const resolvedAt = resolution === 'UNRESOLVED' ? null : new Date().toISOString();

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO withdrawal_payout_reconciliations (
       withdrawal_id, withdrawal_attempt_id, resolution, evidence_summary,
       observed_recipient, observed_amount_atomic, observed_asset_symbol,
       observed_query_id, correlation_reference, resolved_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::withdrawal_payout_reconcile_resolution, $4::jsonb,
       $5, $6::bigint, $7, $8::bigint, $9, $10::timestamptz
     )
     RETURNING id`,
    [
      input.withdrawalId,
      input.attemptId,
      resolution,
      JSON.stringify({
        ...(input.evidenceSummary ?? {}),
        phase,
        derivedOnly: true,
        authoritative: isAuthoritativePayoutObservation(input.observation),
      }),
      observedRecipient,
      observedAmountAtomic,
      observedAssetSymbol,
      observedQueryId,
      correlationReference,
      resolvedAt,
    ],
  );
  const reconciliationId = inserted.rows[0]?.id;
  if (reconciliationId === undefined) {
    throw new WithdrawalDomainError('INTERNAL', 'reconciliation insert failed');
  }

  let state: WithdrawalState = w.state;

  if (resolution === 'INTENDED_PAYOUT_PROVEN' && w.state === 'RECONCILE_REQUIRED') {
    await transitionWithdrawal(client, {
      id: w.id,
      from: 'RECONCILE_REQUIRED',
      to: 'CONFIRMED',
    });
    await settleWithdrawalReservation(client, { withdrawalId: w.id });
    state = 'CONFIRMED';
  } else if (resolution === 'DEFINITIVE_NONPAYMENT' && w.state === 'RECONCILE_REQUIRED') {
    await transitionWithdrawal(client, {
      id: w.id,
      from: 'RECONCILE_REQUIRED',
      to: 'HELD',
      setHeldFromReconcile: true,
    });
    state = 'HELD';
  } else if (resolution === 'AMBIGUOUS' && w.state === 'RECONCILE_REQUIRED') {
    state = 'RECONCILE_REQUIRED';
  } else if (resolution === 'DEFINITIVE_NONPAYMENT' && w.state === 'HELD') {
    state = 'HELD';
  }

  return { reconciliationId, resolution, state };
}
