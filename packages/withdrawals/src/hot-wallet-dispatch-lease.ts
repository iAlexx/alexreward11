/**
 * Hot Wallet dispatch lease + fencing for real payout serialization.
 *
 * Semantics (existing hot_wallet_dispatch_leases schema):
 * - Active lease (unreleased, unexpired) owned by another identity → BUSY (no steal).
 * - Same-owner renew → extend expires_at; fencing_token STABLE.
 * - Expired/released takeover by new owner → increment fencing_token.
 * - Unresolved possibly-broadcast attempts on the wallet block unrelated owners
 *   even if a lease timer expired.
 */
import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export type HotWalletDispatchLeaseAcquireResult =
  | {
      readonly status: 'ACQUIRED';
      readonly fencingToken: bigint;
      readonly expiresAt: Date;
      readonly ownerIdentity: string;
      readonly renewed: boolean;
      readonly tokenIncremented: boolean;
    }
  | {
      readonly status: 'BUSY';
      readonly currentOwnerIdentity: string;
      readonly fencingToken?: bigint;
      readonly expiresAt?: Date;
      readonly reason: string;
    }
  | {
      readonly status: 'BLOCKED_UNRESOLVED';
      readonly reason: string;
    };

export type HotWalletDispatchReleaseReason =
  'FAILED_PRE_BROADCAST' | 'DEFINITIVE_NONPAYMENT' | 'CONFIRMED_SETTLED';

const DEFAULT_LEASE_MS = 120_000;

const UNRESOLVED_BROADCAST_STATES = ['UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED'] as const;

const UNRESOLVED_WITHDRAWAL_STATES = [
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMING',
  'RECONCILE_REQUIRED',
] as const;

export function hotWalletDispatchOwnerIdentity(withdrawalId: string): string {
  return `withdrawal:${withdrawalId}`;
}

export const hotWalletDispatchOwnerForWithdrawal = hotWalletDispatchOwnerIdentity;

