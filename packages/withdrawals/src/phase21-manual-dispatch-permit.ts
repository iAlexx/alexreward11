/**
 * Phase 21 reusable one-shot manual Mainnet dispatch permit.
 *
 * Authorization evidence only — not ledger truth.
 * Does NOT globally unpause PAYOUT_DISPATCH_PAUSE.
 * Does NOT authorize auto payout / intake / AdsGram money.
 *
 * Narrow Phase 21 manual-permit pause exception:
 * this is NOT a general unpause of PAYOUT_DISPATCH_PAUSE.
 */
import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { insertWithdrawalAuditLog, insertWithdrawalOutboxEvent } from './audit.js';
import { WithdrawalDomainError } from './errors.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
  withdrawalPhase21ManualDispatchOutboxDedupeKey,
  withdrawalWorkflowId,
} from './outbox.js';
import { tonAddressesEqual } from '@alex-rewards/ton';

import {
  assertPhase21Ready,
  listPhase21MissingResources,
  phase21ReadyCheck,
  PHASE21_NETWORK_CODE,
  type Phase21PayoutConfig,
} from './phase21-config.js';
import {
  PHASE21_CANARY_ATTACHED_GRAM_ATOMIC,
  PHASE21_CANARY_FORWARD_TON_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
} from './phase21-canary-payout-plan.js';

export {
  WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
  withdrawalPhase21ManualDispatchOutboxDedupeKey,
} from './outbox.js';

/** @deprecated Prefer withdrawalPhase21ManualDispatchOutboxDedupeKey. */
export const withdrawalPhase21ManualDispatchDedupeKey =
  withdrawalPhase21ManualDispatchOutboxDedupeKey;

/** Frozen canary jetton master — mirrors PHASE21_CANARY_MANUAL_DISPATCH_BINDINGS (no circular import). */
export const PHASE21_CANARY_FROZEN_JETTON_MASTER =
  'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' as const;

export const PHASE21_MANUAL_DISPATCH_PERMIT_STATUSES = ['ARMED', 'CONSUMED', 'CANCELLED'] as const;
export type Phase21ManualDispatchPermitStatus =
  (typeof PHASE21_MANUAL_DISPATCH_PERMIT_STATUSES)[number];

const PERMIT_SELECT_COLUMNS = `
  id::text AS id,
  withdrawal_id::text AS withdrawal_id,
  public_id,
  authorized_gross_atomic::text AS authorized_gross_atomic,
  authorized_fee_atomic::text AS authorized_fee_atomic,
  authorized_net_atomic::text AS authorized_net_atomic,
  authorized_recipient_friendly,
  authorized_recipient_raw,
  authorized_network_code,
  authorized_asset_symbol,
  authorized_jetton_master,
  authorized_attached_gram_atomic::text AS authorized_attached_gram_atomic,
  authorized_forward_gram_atomic::text AS authorized_forward_gram_atomic,
  status::text AS status,
  consumed_attempt_id::text AS consumed_attempt_id,
  created_by_admin_user_id::text AS created_by_admin_user_id,
  created_at,
  consumed_at,
  cancelled_at,
  cancel_reason,
  idempotency_key,
  audit_correlation_id
`;

export interface Phase21ManualDispatchPermitRow {
  readonly id: string;
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizedGrossAtomic: string;
  readonly authorizedFeeAtomic: string;
  readonly authorizedNetAtomic: string;
  readonly authorizedRecipientFriendly: string;
  readonly authorizedRecipientRaw: string;
  readonly authorizedNetworkCode: string;
  readonly authorizedAssetSymbol: string;
  readonly authorizedJettonMaster: string;
  readonly authorizedAttachedGramAtomic: string;
  readonly authorizedForwardGramAtomic: string;
  readonly status: Phase21ManualDispatchPermitStatus;
  readonly consumedAttemptId: string | null;
  readonly createdByAdminUserId: string;
  readonly createdAt: Date;
  readonly consumedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
  readonly idempotencyKey: string;
  readonly auditCorrelationId: string | null;
}

export interface Phase21ManualDispatchPermitBindings {
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizedGrossAtomic: bigint;
  readonly authorizedFeeAtomic: bigint;
  readonly authorizedNetAtomic: bigint;
  readonly authorizedRecipientFriendly: string;
  readonly authorizedRecipientRaw: string;
  readonly authorizedNetworkCode: string;
  readonly authorizedAssetSymbol: string;
  readonly authorizedJettonMaster: string;
  readonly authorizedAttachedGramAtomic: bigint;
  readonly authorizedForwardGramAtomic: bigint;
}

/** Branded Mainnet relay authority — fail-closed unless every gate is true. */
export type Phase21ManualDispatchRelayAuthority = {
  readonly kind: 'PHASE21_MAINNET_RELAY_AUTHORITY';
  readonly payoutAuthority: 'PHASE21_MAINNET';
  readonly phase21MainnetEnabled: true;
  readonly withdrawalNetworkCode: 'TON_MAINNET';
  readonly realChainEnabled: true;
  readonly fakeChainEnabled: false;
  readonly phase21: Phase21PayoutConfig;
};

