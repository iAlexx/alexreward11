import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export type BroadcastAmbiguityClass =
  'RPC_TIMEOUT' | 'CRASH_AFTER_SUBMIT' | 'PROVIDER_DISAGREE' | 'UNKNOWN_SUBMIT_OUTCOME';

export type BroadcastSubmitClassification =
  | { readonly kind: 'FAILED_PRE_BROADCAST'; readonly reason: string }
  | {
      readonly kind: 'UNKNOWN';
      readonly ambiguityClass: BroadcastAmbiguityClass;
      readonly reason: string;
    }
  | { readonly kind: 'BROADCASTED'; readonly providerReference?: string };

export interface PersistPreBroadcastEvidenceInput {
  readonly attemptId: string;
  readonly signedExternalMessageBoc: string;
  readonly signedWalletRequestBoc: string;
  readonly externalMessageCellHash: string;
  readonly normalizedExternalMessageHash: string;
}

/**
 * Persist signed request, final BOC, and both message hashes BEFORE calling sendBoc.
 * Never call sendBoc until this returns successfully.
 */
export async function persistPreBroadcastEvidence(
  client: PoolClient,
  input: PersistPreBroadcastEvidenceInput,
): Promise<void> {
  if (input.signedExternalMessageBoc.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'signedExternalMessageBoc is required');
  }
  if (input.signedWalletRequestBoc.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'signedWalletRequestBoc is required');
  }
  if (input.externalMessageCellHash.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'externalMessageCellHash is required');
  }
  if (input.normalizedExternalMessageHash.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'normalizedExternalMessageHash is required');
  }

  const existing = await client.query<{
    signed_external_message_boc: string | null;
    broadcast_submitted_at: Date | null;
    broadcast_ambiguity_class: string | null;
    broadcast_result_state: string;
  }>(
    `SELECT signed_external_message_boc, broadcast_submitted_at, broadcast_ambiguity_class,
            broadcast_result_state::text AS broadcast_result_state
     FROM withdrawal_attempts
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.attemptId],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Attempt not found');
  }
  if (row.broadcast_submitted_at !== null || row.broadcast_ambiguity_class !== null) {
    throw new WithdrawalDomainError(
      'RECONCILE_REQUIRED',
      'Blind resend forbidden: broadcast already submitted or ambiguous',
      {
        details: {
          broadcastSubmittedAt: row.broadcast_submitted_at,
          ambiguityClass: row.broadcast_ambiguity_class,
        },
      },
    );
  }

  const result = await client.query(
    `UPDATE withdrawal_attempts SET
       signed_external_message_boc = $2,
       signed_wallet_request_boc = $3,
       external_message_cell_hash = $4,
       normalized_external_message_hash = $5,
       signed_message_hash = $5,
       updated_at = now()
     WHERE id = $1::uuid`,
    [
      input.attemptId,
      input.signedExternalMessageBoc,
      input.signedWalletRequestBoc,
      input.externalMessageCellHash,
      input.normalizedExternalMessageHash,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new WithdrawalDomainError('VALIDATION', 'Attempt not found');
  }
}

/**
 * Mark that sendBoc was invoked. After this, FAILED_PRE_BROADCAST is impossible
 * and blind resend is forbidden.
 */
export async function markBroadcastSubmitted(
  client: PoolClient,
  input: {
    readonly attemptId: string;
    readonly ambiguityClass?: BroadcastAmbiguityClass | null;
    readonly broadcastResultState?: 'BROADCASTED' | 'UNKNOWN' | 'RECONCILE_REQUIRED';
    readonly chainReference?: string | null;
  },
): Promise<void> {
  const state = input.broadcastResultState ?? 'UNKNOWN';
  const result = await client.query(
    `UPDATE withdrawal_attempts SET
       broadcast_submitted_at = COALESCE(broadcast_submitted_at, now()),
       broadcast_started_at = COALESCE(broadcast_started_at, now()),
       broadcast_ambiguity_class = COALESCE($2, broadcast_ambiguity_class),
       broadcast_result_state = $3::withdrawal_attempt_result,
       chain_reference = COALESCE($4, chain_reference),
       updated_at = now()
     WHERE id = $1::uuid`,
    [input.attemptId, input.ambiguityClass ?? null, state, input.chainReference ?? null],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new WithdrawalDomainError('VALIDATION', 'Attempt not found');
  }
}

export async function assertBlindResendForbidden(
  client: PoolClient,
  attemptId: string,
): Promise<void> {
  const result = await client.query<{
    broadcast_submitted_at: Date | null;
    broadcast_ambiguity_class: string | null;
    broadcast_result_state: string;
  }>(
    `SELECT broadcast_submitted_at, broadcast_ambiguity_class,
            broadcast_result_state::text AS broadcast_result_state
     FROM withdrawal_attempts
     WHERE id = $1::uuid`,
    [attemptId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Attempt not found');
  }
  if (
    row.broadcast_submitted_at !== null ||
    row.broadcast_ambiguity_class !== null ||
    row.broadcast_result_state === 'BROADCASTED' ||
    row.broadcast_result_state === 'UNKNOWN' ||
    row.broadcast_result_state === 'RECONCILE_REQUIRED'
  ) {
    throw new WithdrawalDomainError(
      'RECONCILE_REQUIRED',
      'Blind resend forbidden after possible broadcast or ambiguity',
      {
        details: {
          broadcastSubmittedAt: row.broadcast_submitted_at,
          ambiguityClass: row.broadcast_ambiguity_class,
          state: row.broadcast_result_state,
        },
      },
    );
  }
}

/**
 * Classify RPC / crash outcomes for broadcast gate.
 * Timeout / crash-after-submit → UNKNOWN (never FAILED_PRE_BROADCAST).
 */
export function classifySubmitError(error: unknown): BroadcastSubmitClassification {
  const message = error instanceof Error ? error.message : String(error);
  const upper = message.toUpperCase();

  if (
    upper.includes('TIMEOUT') ||
    upper.includes('ETIMEDOUT') ||
    upper.includes('ECONNRESET') ||
    upper.includes('FETCH FAILED') ||
    upper.includes('NETWORK')
  ) {
    return {
      kind: 'UNKNOWN',
      ambiguityClass: 'RPC_TIMEOUT',
      reason: message,
    };
  }
  if (upper.includes('CRASH_AFTER_SUBMIT') || upper.includes('AFTER_SUBMIT')) {
    return {
      kind: 'UNKNOWN',
      ambiguityClass: 'CRASH_AFTER_SUBMIT',
      reason: message,
    };
  }
  if (upper.includes('PROVIDER_DISAGREE') || upper.includes('DISAGREE')) {
    return {
      kind: 'UNKNOWN',
      ambiguityClass: 'PROVIDER_DISAGREE',
      reason: message,
    };
  }
  if (
    upper.includes('PRE_SUBMIT') ||
    upper.includes('PRE_BROADCAST') ||
    upper.includes('FAKE_PROVIDER_PRE_SUBMIT')
  ) {
    return { kind: 'FAILED_PRE_BROADCAST', reason: message };
  }
  // Conservative default: treat as ambiguous if we cannot prove pre-broadcast.
  return {
    kind: 'UNKNOWN',
    ambiguityClass: 'UNKNOWN_SUBMIT_OUTCOME',
    reason: message,
  };
}

export const broadcastGate = {
  persistPreBroadcastEvidence,
  markBroadcastSubmitted,
  assertBlindResendForbidden,
  classifySubmitError,
} as const;