export function parseWithdrawalIdFromDispatchOwner(ownerIdentity: string): string | null {
  const prefix = 'withdrawal:';
  if (!ownerIdentity.startsWith(prefix)) return null;
  const id = ownerIdentity.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

async function hasUnresolvedPossiblyBroadcastWork(
  client: PoolClient,
  hotWalletId: string,
  excludeOwnerIdentity: string | null,
): Promise<{ blocked: boolean; reason: string }> {
  const attempts = await client.query<{
    withdrawal_id: string;
    broadcast_result_state: string;
  }>(
    `SELECT a.withdrawal_id::text AS withdrawal_id,
            a.broadcast_result_state::text AS broadcast_result_state
     FROM withdrawal_attempts a
     INNER JOIN withdrawals w ON w.id = a.withdrawal_id
     WHERE a.hot_wallet_id = $1::uuid
       AND a.broadcast_result_state::text <> 'FAILED_PRE_BROADCAST'
       AND (
         a.broadcast_submitted_at IS NOT NULL
         OR a.broadcast_result_state::text = ANY($2::text[])
         OR w.state::text = ANY($3::text[])
       )
       AND NOT EXISTS (
         SELECT 1 FROM withdrawal_payout_reconciliations r
         WHERE r.withdrawal_attempt_id = a.id
           AND r.resolution = 'DEFINITIVE_NONPAYMENT'
       )
       AND NOT (
         w.state::text = 'CONFIRMED'
         AND w.settlement_ledger_tx_id IS NOT NULL
         AND a.settled_at IS NOT NULL
       )`,
    [hotWalletId, [...UNRESOLVED_BROADCAST_STATES], [...UNRESOLVED_WITHDRAWAL_STATES]],
  );

  for (const row of attempts.rows) {
    const owner = hotWalletDispatchOwnerIdentity(row.withdrawal_id);
    if (excludeOwnerIdentity !== null && owner === excludeOwnerIdentity) {
      continue;
    }
    return {
      blocked: true,
      reason: `unresolved_attempt:${row.broadcast_result_state}:${row.withdrawal_id}`,
    };
  }

  return { blocked: false, reason: '' };
}

/**
 * Acquire or renew Hot Wallet dispatch lease.
 * Never steals an active foreign lease. Never increments token on same-owner renew.
 */
export async function acquireHotWalletDispatchLease(
  client: PoolClient,
  hotWalletId: string,
  ownerIdentity: string,
  options?: { readonly leaseMs?: number },
): Promise<HotWalletDispatchLeaseAcquireResult> {
  const leaseMs = options?.leaseMs ?? DEFAULT_LEASE_MS;
  const existing = await client.query<{
    fencing_token: string;
    expires_at: Date;
    released_at: Date | null;
    owner_identity: string;
  }>(
    `SELECT fencing_token::text, expires_at, released_at, owner_identity
     FROM hot_wallet_dispatch_leases
     WHERE hot_wallet_id = $1::uuid
     FOR UPDATE`,
    [hotWalletId],
  );

  const now = Date.now();
  const expiresAt = new Date(now + leaseMs);

  if (existing.rows[0] === undefined) {
    const unresolved = await hasUnresolvedPossiblyBroadcastWork(client, hotWalletId, ownerIdentity);
    if (unresolved.blocked) {
      return { status: 'BLOCKED_UNRESOLVED', reason: unresolved.reason };
    }
    const inserted = await client.query<{ fencing_token: string; expires_at: Date }>(
      `INSERT INTO hot_wallet_dispatch_leases (
         hot_wallet_id, owner_identity, fencing_token, expires_at
       ) VALUES ($1::uuid, $2, 1, $3::timestamptz)
       RETURNING fencing_token::text, expires_at`,
      [hotWalletId, ownerIdentity, expiresAt.toISOString()],
    );
    return {
      status: 'ACQUIRED',
      fencingToken: BigInt(inserted.rows[0]!.fencing_token),
      expiresAt: inserted.rows[0]!.expires_at,
      ownerIdentity,
      renewed: false,
      tokenIncremented: false,
    };
  }

  const row = existing.rows[0];
  const active = row.released_at === null && row.expires_at.getTime() > now;

  if (active && row.owner_identity !== ownerIdentity) {
    return {
      status: 'BUSY',
      currentOwnerIdentity: row.owner_identity,
      fencingToken: BigInt(row.fencing_token),
      expiresAt: row.expires_at,
      reason: 'ACTIVE_LEASE_HELD_BY_OTHER',
    };
  }

  if (active && row.owner_identity === ownerIdentity) {
    const updated = await client.query<{ fencing_token: string; expires_at: Date }>(
      `UPDATE hot_wallet_dispatch_leases
       SET renewed_at = now(),
           expires_at = $2::timestamptz,
           released_at = NULL
       WHERE hot_wallet_id = $1::uuid
       RETURNING fencing_token::text, expires_at`,
      [hotWalletId, expiresAt.toISOString()],
    );
    return {
      status: 'ACQUIRED',
      fencingToken: BigInt(updated.rows[0]!.fencing_token),
      expiresAt: updated.rows[0]!.expires_at,
      ownerIdentity,
      renewed: true,
      tokenIncremented: false,
    };
  }

  // Expired (not released) same-owner reclaim: keep fencing_token STABLE so
  // crash/restart can resume the same attempt fence. Released same-owner falls
  // through to takeover (token increment).
  if (row.released_at === null && !active && row.owner_identity === ownerIdentity) {
    const updated = await client.query<{ fencing_token: string; expires_at: Date }>(
      `UPDATE hot_wallet_dispatch_leases
       SET renewed_at = now(),
           expires_at = $2::timestamptz,
           released_at = NULL
       WHERE hot_wallet_id = $1::uuid
       RETURNING fencing_token::text, expires_at`,
      [hotWalletId, expiresAt.toISOString()],
    );
    return {
      status: 'ACQUIRED',
      fencingToken: BigInt(updated.rows[0]!.fencing_token),
      expiresAt: updated.rows[0]!.expires_at,
      ownerIdentity,
      renewed: true,
      tokenIncremented: false,
    };
  }

  const unresolved = await hasUnresolvedPossiblyBroadcastWork(client, hotWalletId, ownerIdentity);
  if (unresolved.blocked) {
    return { status: 'BLOCKED_UNRESOLVED', reason: unresolved.reason };
  }

  const nextToken = BigInt(row.fencing_token) + 1n;
  const updated = await client.query<{ fencing_token: string; expires_at: Date }>(
    `UPDATE hot_wallet_dispatch_leases
     SET owner_identity = $2,
         fencing_token = $3::bigint,
         acquired_at = now(),
         renewed_at = now(),
         expires_at = $4::timestamptz,
         released_at = NULL
     WHERE hot_wallet_id = $1::uuid
     RETURNING fencing_token::text, expires_at`,
    [hotWalletId, ownerIdentity, nextToken.toString(10), expiresAt.toISOString()],
  );
  return {
    status: 'ACQUIRED',
    fencingToken: BigInt(updated.rows[0]!.fencing_token),
    expiresAt: updated.rows[0]!.expires_at,
    ownerIdentity,
    renewed: false,
    tokenIncremented: true,
  };
}

/**
 * @deprecated Prefer acquireHotWalletDispatchLease. Throws on BUSY/BLOCKED for test compat.
 */
export async function acquireTestDispatchLease(
  client: PoolClient,
  hotWalletId: string,
  ownerIdentity: string,
): Promise<{ fencingToken: bigint; expiresAt: Date }> {
  const result = await acquireHotWalletDispatchLease(client, hotWalletId, ownerIdentity);
  if (result.status === 'ACQUIRED') {
    return { fencingToken: result.fencingToken, expiresAt: result.expiresAt };
  }
  if (result.status === 'BUSY') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Hot wallet dispatch lease BUSY', {
      details: {
        status: 'BUSY',
        reason: result.reason,
        currentOwnerIdentity: result.currentOwnerIdentity,
      },
    });
  }
  throw new WithdrawalDomainError(
    'STATE_CONFLICT',
    'Hot wallet dispatch blocked by unresolved possibly-broadcast work',
    { details: { status: 'BLOCKED_UNRESOLVED', reason: result.reason } },
  );
}

