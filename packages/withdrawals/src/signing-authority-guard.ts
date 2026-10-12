import type { PoolClient } from 'pg';

import { assertHotWalletDispatchFence } from './hot-wallet-dispatch-lease.js';
import { WithdrawalDomainError } from './errors.js';
import { SIGNER_HTTP_VALID_UNTIL_MARGIN_MS } from './signer-http-timeouts.js';
import type { WithdrawalState } from './state-machine.js';

export const SIGNING_RESUME_NO_BOC_OWNER_RECOVERY =
  'SIGNING_RESUME_NO_BOC_REQUIRES_OWNER_RECOVERY' as const;
export const SIGNING_RESUME_EXPIRED_NO_BOC_OWNER_RECOVERY =
  'SIGNING_RESUME_EXPIRED_NO_BOC_OWNER_RECOVERY' as const;
export const SIGNING_LATE_COMPLETION_REJECTED =
  'SIGNING_LATE_COMPLETION_REJECTED' as const;

export interface AssertMayCommitSignedBocInput {
  readonly withdrawalId: string;
  readonly attemptId: string;
  readonly hotWalletId: string;
  readonly fencingToken: bigint;
  readonly ownerIdentity: string;
  readonly cancellationSignal?: AbortSignal;
  readonly nowMs?: number;
  readonly validUntilMarginMs?: number;
}

export type AssertMayCommitSignedBocResult =
  | { readonly ok: true; readonly validUntil: Date }
  | {
      readonly ok: false;
      readonly reason: typeof SIGNING_LATE_COMPLETION_REJECTED;
      readonly detail: string;
    };

/**
 * Re-check authority immediately before persisting a signed BOC or claiming broadcast.
 * Rejects cancelled activities, expired attempts, lost fences, and incompatible state.
 */
export async function assertMayCommitSignedBoc(
  client: PoolClient,
  input: AssertMayCommitSignedBocInput,
): Promise<AssertMayCommitSignedBocResult> {
  if (input.cancellationSignal?.aborted === true) {
    return {
      ok: false,
      reason: SIGNING_LATE_COMPLETION_REJECTED,
      detail: 'activity_cancelled',
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const marginMs = input.validUntilMarginMs ?? SIGNER_HTTP_VALID_UNTIL_MARGIN_MS;

  const withdrawal = await client.query<{ state: WithdrawalState }>(
    `SELECT state FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
    [input.withdrawalId],
  );
  const state = withdrawal.rows[0]?.state;
  if (state !== 'SIGNING' && state !== 'BROADCASTING') {
    return {
      ok: false,
      reason: SIGNING_LATE_COMPLETION_REJECTED,
      detail: `withdrawal_state_${state ?? 'missing'}`,
    };
  }

  const attempt = await client.query<{
    valid_until: Date;
    signed_external_message_boc: string | null;
    broadcast_submitted_at: Date | null;
    dispatch_fencing_token: string;
  }>(
    `SELECT valid_until, signed_external_message_boc, broadcast_submitted_at,
            dispatch_fencing_token::text AS dispatch_fencing_token
     FROM withdrawal_attempts
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.attemptId],
  );
  const row = attempt.rows[0];
  if (row === undefined) {
    return {
      ok: false,
      reason: SIGNING_LATE_COMPLETION_REJECTED,
      detail: 'attempt_missing',
    };
  }

  if (row.broadcast_submitted_at !== null) {
    return {
      ok: false,
      reason: SIGNING_LATE_COMPLETION_REJECTED,
      detail: 'broadcast_already_submitted',
    };
  }

  if (BigInt(row.dispatch_fencing_token) !== input.fencingToken) {
    return {
      ok: false,
      reason: SIGNING_LATE_COMPLETION_REJECTED,
      detail: 'fencing_token_mismatch',
    };
  }

  const validUntilMs = row.valid_until.getTime();
  if (validUntilMs - marginMs <= nowMs) {
    return {
      ok: false,
      reason: SIGNING_LATE_COMPLETION_REJECTED,
      detail: 'valid_until_margin_exhausted',
    };
  }

  try {
    await assertHotWalletDispatchFence(client, {
      hotWalletId: input.hotWalletId,
      fencingToken: input.fencingToken,
      ownerIdentity: input.ownerIdentity,
    });
  } catch (error) {
    if (error instanceof WithdrawalDomainError) {
      return {
        ok: false,
        reason: SIGNING_LATE_COMPLETION_REJECTED,
        detail: 'dispatch_fence_lost',
      };
    }
    throw error;
  }

  return { ok: true, validUntil: row.valid_until };
}

export function classifySigningResumeWithoutBoc(input: {
  readonly validUntil: Date;
  readonly nowMs?: number;
  readonly validUntilMarginMs?: number;
}): {
  readonly reason:
    | typeof SIGNING_RESUME_NO_BOC_OWNER_RECOVERY
    | typeof SIGNING_RESUME_EXPIRED_NO_BOC_OWNER_RECOVERY;
  readonly expired: boolean;
} {
  const nowMs = input.nowMs ?? Date.now();
  const marginMs = input.validUntilMarginMs ?? SIGNER_HTTP_VALID_UNTIL_MARGIN_MS;
  const expired = input.validUntil.getTime() - marginMs <= nowMs;
  return {
    expired,
    reason: expired
      ? SIGNING_RESUME_EXPIRED_NO_BOC_OWNER_RECOVERY
      : SIGNING_RESUME_NO_BOC_OWNER_RECOVERY,
  };
}