export interface Phase21ManualDispatchRelayAuthorityInput {
  readonly payoutAuthority?: string | null;
  readonly phase21MainnetEnabled?: boolean | null;
  readonly withdrawalNetworkCode?: string | null;
  readonly realChainEnabled?: boolean | null;
  readonly fakeChainEnabled?: boolean | null;
  readonly phase21?: Phase21PayoutConfig | null;
}

type PermitSqlRow = {
  id: string;
  withdrawal_id: string;
  public_id: string;
  authorized_gross_atomic: string;
  authorized_fee_atomic: string;
  authorized_net_atomic: string;
  authorized_recipient_friendly: string;
  authorized_recipient_raw: string;
  authorized_network_code: string;
  authorized_asset_symbol: string;
  authorized_jetton_master: string;
  authorized_attached_gram_atomic: string;
  authorized_forward_gram_atomic: string;
  status: string;
  consumed_attempt_id: string | null;
  created_by_admin_user_id: string;
  created_at: Date;
  consumed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  idempotency_key: string;
  audit_correlation_id: string | null;
};

export function phase21CanaryManualDispatchIdempotencyKey(withdrawalId: string): string {
  return `phase21.manual_dispatch.canary:${withdrawalId}`;
}

export function phase21ManualDispatchAuthorityMissingResources(
  input: Phase21ManualDispatchRelayAuthorityInput,
): string[] {
  const missing: string[] = [];
  if (input.payoutAuthority !== 'PHASE21_MAINNET') {
    missing.push('payoutAuthority=PHASE21_MAINNET');
  }
  if (input.phase21MainnetEnabled !== true) {
    missing.push('phase21MainnetEnabled=true');
  }
  const network = (input.withdrawalNetworkCode ?? '').trim().toUpperCase();
  if (network !== PHASE21_NETWORK_CODE && network !== 'TON_MAINNET') {
    missing.push('withdrawalNetworkCode=TON_MAINNET');
  }
  if (input.realChainEnabled !== true) {
    missing.push('realChainEnabled=true');
  }
  if (input.fakeChainEnabled !== false) {
    missing.push('fakeChainEnabled=false');
  }
  if (input.phase21 == null) {
    missing.push('phase21 config present');
  } else {
    missing.push(...listPhase21MissingResources(input.phase21));
  }
  return missing;
}

/**
 * Returns branded relay authority only when every Mainnet gate is satisfied.
 * Otherwise null (fail closed — never throws for partial config).
 */
export function tryBuildPhase21ManualDispatchRelayAuthority(
  input: Phase21ManualDispatchRelayAuthorityInput,
): Phase21ManualDispatchRelayAuthority | null {
  if (input.payoutAuthority !== 'PHASE21_MAINNET') return null;
  if (input.phase21MainnetEnabled !== true) return null;
  const network = (input.withdrawalNetworkCode ?? '').trim().toUpperCase();
  if (network !== PHASE21_NETWORK_CODE && network !== 'TON_MAINNET') return null;
  if (input.realChainEnabled !== true) return null;
  if (input.fakeChainEnabled !== false) return null;
  if (input.phase21 == null) return null;

  const ready = phase21ReadyCheck(input.phase21);
  if (!ready.ready) return null;
  try {
    assertPhase21Ready(input.phase21);
  } catch {
    return null;
  }

  return {
    kind: 'PHASE21_MAINNET_RELAY_AUTHORITY',
    payoutAuthority: 'PHASE21_MAINNET',
    phase21MainnetEnabled: true,
    withdrawalNetworkCode: 'TON_MAINNET',
    realChainEnabled: true,
    fakeChainEnabled: false,
    phase21: input.phase21,
  };
}

function mapPermitRow(row: PermitSqlRow): Phase21ManualDispatchPermitRow {
  if (
    row.status !== 'ARMED' &&
    row.status !== 'CONSUMED' &&
    row.status !== 'CANCELLED'
  ) {
    throw new WithdrawalDomainError('VALIDATION', 'unknown phase21 permit status', {
      details: { status: row.status },
    });
  }
  return {
    id: row.id,
    withdrawalId: row.withdrawal_id,
    publicId: row.public_id,
    authorizedGrossAtomic: row.authorized_gross_atomic,
    authorizedFeeAtomic: row.authorized_fee_atomic,
    authorizedNetAtomic: row.authorized_net_atomic,
    authorizedRecipientFriendly: row.authorized_recipient_friendly,
    authorizedRecipientRaw: row.authorized_recipient_raw,
    authorizedNetworkCode: row.authorized_network_code,
    authorizedAssetSymbol: row.authorized_asset_symbol,
    authorizedJettonMaster: row.authorized_jetton_master,
    authorizedAttachedGramAtomic: row.authorized_attached_gram_atomic,
    authorizedForwardGramAtomic: row.authorized_forward_gram_atomic,
    status: row.status,
    consumedAttemptId: row.consumed_attempt_id,
    createdByAdminUserId: row.created_by_admin_user_id,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    idempotencyKey: row.idempotency_key,
    auditCorrelationId: row.audit_correlation_id,
  };
}

