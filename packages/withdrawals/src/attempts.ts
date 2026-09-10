import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export interface WithdrawalAttemptView {
  readonly id: string;
  readonly withdrawalId: string;
  readonly attemptNumber: number;
  readonly hotWalletId: string;
  readonly queryId: string;
  readonly expectedSeqno: string;
  readonly canonicalMessageHash: string;
  readonly dispatchFencingToken: string;
  readonly broadcastResultState: string;
  readonly signerKeyReference: string;
}

const LIVE_ATTEMPT_STATES = ['PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED'] as const;

/**
 * Upsert a test/local dispatch lease with an incrementing fencing token.
 */
export async function acquireTestDispatchLease(
  client: PoolClient,
  hotWalletId: string,
  ownerIdentity: string,
): Promise<{ fencingToken: bigint; expiresAt: Date }> {
  const existing = await client.query<{
    fencing_token: string;
    expires_at: Date;
    released_at: Date | null;
  }>(
    `SELECT fencing_token::text, expires_at, released_at
     FROM hot_wallet_dispatch_leases
     WHERE hot_wallet_id = $1::uuid
     FOR UPDATE`,
    [hotWalletId],
  );

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000);

  if (existing.rows[0] === undefined) {
    const inserted = await client.query<{ fencing_token: string; expires_at: Date }>(
      `INSERT INTO hot_wallet_dispatch_leases (
         hot_wallet_id, owner_identity, fencing_token, expires_at
       ) VALUES ($1::uuid, $2, 1, $3::timestamptz)
       RETURNING fencing_token::text, expires_at`,
      [hotWalletId, ownerIdentity, expiresAt.toISOString()],
    );
    return {
      fencingToken: BigInt(inserted.rows[0]!.fencing_token),
      expiresAt: inserted.rows[0]!.expires_at,
    };
  }

  const nextToken = BigInt(existing.rows[0].fencing_token) + 1n;
  const updated = await client.query<{ fencing_token: string; expires_at: Date }>(
    `UPDATE hot_wallet_dispatch_leases
     SET owner_identity = $2,
         fencing_token = $3::bigint,
         renewed_at = now(),
         expires_at = $4::timestamptz,
         released_at = NULL
     WHERE hot_wallet_id = $1::uuid
     RETURNING fencing_token::text, expires_at`,
    [hotWalletId, ownerIdentity, nextToken.toString(10), expiresAt.toISOString()],
  );
  return {
    fencingToken: BigInt(updated.rows[0]!.fencing_token),
    expiresAt: updated.rows[0]!.expires_at,
  };
}

async function assertLeaseFencing(
  client: PoolClient,
  hotWalletId: string,
  fencingToken: bigint,
): Promise<void> {
  const lease = await client.query<{
    fencing_token: string;
    expires_at: Date;
    released_at: Date | null;
  }>(
    `SELECT fencing_token::text, expires_at, released_at
     FROM hot_wallet_dispatch_leases
     WHERE hot_wallet_id = $1::uuid
     FOR SHARE`,
    [hotWalletId],
  );
  const row = lease.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Dispatch lease missing');
  }
  if (row.released_at !== null) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Dispatch lease released');
  }
  if (row.expires_at.getTime() <= Date.now()) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Dispatch lease expired');
  }
  if (BigInt(row.fencing_token) !== fencingToken) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Dispatch fencing token mismatch');
  }
}

/**
 * Create a payout attempt under a valid dispatch lease fencing token.
 *
 * Fake deterministic fields:
 * - canonical_message_hash = `fake-hash:{withdrawalId}:{attemptNumber}`
 * - query_id unique per hot wallet
 * - expected_seqno deterministic from attempt number
 */
