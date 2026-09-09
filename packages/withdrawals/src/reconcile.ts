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

/**
 * Runtime reconciliation input — observation must come from the authoritative
 * FakePayoutChain (or later real chain adapter). Callers cannot inject resolution.
 */
export interface ReconcileWithdrawalAttemptInput {
  readonly withdrawalId: string;
  readonly attemptId: string;
  /** Authoritative chain-adapter observation. Required for runtime reconcile. */
  readonly observation: FakePayoutObservation;
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

function deriveResolution(input: {
  readonly observation: FakePayoutObservation;
  readonly expectedRecipient: string;
  readonly expectedNetAtomic: string;
  readonly expectedAssetSymbol: string;
  readonly expectedQueryId: string;
}): ReconcileResolution {
  const obs = input.observation;
  if (obs.phase === 'CONFIRMED') {
    const matched = matchIntendedPayout({
      expectedRecipient: input.expectedRecipient,
      expectedNetAtomic: input.expectedNetAtomic,
      expectedAssetSymbol: input.expectedAssetSymbol,
      expectedQueryId: input.expectedQueryId,
      observedRecipient: obs.recipientAddress,
      observedAmountAtomic: obs.amountAtomic,
      observedAssetSymbol: obs.assetSymbol,
      observedQueryId: obs.queryId.toString(10),
    });
    return matched ? 'INTENDED_PAYOUT_PROVEN' : 'AMBIGUOUS';
  }
  if (obs.phase === 'DEFINITIVE_NONPAYMENT') {
    return 'DEFINITIVE_NONPAYMENT';
  }
  return 'AMBIGUOUS';
}

/**
 * Append-only reconciliation evidence. Resolution is derived ONLY from the
 * authoritative observation — never from caller-supplied resolution flags.
 */
export async function reconcileWithdrawalAttempt(
  db: WithdrawalDb,
  config: WithdrawalEngineConfig,
  input: ReconcileWithdrawalAttemptInput,
): Promise<ReconcileWithdrawalAttemptResult> {
  return withWithdrawalTransaction(db, async (client) =>
    reconcileWithdrawalAttemptInTxn(client, config, input),
  );
}

export async function reconcileWithdrawalAttemptInTxn(
  client: PoolClient,
  config: WithdrawalEngineConfig | undefined,
  input: ReconcileWithdrawalAttemptInput,
): Promise<ReconcileWithdrawalAttemptResult> {
  if (input.observation === undefined || input.observation === null) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'Authoritative chain observation is required for reconciliation',
    );
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

  const resolution = deriveResolution({
    observation: input.observation,
    expectedRecipient,
    expectedNetAtomic: w.net_amount_atomic,
    expectedAssetSymbol,
    expectedQueryId: attempt.rows[0].query_id,
  });

  const observedRecipient = input.observation.recipientAddress;
  const observedAmountAtomic = input.observation.amountAtomic;
  const observedAssetSymbol = input.observation.assetSymbol;
  const observedQueryId = input.observation.queryId.toString(10);
  const correlationReference = input.observation.correlationReference;
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
        phase: input.observation.phase,
        derivedOnly: true,
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