export async function getPhase21ManualDispatchPermitByWithdrawalId(
  client: PoolClient,
  withdrawalId: string,
): Promise<Phase21ManualDispatchPermitRow | null> {
  const result = await client.query<PermitSqlRow>(
    `SELECT ${PERMIT_SELECT_COLUMNS}
     FROM phase21_manual_dispatch_permits
     WHERE withdrawal_id = $1::uuid
     LIMIT 1`,
    [withdrawalId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapPermitRow(row);
}

function assertBindingsConsistent(bindings: Phase21ManualDispatchPermitBindings): void {
  if (
    bindings.authorizedGrossAtomic !==
    bindings.authorizedFeeAtomic + bindings.authorizedNetAtomic
  ) {
    throw new WithdrawalDomainError('VALIDATION', 'permit gross != fee + net', {
      details: {
        gross: bindings.authorizedGrossAtomic.toString(10),
        fee: bindings.authorizedFeeAtomic.toString(10),
        net: bindings.authorizedNetAtomic.toString(10),
      },
    });
  }
  if (bindings.authorizedNetAtomic <= 0n) {
    throw new WithdrawalDomainError('VALIDATION', 'permit net must be positive');
  }
}

function bindingsMatchExisting(
  existing: Phase21ManualDispatchPermitRow,
  bindings: Phase21ManualDispatchPermitBindings,
): boolean {
  return (
    existing.publicId === bindings.publicId &&
    existing.authorizedGrossAtomic === bindings.authorizedGrossAtomic.toString(10) &&
    existing.authorizedFeeAtomic === bindings.authorizedFeeAtomic.toString(10) &&
    existing.authorizedNetAtomic === bindings.authorizedNetAtomic.toString(10) &&
    existing.authorizedRecipientFriendly === bindings.authorizedRecipientFriendly &&
    existing.authorizedRecipientRaw === bindings.authorizedRecipientRaw &&
    existing.authorizedNetworkCode === bindings.authorizedNetworkCode &&
    existing.authorizedAssetSymbol === bindings.authorizedAssetSymbol &&
    existing.authorizedJettonMaster === bindings.authorizedJettonMaster &&
    existing.authorizedAttachedGramAtomic ===
      bindings.authorizedAttachedGramAtomic.toString(10) &&
    existing.authorizedForwardGramAtomic === bindings.authorizedForwardGramAtomic.toString(10)
  );
}

/**
 * Arm (or idempotently reuse) a one-shot Phase 21 manual dispatch permit.
 * UNIQUE(withdrawal_id) + UNIQUE(idempotency_key) make concurrent arming safe.
 * On reuse MUST compare ALL bindings including jetton master / grams / network / asset.
 */
export async function armPhase21ManualDispatchPermit(
  client: PoolClient,
  input: {
    readonly bindings: Phase21ManualDispatchPermitBindings;
    readonly createdByAdminUserId: string;
    readonly idempotencyKey: string;
    readonly auditCorrelationId?: string | null;
  },
): Promise<{
  readonly permit: Phase21ManualDispatchPermitRow;
  readonly created: boolean;
  readonly reused: boolean;
}> {
  assertBindingsConsistent(input.bindings);
  const existing = await getPhase21ManualDispatchPermitByWithdrawalId(
    client,
    input.bindings.withdrawalId,
  );
  if (existing !== null) {
    if (existing.status === 'CANCELLED') {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'Phase 21 manual dispatch permit was cancelled; refuse re-arm without Owner review',
        { details: { permitId: existing.id, status: existing.status } },
      );
    }
    if (existing.idempotencyKey !== input.idempotencyKey) {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'Phase 21 manual dispatch permit already exists with different idempotency key',
        {
          details: {
            permitId: existing.id,
            existingKey: existing.idempotencyKey,
            requestedKey: input.idempotencyKey,
          },
        },
      );
    }
    if (!bindingsMatchExisting(existing, input.bindings)) {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'existing Phase 21 manual dispatch permit bindings mismatch',
        { details: { permitId: existing.id } },
      );
    }
    return { permit: existing, created: false, reused: true };
  }

  const permitId = randomUUID();
  const insert = await client.query<PermitSqlRow>(
    `INSERT INTO phase21_manual_dispatch_permits (
       id, withdrawal_id, public_id,
       authorized_gross_atomic, authorized_fee_atomic, authorized_net_atomic,
       authorized_recipient_friendly, authorized_recipient_raw,
       authorized_network_code, authorized_asset_symbol, authorized_jetton_master,
       authorized_attached_gram_atomic, authorized_forward_gram_atomic,
       status, created_by_admin_user_id, idempotency_key, audit_correlation_id
     ) VALUES (
       $1::uuid, $2::uuid, $3,
       $4::bigint, $5::bigint, $6::bigint,
       $7, $8,
       $9, $10, $11,
       $12::bigint, $13::bigint,
       'ARMED'::phase21_manual_dispatch_permit_status, $14::uuid, $15, $16
     )
     ON CONFLICT (withdrawal_id) DO NOTHING
     RETURNING ${PERMIT_SELECT_COLUMNS}`,
    [
      permitId,
      input.bindings.withdrawalId,
      input.bindings.publicId,
      input.bindings.authorizedGrossAtomic.toString(10),
      input.bindings.authorizedFeeAtomic.toString(10),
      input.bindings.authorizedNetAtomic.toString(10),
      input.bindings.authorizedRecipientFriendly,
      input.bindings.authorizedRecipientRaw,
      input.bindings.authorizedNetworkCode,
      input.bindings.authorizedAssetSymbol,
      input.bindings.authorizedJettonMaster,
      input.bindings.authorizedAttachedGramAtomic.toString(10),
      input.bindings.authorizedForwardGramAtomic.toString(10),
      input.createdByAdminUserId,
      input.idempotencyKey,
      input.auditCorrelationId ?? null,
    ],
  );

  if (insert.rows[0] !== undefined) {
    const permit = mapPermitRow(insert.rows[0]);
    await insertWithdrawalAuditLog(client, {
      actionType: 'PHASE21_MANUAL_DISPATCH_PERMIT_ARMED',
      resourceType: 'phase21_manual_dispatch_permit',
      resourceId: permit.id,
      adminUserId: input.createdByAdminUserId,
      actorType: 'ADMIN',
      afterSnapshot: {
        permitId: permit.id,
        withdrawalId: permit.withdrawalId,
        publicId: permit.publicId,
        status: permit.status,
        authorizedGrossAtomic: permit.authorizedGrossAtomic,
        authorizedFeeAtomic: permit.authorizedFeeAtomic,
        authorizedNetAtomic: permit.authorizedNetAtomic,
        authorizedJettonMaster: permit.authorizedJettonMaster,
        broadcastPerformed: false,
        signed: false,
      },
      reason: 'Phase 21 Owner-armed one-shot manual Mainnet dispatch permit',
      traceId: input.auditCorrelationId ?? null,
    });
    return { permit, created: true, reused: false };
  }

  // Concurrent INSERT raced — reuse winner after full binding compare.
  const raced = await getPhase21ManualDispatchPermitByWithdrawalId(
    client,
    input.bindings.withdrawalId,
  );
  if (raced === null) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'Phase 21 manual dispatch permit insert raced and row missing',
    );
  }
  if (raced.idempotencyKey !== input.idempotencyKey) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'concurrent Phase 21 manual dispatch permit arming conflict',
      { details: { permitId: raced.id } },
    );
  }
  if (!bindingsMatchExisting(raced, input.bindings)) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'concurrent Phase 21 manual dispatch permit bindings mismatch',
      { details: { permitId: raced.id } },
    );
  }
  return { permit: raced, created: false, reused: true };
}