/**
 * Assert current Hot Wallet lease fence matches expected token + owner and is active.
 * Call in the same transaction as persistPreBroadcastEvidence / markBroadcastSubmitted.
 */
export async function assertHotWalletDispatchFence(
  client: PoolClient,
  hotWalletIdOrInput:
    | string
    | {
        readonly hotWalletId: string;
        readonly fencingToken: bigint;
        readonly ownerIdentity: string;
      },
  fencingTokenArg?: bigint,
  ownerIdentityArg?: string,
): Promise<void> {
  const input =
    typeof hotWalletIdOrInput === 'string'
      ? {
          hotWalletId: hotWalletIdOrInput,
          fencingToken: fencingTokenArg!,
          ownerIdentity: ownerIdentityArg!,
        }
      : hotWalletIdOrInput;

  const lease = await client.query<{
    fencing_token: string;
    expires_at: Date;
    released_at: Date | null;
    owner_identity: string;
  }>(
    `SELECT fencing_token::text, expires_at, released_at, owner_identity
     FROM hot_wallet_dispatch_leases
     WHERE hot_wallet_id = $1::uuid
     FOR UPDATE`,
    [input.hotWalletId],
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
  if (row.owner_identity !== input.ownerIdentity) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Dispatch lease owner mismatch', {
      details: { expected: input.ownerIdentity, actual: row.owner_identity },
    });
  }
  if (BigInt(row.fencing_token) !== input.fencingToken) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'Dispatch fencing token mismatch');
  }
}

/**
 * Release lease only after definitive FAILED_PRE_BROADCAST / DEFINITIVE_NONPAYMENT
 * or CONFIRMED+settled.
 */
export async function releaseHotWalletDispatchLease(
  client: PoolClient,
  hotWalletIdOrInput:
    | string
    | {
        readonly hotWalletId: string;
        readonly ownerIdentity: string;
        readonly fencingToken?: bigint;
        readonly reason: HotWalletDispatchReleaseReason;
      },
  ownerIdentityArg?: string,
  reasonArg?: HotWalletDispatchReleaseReason,
): Promise<boolean> {
  const input =
    typeof hotWalletIdOrInput === 'string'
      ? {
          hotWalletId: hotWalletIdOrInput,
          ownerIdentity: ownerIdentityArg ?? '',
          reason: reasonArg ?? ('CONFIRMED_SETTLED' as const),
        }
      : hotWalletIdOrInput;

  if (input.ownerIdentity.trim() === '') {
    throw new WithdrawalDomainError('VALIDATION', 'Dispatch lease release requires ownerIdentity');
  }

  const result =
    input.fencingToken !== undefined
      ? await client.query(
          `UPDATE hot_wallet_dispatch_leases
           SET released_at = now(), renewed_at = now()
           WHERE hot_wallet_id = $1::uuid
             AND owner_identity = $2
             AND fencing_token = $3::bigint
             AND released_at IS NULL`,
          [input.hotWalletId, input.ownerIdentity, input.fencingToken.toString(10)],
        )
      : await client.query(
          `UPDATE hot_wallet_dispatch_leases
           SET released_at = now(), renewed_at = now()
           WHERE hot_wallet_id = $1::uuid
             AND owner_identity = $2
             AND released_at IS NULL`,
          [input.hotWalletId, input.ownerIdentity],
        );
  return (result.rowCount ?? 0) > 0;
}