export async function createWithdrawalAttempt(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly hotWalletId: string;
    readonly fencingToken: bigint;
    readonly signerKeyReference: string;
    /** Optional scenario hash inputs for deterministic query_id derivation. */
    readonly scenarioHashInputs?: Readonly<Record<string, string | number>>;
    /**
     * Phase 10 real path: authoritative chain seqno.
     * When omitted, Phase 7 fake path uses attemptNumber as seqno.
     */
    readonly expectedSeqno?: bigint;
    /** Phase 10 real path: immutable query_id. */
    readonly queryId?: bigint;
    /**
     * Phase 10 real path: hex canonical message hash (not `fake-hash:`).
     * When omitted, Phase 7 fake path uses `fake-hash:{withdrawalId}:{attemptNumber}`.
     */
    readonly canonicalMessageHash?: string;
    /** Phase 10 real path: must match the unix timeout used for canonical hash. */
    readonly validUntil?: Date;
  },
): Promise<WithdrawalAttemptView> {
  await assertLeaseFencing(client, input.hotWalletId, input.fencingToken);

  const live = await client.query<{ id: string; broadcast_result_state: string }>(
    `SELECT id, broadcast_result_state::text AS broadcast_result_state
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
       AND broadcast_result_state IN ('PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED')
     FOR UPDATE`,
    [input.withdrawalId],
  );
  if (live.rows[0] !== undefined) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Live payout attempt already exists', {
      details: { attemptId: live.rows[0].id, state: live.rows[0].broadcast_result_state },
    });
  }

  const prior = await client.query<{
    attempt_number: number;
    broadcast_result_state: string;
    broadcast_started_at: Date | null;
  }>(
    `SELECT attempt_number, broadcast_result_state::text AS broadcast_result_state,
            broadcast_started_at
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     ORDER BY attempt_number DESC
     LIMIT 1
     FOR UPDATE`,
    [input.withdrawalId],
  );

  if (prior.rows[0] !== undefined) {
    const last = prior.rows[0];
    const isFailedPre = last.broadcast_result_state === 'FAILED_PRE_BROADCAST';
    const mayHaveBroadcast =
      last.broadcast_started_at !== null ||
      last.broadcast_result_state === 'BROADCASTED' ||
      last.broadcast_result_state === 'UNKNOWN' ||
      last.broadcast_result_state === 'RECONCILE_REQUIRED';

    if (!isFailedPre) {
      // Forbidden new attempt after possible broadcast until reconcile proves retry safety
      // (safe retry is signaled by withdrawal returning to QUEUED with no live attempt).
      if (mayHaveBroadcast) {
        const withdrawal = await client.query<{ state: string }>(
          `SELECT state::text AS state FROM withdrawals WHERE id = $1::uuid`,
          [input.withdrawalId],
        );
        const state = withdrawal.rows[0]?.state;
        if (state !== 'QUEUED') {
          throw new WithdrawalDomainError(
            'STATE_CONFLICT',
            'New attempt forbidden after possible broadcast until reconcile proves retry safety',
            { details: { lastState: last.broadcast_result_state, withdrawalState: state } },
          );
        }
      } else if (
        LIVE_ATTEMPT_STATES.includes(
          last.broadcast_result_state as (typeof LIVE_ATTEMPT_STATES)[number],
        )
      ) {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'Live payout attempt already exists');
      }
    }
  }

  const attemptNumber = (prior.rows[0]?.attempt_number ?? 0) + 1;
  const expectedSeqno = input.expectedSeqno ?? BigInt(attemptNumber);
  // Deterministic unique query_id per hot wallet: pack attempt into high bits + hash salt.
  const salt = input.scenarioHashInputs ? Object.values(input.scenarioHashInputs).join(':') : '';
  const queryId =
    input.queryId ??
    (BigInt(attemptNumber) << 32n) +
      BigInt(
        Math.abs(
          [...`${input.withdrawalId}:${salt}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7),
        ),
      );
  const canonicalMessageHash =
    input.canonicalMessageHash ?? `fake-hash:${input.withdrawalId}:${attemptNumber}`;
  if (
    input.canonicalMessageHash !== undefined &&
    input.canonicalMessageHash.startsWith('fake-hash:')
  ) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'Real payout attempts cannot use fake-hash canonical message hashes',
    );
  }
  const validUntil = input.validUntil ?? new Date(Date.now() + 300_000);

  const inserted = await client.query<{
    id: string;
    withdrawal_id: string;
    attempt_number: number;
    hot_wallet_id: string;
    query_id: string;
    expected_seqno: string;
    canonical_message_hash: string;
    dispatch_fencing_token: string;
    broadcast_result_state: string;
    signer_key_reference: string;
  }>(
    `INSERT INTO withdrawal_attempts (
       withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id,
       valid_until, canonical_message_hash, signer_key_reference,
       dispatch_fencing_token, broadcast_result_state
     ) VALUES (
       $1::uuid, $2, $3::uuid, $4::bigint, $5::bigint,
       $6::timestamptz, $7, $8,
       $9::bigint, 'PENDING'
     )
     RETURNING id, withdrawal_id, attempt_number, hot_wallet_id, query_id::text,
               expected_seqno::text, canonical_message_hash,
               dispatch_fencing_token::text,
               broadcast_result_state::text AS broadcast_result_state,
               signer_key_reference`,
    [
      input.withdrawalId,
      attemptNumber,
      input.hotWalletId,
      expectedSeqno.toString(10),
      queryId.toString(10),
      validUntil.toISOString(),
      canonicalMessageHash,
      input.signerKeyReference,
      input.fencingToken.toString(10),
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('INTERNAL', 'attempt insert failed');
  }
  return {
    id: row.id,
    withdrawalId: row.withdrawal_id,
    attemptNumber: row.attempt_number,
    hotWalletId: row.hot_wallet_id,
    queryId: row.query_id,
    expectedSeqno: row.expected_seqno,
    canonicalMessageHash: row.canonical_message_hash,
    dispatchFencingToken: row.dispatch_fencing_token,
    broadcastResultState: row.broadcast_result_state,
    signerKeyReference: row.signer_key_reference,
  };
}

/** Update attempt lifecycle/broadcast fields only (intent fields immutable). */
export async function updateAttemptBroadcastState(
  client: PoolClient,
  input: {
    readonly attemptId: string;
    readonly broadcastResultState:
      'PENDING' | 'BROADCASTED' | 'FAILED_PRE_BROADCAST' | 'UNKNOWN' | 'RECONCILE_REQUIRED';
    readonly markBroadcastStarted?: boolean;
    readonly chainReference?: string | null;
  },
): Promise<void> {
  const result = await client.query(
    `UPDATE withdrawal_attempts SET
       broadcast_result_state = $2::withdrawal_attempt_result,
       broadcast_started_at = CASE
         WHEN $3::boolean THEN COALESCE(broadcast_started_at, now())
         ELSE broadcast_started_at
       END,
       chain_reference = COALESCE($4, chain_reference),
       updated_at = now()
     WHERE id = $1::uuid`,
    [
      input.attemptId,
      input.broadcastResultState,
      input.markBroadcastStarted === true,
      input.chainReference ?? null,
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new WithdrawalDomainError('VALIDATION', 'Attempt not found');
  }
}