export type BindPhase21ManualDispatchPermitResult =
  | {
      readonly ok: true;
      readonly permit: Phase21ManualDispatchPermitRow;
      readonly boundNow: boolean;
    }
  | { readonly ok: true; readonly noop: true; readonly reason: 'no_permit' }
  | { readonly ok: false; readonly reason: string; readonly permit?: Phase21ManualDispatchPermitRow };

/**
 * Atomically bind ARMED → CONSUMED with consumed_attempt_id.
 * Idempotent when already CONSUMED for the same attempt.
 * CONFLICT when CONSUMED for a different attempt.
 * Missing permit is a no-op (ok + noop).
 */
export async function bindPhase21ManualDispatchPermitToAttempt(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly attemptId: string;
  },
): Promise<BindPhase21ManualDispatchPermitResult> {
  const ownership = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM withdrawal_attempts
     WHERE id = $1::uuid
       AND withdrawal_id = $2::uuid
     FOR UPDATE`,
    [input.attemptId, input.withdrawalId],
  );
  if (ownership.rows[0] === undefined) {
    return {
      ok: false,
      reason: 'PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_OWNERSHIP',
    };
  }

  const claimed = await client.query<PermitSqlRow>(
    `UPDATE phase21_manual_dispatch_permits
     SET status = 'CONSUMED'::phase21_manual_dispatch_permit_status,
         consumed_at = now(),
         consumed_attempt_id = $2::uuid
     WHERE withdrawal_id = $1::uuid
       AND status = 'ARMED'::phase21_manual_dispatch_permit_status
       AND consumed_attempt_id IS NULL
     RETURNING ${PERMIT_SELECT_COLUMNS}`,
    [input.withdrawalId, input.attemptId],
  );
  if (claimed.rows[0] !== undefined) {
    return { ok: true, permit: mapPermitRow(claimed.rows[0]), boundNow: true };
  }

  const existing = await getPhase21ManualDispatchPermitByWithdrawalId(
    client,
    input.withdrawalId,
  );
  if (existing === null) {
    return { ok: true, noop: true, reason: 'no_permit' };
  }
  if (existing.status === 'CONSUMED') {
    if (existing.consumedAttemptId === input.attemptId) {
      return { ok: true, permit: existing, boundNow: false };
    }
    return {
      ok: false,
      reason: 'PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_CONFLICT',
      permit: existing,
    };
  }
  return {
    ok: false,
    reason: `PHASE21_MANUAL_DISPATCH_PERMIT_${existing.status}`,
    permit: existing,
  };
}

function resolveConsumeArgs(
  withdrawalIdOrInput:
    | string
    | {
        readonly withdrawalId: string;
        readonly attemptId?: string | null;
      },
  attemptIdMaybe?: string | null,
): { readonly withdrawalId: string; readonly attemptId: string | null } {
  if (typeof withdrawalIdOrInput === 'string') {
    return {
      withdrawalId: withdrawalIdOrInput,
      attemptId: attemptIdMaybe ?? null,
    };
  }
  return {
    withdrawalId: withdrawalIdOrInput.withdrawalId,
    attemptId: withdrawalIdOrInput.attemptId ?? attemptIdMaybe ?? null,
  };
}

/**
 * Consume (bind) permit to an attempt. Requires attemptId (string or object form).
 * Delegates to bindPhase21ManualDispatchPermitToAttempt.
 */
export async function consumePhase21ManualDispatchPermit(
  client: PoolClient,
  withdrawalIdOrInput:
    | string
    | {
        readonly withdrawalId: string;
        readonly attemptId?: string | null;
      },
  attemptIdMaybe?: string | null,
): Promise<
  | {
      readonly ok: true;
      readonly permit: Phase21ManualDispatchPermitRow;
      readonly consumedNow: boolean;
    }
  | { readonly ok: false; readonly reason: string }
> {
  const resolved = resolveConsumeArgs(withdrawalIdOrInput, attemptIdMaybe);
  if (resolved.attemptId === null || resolved.attemptId.trim() === '') {
    return { ok: false, reason: 'PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_ID_REQUIRED' };
  }
  const bound = await bindPhase21ManualDispatchPermitToAttempt(client, {
    withdrawalId: resolved.withdrawalId,
    attemptId: resolved.attemptId,
  });
  if (!bound.ok) {
    return { ok: false, reason: bound.reason };
  }
  if ('noop' in bound) {
    return { ok: false, reason: 'PHASE21_MANUAL_DISPATCH_PERMIT_MISSING' };
  }
  return {
    ok: true,
    permit: bound.permit,
    consumedNow: bound.boundNow,
  };
}

export type Phase21ManualDispatchPauseGateResult =
  | {
      readonly paused: false;
      readonly reason: null;
      readonly permitException: true;
      readonly permitId: string;
      readonly permitStatus: Phase21ManualDispatchPermitStatus;
      readonly consumedNow: false;
      readonly consumedAttemptId: string | null;
    }
  | {
      readonly paused: true;
      readonly reason:
        | 'PAYOUT_DISPATCH_PAUSE'
        | 'PHASE21_MANUAL_DISPATCH_PERMIT_NOT_AUTHORIZED'
        | 'PHASE21_MANUAL_DISPATCH_PERMIT_CONSUMED_FAILED_PRE_USE_OWNER_RETRY'
        | 'PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_MISMATCH';
      readonly permitException: false;
      readonly permitId: string | null;
      readonly permitStatus: Phase21ManualDispatchPermitStatus | null;
      readonly consumedNow: false;
      readonly consumedAttemptId: string | null;
    }
  | {
      readonly paused: false;
      readonly reason: null;
      readonly permitException: false;
      readonly permitId: null;
      readonly permitStatus: null;
      readonly consumedNow: false;
      readonly consumedAttemptId: null;
    };

async function loadAttemptBroadcastState(
  client: PoolClient,
  attemptId: string,
): Promise<string | null> {
  const result = await client.query<{ broadcast_result_state: string }>(
    `SELECT broadcast_result_state::text AS broadcast_result_state
     FROM withdrawal_attempts
     WHERE id = $1::uuid
     LIMIT 1`,
    [attemptId],
  );
  return result.rows[0]?.broadcast_result_state ?? null;
}

/**
 * Resolve the live attempt id for THIS withdrawal when pause gate was not given one.
 * Prefer PENDING / UNKNOWN / RECONCILE_REQUIRED; else latest attempt. Never creates attempts.
 */
async function resolveCurrentAttemptIdForPauseGate(
  client: PoolClient,
  withdrawalId: string,
): Promise<string | null> {
  const live = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
       AND broadcast_result_state::text IN ('PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED')
     ORDER BY attempt_number DESC
     LIMIT 1`,
    [withdrawalId],
  );
  if (live.rows[0] !== undefined) {
    return live.rows[0].id;
  }
  const latest = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     ORDER BY attempt_number DESC
     LIMIT 1`,
    [withdrawalId],
  );
  return latest.rows[0]?.id ?? null;
}

/**
 * Narrow Phase 21 manual-permit pause exception.
 * Name is intentional: this is NOT a general unpause of PAYOUT_DISPATCH_PAUSE.
 *
 * MUST NOT consume on ARMED — binding happens later when an attempt is created.
 *
 * If general pause is off → proceed (unchanged).
 * If general pause is on:
 *   - ARMED → allow (do not consume)
 *   - CONSUMED unbound → paused
 *   - CONSUMED FAILED_PRE_BROADCAST → paused (owner-gated retry)
 *   - CONSUMED same-attempt resume ONLY when currentAttemptId === consumedAttemptId
 *   - CANCELLED / missing → paused
 * Never allows CONSUMED merely because a bound attempt row exists.
 */
export async function evaluatePhase21ManualDispatchPauseGate(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly deploymentEnvironment: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    readonly currentAttemptId?: string | null;
  },
): Promise<Phase21ManualDispatchPauseGateResult> {
  const globallyPaused = await isPayoutDispatchPaused(client, input.deploymentEnvironment);
  if (!globallyPaused) {
    return {
      paused: false,
      reason: null,
      permitException: false,
      permitId: null,
      permitStatus: null,
      consumedNow: false,
      consumedAttemptId: null,
    };
  }

  const permit = await getPhase21ManualDispatchPermitByWithdrawalId(client, input.withdrawalId);
  if (permit === null || permit.status === 'CANCELLED') {
    return {
      paused: true,
      reason: 'PAYOUT_DISPATCH_PAUSE',
      permitException: false,
      permitId: permit?.id ?? null,
      permitStatus: permit?.status ?? null,
      consumedNow: false,
      consumedAttemptId: permit?.consumedAttemptId ?? null,
    };
  }

  if (permit.status === 'ARMED') {
    return {
      paused: false,
      reason: null,
      permitException: true,
      permitId: permit.id,
      permitStatus: 'ARMED',
      consumedNow: false,
      consumedAttemptId: null,
    };
  }

  // CONSUMED — fail closed unless exact bound attempt resume
  if (permit.consumedAttemptId === null) {
    return {
      paused: true,
      reason: 'PHASE21_MANUAL_DISPATCH_PERMIT_NOT_AUTHORIZED',
      permitException: false,
      permitId: permit.id,
      permitStatus: 'CONSUMED',
      consumedNow: false,
      consumedAttemptId: null,
    };
  }

  const attemptState = await loadAttemptBroadcastState(client, permit.consumedAttemptId);
  if (attemptState === 'FAILED_PRE_BROADCAST') {
    return {
      paused: true,
      reason: 'PHASE21_MANUAL_DISPATCH_PERMIT_CONSUMED_FAILED_PRE_USE_OWNER_RETRY',
      permitException: false,
      permitId: permit.id,
      permitStatus: 'CONSUMED',
      consumedNow: false,
      consumedAttemptId: permit.consumedAttemptId,
    };
  }

  let currentAttemptId = input.currentAttemptId ?? null;
  if (currentAttemptId === null || currentAttemptId.trim() === '') {
    currentAttemptId = await resolveCurrentAttemptIdForPauseGate(client, input.withdrawalId);
  }

  if (currentAttemptId !== null && currentAttemptId === permit.consumedAttemptId) {
    return {
      paused: false,
      reason: null,
      permitException: true,
      permitId: permit.id,
      permitStatus: 'CONSUMED',
      consumedNow: false,
      consumedAttemptId: permit.consumedAttemptId,
    };
  }

  return {
    paused: true,
    reason: 'PHASE21_MANUAL_DISPATCH_PERMIT_ATTEMPT_MISMATCH',
    permitException: false,
    permitId: permit.id,
    permitStatus: 'CONSUMED',
    consumedNow: false,
    consumedAttemptId: permit.consumedAttemptId,
  };
}


export type Phase21ManualDispatchRestartSafetyResult =
  | {
      readonly allowDuplicate: true;
      readonly reason: null;
      readonly permit: Phase21ManualDispatchPermitRow;
    }
  | {
      readonly allowDuplicate: false;
      readonly reason:
        | 'missing_permit'
        | 'cancelled_permit'
        | 'reconcile_required_no_restart'
        | 'armed_with_attempts'
        | 'consumed_unbound'
        | 'missing_bound_attempt'
        | 'bound_attempt_wrong_withdrawal'
        | 'consumed_failed_pre_use_owner_gated_retry';
      readonly permit: Phase21ManualDispatchPermitRow | null;
    };

/**
 * ALLOW_DUPLICATE gating for Phase 21 manual-dispatch outbox restart.
 * Refuse unsafe evidence; Owner-gated FAILED_PRE path is separate.
 * Clean PENDING on the exact consumed attempt may resume (Temporal restart, not a fresh attempt).
 */
export async function evaluatePhase21ManualDispatchRestartSafety(
  client: PoolClient,
  withdrawalId: string,
): Promise<Phase21ManualDispatchRestartSafetyResult> {
  const permit = await getPhase21ManualDispatchPermitByWithdrawalId(client, withdrawalId);
  if (permit === null) {
    return { allowDuplicate: false, reason: 'missing_permit', permit: null };
  }
  if (permit.status === 'CANCELLED') {
    return { allowDuplicate: false, reason: 'cancelled_permit', permit };
  }

  if (permit.status === 'ARMED') {
    const attempts = await client.query<{ attempt_count: number }>(
      `SELECT count(*)::int AS attempt_count
       FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid`,
      [withdrawalId],
    );
    const attemptCount = attempts.rows[0]?.attempt_count ?? 0;
    if (attemptCount > 0) {
      return { allowDuplicate: false, reason: 'armed_with_attempts', permit };
    }
    return { allowDuplicate: true, reason: null, permit };
  }

  // CONSUMED
  if (permit.consumedAttemptId === null) {
    return { allowDuplicate: false, reason: 'consumed_unbound', permit };
  }

  const bound = await client.query<{
    id: string;
    withdrawal_id: string;
    broadcast_result_state: string;
    signed_external_message_boc: string | null;
    signed_wallet_request_boc: string | null;
    external_message_cell_hash: string | null;
    normalized_external_message_hash: string | null;
    signed_message_hash: string | null;
    broadcast_submitted_at: Date | null;
    chain_reference: string | null;
    withdrawal_state: string;
  }>(
    `SELECT a.id::text AS id,
            a.withdrawal_id::text AS withdrawal_id,
            a.broadcast_result_state::text AS broadcast_result_state,
            a.signed_external_message_boc,
            a.signed_wallet_request_boc,
            a.external_message_cell_hash,
            a.normalized_external_message_hash,
            a.signed_message_hash,
            a.broadcast_submitted_at,
            a.chain_reference,
            w.state::text AS withdrawal_state
     FROM withdrawal_attempts a
     JOIN withdrawals w ON w.id = a.withdrawal_id
     WHERE a.id = $1::uuid
     LIMIT 1`,
    [permit.consumedAttemptId],
  );
  const row = bound.rows[0];
  if (row === undefined) {
    return { allowDuplicate: false, reason: 'missing_bound_attempt', permit };
  }
  if (row.withdrawal_id !== withdrawalId) {
    return { allowDuplicate: false, reason: 'bound_attempt_wrong_withdrawal', permit };
  }
  if (row.broadcast_result_state === 'FAILED_PRE_BROADCAST') {
    return {
      allowDuplicate: false,
      reason: 'consumed_failed_pre_use_owner_gated_retry',
      permit,
    };
  }

  const hasSignatureEvidence =
    row.signed_external_message_boc !== null ||
    row.signed_wallet_request_boc !== null ||
    row.external_message_cell_hash !== null ||
    row.normalized_external_message_hash !== null ||
    row.signed_message_hash !== null;
  const hasSubmitted = row.broadcast_submitted_at !== null;
  const hasChainRef =
    row.chain_reference !== null && row.chain_reference.trim() !== '';
  const unsafeBroadcastState =
    row.broadcast_result_state === 'UNKNOWN' ||
    row.broadcast_result_state === 'RECONCILE_REQUIRED' ||
    row.broadcast_result_state === 'BROADCASTED';
  const withdrawalConfirmed = row.withdrawal_state === 'CONFIRMED';

  if (
    hasSignatureEvidence ||
    hasSubmitted ||
    hasChainRef ||
    unsafeBroadcastState ||
    withdrawalConfirmed
  ) {
    return { allowDuplicate: false, reason: 'reconcile_required_no_restart', permit };
  }

  // Exact bound attempt, clean PENDING → Temporal resume only (not a fresh financial attempt).
  if (row.broadcast_result_state === 'PENDING') {
    return { allowDuplicate: true, reason: null, permit };
  }

  return { allowDuplicate: false, reason: 'reconcile_required_no_restart', permit };
}


/**
 * Revalidate live withdrawal / wallet / asset state against armed permit bindings
 * inside the same transaction as create+bind. Locks withdrawal, recipient wallet, asset, and network rows FOR UPDATE.
 * For the Owner canary withdrawal, also checks frozen PHASE21 canary constants.
 */
export async function assertPhase21ManualDispatchLiveBindingsOrThrow(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly permit: Phase21ManualDispatchPermitRow;
  },
): Promise<void> {
  if (input.permit.withdrawalId !== input.withdrawalId) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'PHASE21_MANUAL_DISPATCH_LIVE_BINDINGS_MISMATCH',
      {
        details: {
          code: 'PHASE21_MANUAL_DISPATCH_LIVE_BINDINGS_MISMATCH',
          field: 'permit.withdrawalId',
        },
      },
    );
  }

  const locked = await client.query<{
    id: string;
    public_id: string;
    requested_amount_atomic: string;
    fee_amount_atomic: string;
    net_amount_atomic: string;
    network_code: string;
    wallet_network_code: string;
    asset_symbol: string;
    asset_decimals: number | null;
    contract_identity: string | null;
    wallet_id: string;
    recipient_friendly: string;
    recipient_raw: string;
    wallet_verified: boolean;
    wallet_disabled_at: Date | null;
  }>(
    `SELECT w.id::text AS id,
            w.public_id,
            w.requested_amount_atomic::text AS requested_amount_atomic,
            w.fee_amount_atomic::text AS fee_amount_atomic,
            w.net_amount_atomic::text AS net_amount_atomic,
            n.code AS network_code,
            wn.code AS wallet_network_code,
            a.symbol AS asset_symbol,
            a.decimals AS asset_decimals,
            a.contract_identity,
            w.wallet_id::text AS wallet_id,
            uw.friendly_address AS recipient_friendly,
            uw.raw_address AS recipient_raw,
            uw.verified AS wallet_verified,
            uw.disabled_at AS wallet_disabled_at
     FROM withdrawals w
     JOIN networks n ON n.id = w.network_id
     JOIN assets a ON a.id = w.asset_id
     JOIN user_wallets uw ON uw.id = w.wallet_id
     JOIN networks wn ON wn.id = uw.network_id
     WHERE w.id = $1::uuid
     FOR UPDATE OF w, uw, a, n, wn`,
    [input.withdrawalId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'PHASE21_MANUAL_DISPATCH_LIVE_BINDINGS_MISMATCH',
      { details: { code: 'PHASE21_MANUAL_DISPATCH_LIVE_BINDINGS_MISMATCH', field: 'withdrawal' } },
    );
  }

  const mismatches: string[] = [];
  if (row.id !== input.permit.withdrawalId) mismatches.push('withdrawal_id');
  if (row.public_id !== input.permit.publicId) mismatches.push('public_id');
  if (row.requested_amount_atomic !== input.permit.authorizedGrossAtomic) {
    mismatches.push('gross_atomic');
  }
  if (row.fee_amount_atomic !== input.permit.authorizedFeeAtomic) mismatches.push('fee_atomic');
  if (row.net_amount_atomic !== input.permit.authorizedNetAtomic) mismatches.push('net_atomic');
  if (row.recipient_friendly !== input.permit.authorizedRecipientFriendly) {
    mismatches.push('recipient_friendly');
  }
  if (row.recipient_raw !== input.permit.authorizedRecipientRaw) {
    mismatches.push('recipient_raw');
  }
  if (row.network_code !== 'TON_MAINNET' || row.network_code !== input.permit.authorizedNetworkCode) {
    mismatches.push('network_code');
  }
  if (
    row.wallet_network_code !== 'TON_MAINNET' ||
    row.wallet_network_code !== input.permit.authorizedNetworkCode
  ) {
    mismatches.push('wallet_network_code');
  }
  if (row.asset_symbol !== 'USDT' || row.asset_symbol !== input.permit.authorizedAssetSymbol) {
    mismatches.push('asset_symbol');
  }
  // Mainnet USDT must be exactly 6 decimals — NULL or any other value fails closed.
  if (row.asset_decimals !== 6) {
    mismatches.push('asset_decimals');
  }
  if (
    row.contract_identity === null ||
    !tonAddressesEqual(row.contract_identity, input.permit.authorizedJettonMaster)
  ) {
    mismatches.push('jetton_master');
  }
  if (row.wallet_verified !== true) mismatches.push('recipient_verified');
  if (row.wallet_disabled_at !== null) mismatches.push('recipient_not_disabled');

  if (input.withdrawalId === PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID) {
    if (row.public_id !== PHASE21_CANARY_PAYOUT_PUBLIC_ID) mismatches.push('canary_public_id');
    if (row.requested_amount_atomic !== PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10)) {
      mismatches.push('canary_gross');
    }
    if (row.fee_amount_atomic !== PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10)) {
      mismatches.push('canary_fee');
    }
    if (row.net_amount_atomic !== PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10)) {
      mismatches.push('canary_net');
    }
    if (row.recipient_friendly !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY) {
      mismatches.push('canary_recipient_friendly');
    }
    if (row.recipient_raw !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW) {
      mismatches.push('canary_recipient_raw');
    }
    if (
      row.contract_identity === null ||
      !tonAddressesEqual(row.contract_identity, PHASE21_CANARY_FROZEN_JETTON_MASTER)
    ) {
      mismatches.push('canary_jetton_master');
    }
    if (input.permit.authorizedJettonMaster !== PHASE21_CANARY_FROZEN_JETTON_MASTER) {
      mismatches.push('canary_permit_jetton');
    }
    if (
      input.permit.authorizedAttachedGramAtomic !==
      PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10)
    ) {
      mismatches.push('canary_attached_gram');
    }
    if (
      input.permit.authorizedForwardGramAtomic !==
      PHASE21_CANARY_FORWARD_TON_ATOMIC.toString(10)
    ) {
      mismatches.push('canary_forward_gram');
    }
  }

  if (mismatches.length > 0) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'PHASE21_MANUAL_DISPATCH_LIVE_BINDINGS_MISMATCH',
      {
        details: {
          code: 'PHASE21_MANUAL_DISPATCH_LIVE_BINDINGS_MISMATCH',
          mismatches,
          withdrawalId: input.withdrawalId,
          permitId: input.permit.id,
        },
      },
    );
  }
}


export async function enqueuePhase21ManualDispatchOutbox(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly permitId: string;
  },
): Promise<{ readonly outboxId: string; readonly created: boolean; readonly workflowId: string }> {
  const workflowId = withdrawalWorkflowId(input.withdrawalId);
  const inserted = await insertWithdrawalOutboxEvent(client, {
    aggregateType: 'withdrawal',
    aggregateId: input.withdrawalId,
    eventType: WITHDRAWAL_PHASE21_MANUAL_DISPATCH_OUTBOX_EVENT,
    dedupeKey: withdrawalPhase21ManualDispatchOutboxDedupeKey(
      input.withdrawalId,
      input.permitId,
    ),
    payload: {
      withdrawalId: input.withdrawalId,
      permitId: input.permitId,
      workflowId,
      phase21ManualDispatch: true,
      broadcastPerformed: false,
    },
  });
  return { outboxId: inserted.id, created: inserted.created, workflowId };
}
