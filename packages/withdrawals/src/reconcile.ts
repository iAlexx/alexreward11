import type { PoolClient } from 'pg';

import type { WithdrawalEngineConfig } from './config.js';
import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import type { FakePayoutObservation } from './fake-chain.js';
import { settleWithdrawalReservation } from './settlement.js';
import { transitionWithdrawal } from './transitions.js';
import type { WithdrawalState } from './state-machine.js';

export type ReconcileResolution =
  'UNRESOLVED' | 'INTENDED_PAYOUT_PROVEN' | 'DEFINITIVE_NONPAYMENT' | 'AMBIGUOUS';

export interface ReconcileWithdrawalAttemptInput {
  readonly withdrawalId: string;
  readonly attemptId: string;
  /** Legacy/explicit resolution path (skips observation match when set without observation). */
  readonly resolution?: ReconcileResolution;
  readonly evidenceSummary?: Readonly<Record<string, unknown>>;
  readonly observedRecipient?: string | null;
  readonly observedAmountAtomic?: string | null;
  readonly observedAssetSymbol?: string | null;
  readonly observedQueryId?: string | null;
  readonly correlationReference?: string | null;
  /** Preferred: match observation against expected intent fields. */
  readonly observation?: FakePayoutObservation;
  /** Force resolution after observation match (e.g. DEFINITIVE_NONPAYMENT / AMBIGUOUS). */
  readonly forceResolution?: ReconcileResolution;
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
 * asset symbol USDT, query_id. Wrong any field → not INTENDED_PAYOUT_PROVEN.
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
 * Append-only reconciliation evidence. Resolves RECONCILE_REQUIRED toward
 * CONFIRMED / QUEUED / HELD (held_from_reconcile) / remain RECONCILE_REQUIRED.
 */
export async function reconcileWithdrawalAttempt(
  db: WithdrawalDb,
  configOrInput: WithdrawalEngineConfig | ReconcileWithdrawalAttemptInput,
  maybeInput?: ReconcileWithdrawalAttemptInput,
): Promise<ReconcileWithdrawalAttemptResult> {
  const input =
    maybeInput !== undefined ? maybeInput : (configOrInput as ReconcileWithdrawalAttemptInput);
  const config = maybeInput !== undefined ? (configOrInput as WithdrawalEngineConfig) : undefined;

  return withWithdrawalTransaction(db, async (client) =>
    reconcileWithdrawalAttemptInTxn(client, config, input),
  );
}

export async function reconcileWithdrawalAttemptInTxn(
  client: PoolClient,
  configOrInput: WithdrawalEngineConfig | ReconcileWithdrawalAttemptInput | undefined,
  maybeInput?: ReconcileWithdrawalAttemptInput,
): Promise<ReconcileWithdrawalAttemptResult> {
  // Support: (client, input) and (client, config, input)
  let config: WithdrawalEngineConfig | undefined;
  let input: ReconcileWithdrawalAttemptInput;
  if (maybeInput !== undefined) {
    config = configOrInput as WithdrawalEngineConfig | undefined;
    input = maybeInput;
  } else {
    input = configOrInput as ReconcileWithdrawalAttemptInput;
  }

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

  const attempt = await client.query<{
    id: string;
    query_id: string;
  }>(`SELECT id, query_id::text FROM withdrawal_attempts WHERE id = $1::uuid`, [input.attemptId]);
  if (attempt.rows[0] === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Attempt not found');
  }

  const wallet = await client.query<{ friendly_address: string; raw_address: string }>(
    `SELECT friendly_address, raw_address FROM user_wallets WHERE id = $1::uuid`,
    [w.wallet_id],
  );
  const expectedRecipient = wallet.rows[0]?.friendly_address ?? wallet.rows[0]?.raw_address ?? '';
  const expectedAssetSymbol = config?.usdtSymbol ?? 'USDT';

  const observedRecipient = input.observation?.recipientAddress ?? input.observedRecipient ?? null;
  const observedAmountAtomic =
    input.observation?.amountAtomic ?? input.observedAmountAtomic ?? null;
  const observedAssetSymbol = input.observation?.assetSymbol ?? input.observedAssetSymbol ?? null;
  const observedQueryId =
    input.observation !== undefined
      ? input.observation.queryId.toString(10)
      : (input.observedQueryId ?? null);
  const correlationReference =
    input.observation?.correlationReference ?? input.correlationReference ?? null;

  let resolution: ReconcileResolution;
  if (input.forceResolution !== undefined) {
    resolution = input.forceResolution;
  } else if (input.resolution !== undefined && input.observation === undefined) {
    resolution = input.resolution;
  } else if (
    input.observation?.phase === 'CONFIRMED' ||
    input.resolution === 'INTENDED_PAYOUT_PROVEN'
  ) {
    const matched = matchIntendedPayout({
      expectedRecipient,
      expectedNetAtomic: w.net_amount_atomic,
      expectedAssetSymbol,
      expectedQueryId: attempt.rows[0].query_id,
      observedRecipient,
      observedAmountAtomic,
      observedAssetSymbol,
      observedQueryId,
    });
    resolution = matched ? 'INTENDED_PAYOUT_PROVEN' : 'AMBIGUOUS';
  } else if (input.observation?.phase === 'DEFINITIVE_NONPAYMENT') {
    resolution = 'DEFINITIVE_NONPAYMENT';
  } else if (input.resolution !== undefined) {
    resolution = input.resolution;
  } else {
    resolution = 'AMBIGUOUS';
  }

  // If caller claimed INTENDED_PAYOUT_PROVEN explicitly, still enforce field match.
  if (resolution === 'INTENDED_PAYOUT_PROVEN') {
    const matched = matchIntendedPayout({
      expectedRecipient,
      expectedNetAtomic: w.net_amount_atomic,
      expectedAssetSymbol,
      expectedQueryId: attempt.rows[0].query_id,
      observedRecipient,
      observedAmountAtomic,
      observedAssetSymbol,
      observedQueryId,
    });
    if (!matched) {
      resolution = 'AMBIGUOUS';
    }
  }

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
        phase: input.observation?.phase,
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
    // Owner may choose QUEUED (retry) or HELD with evidence; V1 holds for Owner reject.
    await transitionWithdrawal(client, {
      id: w.id,
      from: 'RECONCILE_REQUIRED',
      to: 'HELD',
      setHeldFromReconcile: true,
    });
    state = 'HELD';
  } else if (resolution === 'AMBIGUOUS' && w.state === 'RECONCILE_REQUIRED') {
    // Remain RECONCILE_REQUIRED — durable evidence only. Optionally escalate to HELD.
    state = 'RECONCILE_REQUIRED';
  } else if (resolution === 'DEFINITIVE_NONPAYMENT' && w.state === 'HELD') {
    // Evidence recorded; reject still requires explicit decideWithdrawal with proof.
    state = 'HELD';
  }

  return { reconciliationId, resolution, state };
}
