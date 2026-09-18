/**
 * Owner-gated recovery for ONE Phase 10 canary withdrawal only:
 * 01a0afbd-2550-742b-967d-5aec6ee75a83 (SIGNING + 0 attempts + expired lease).
 *
 * Default mode is dry-run (plan/inspect only).
 *
 * Mutation requires ALL of:
 * - mode=mutate
 * - confirmationPhrase (intent confirmation ONLY — not authentication)
 * - ownerAdminUserId of an ACTIVE admin with unrevoked OWNER role binding
 * - ownerSessionToken matching an unrevoked, unexpired admin_sessions row for that Owner
 * - recent Owner reauthentication within PHASE10_CANARY_RECOVERY_REAUTH_MAX_AGE_MS
 * - temporalTerminatedConfirmed + payoutWorkerStoppedConfirmed
 * - fencing / reservation / attempt preconditions
 *
 * CI / GitHub Actions cannot mutate operational recovery. Isolated NODE_ENV=test
 * suites may mutate only when current_database() is an approved destructive test
 * DB and PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID matches a non-production ID.
 * Fixture overrides are never honored against operational alex_rewards.
 * Operational database alex_rewards is always refused in CI. Does not start Temporal,
 * unlock Signer, enable chain, or broadcast.
 */
import { sha256Hex } from '@alex-rewards/auth';
import { isApprovedDestructiveTestDatabaseName } from '@alex-rewards/db';
import type { Pool, PoolClient } from 'pg';

import { insertWithdrawalAuditLog } from './audit.js';
import { withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import {
  hotWalletDispatchOwnerIdentity,
  releaseHotWalletDispatchLease,
} from './hot-wallet-dispatch-lease.js';
import { transitionWithdrawal } from './transitions.js';

/** Sole production withdrawal this recovery path may touch. */
export const PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID =
  '01a0afbd-2550-742b-967d-5aec6ee75a83' as const;

/**
 * Intent confirmation phrase only — NOT an authentication secret.
 * Proves the operator typed the approved recovery intent; identity is operatorAdminUserId.
 */
export const PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE =
  'PHASE10_OWNER_RECOVERY_SIGNING_ZERO_ATTEMPTS' as const;

/** @deprecated Alias of PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE (confirmation, not auth). */
export const PHASE10_CANARY_RECOVERY_AUTHORIZATION_PHRASE =
  PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE;

export const PHASE10_CANARY_RECOVERY_AUDIT_ACTION =
  'PHASE10_OWNER_RECOVERY_SIGNING_ZERO_ATTEMPTS' as const;

/**
 * Extra confirmation required when current_database() is operational alex_rewards.
 * Still not authentication — operatorAdminUserId remains required.
 */
export const PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM =
  'I_CONFIRM_OPERATIONAL_ALEX_REWARDS_CANARY_RECOVERY' as const;

/** High-impact Owner reauthentication window (spec: recent reauth required). */
export const PHASE10_CANARY_RECOVERY_REAUTH_MAX_AGE_MS = 15 * 60 * 1000;

/** Hash raw Owner admin session token for admin_sessions.session_token_hash lookup. */
export function hashPhase10CanaryOwnerSessionToken(rawToken: string): string {
  return sha256Hex(`admin-session:${rawToken.trim()}`);
}

export type Phase10CanaryRecoveryMode = 'dry-run' | 'mutate';

export interface Phase10CanaryRecoverySnapshot {
  readonly withdrawalId: string;
  readonly state: string;
  readonly hotWalletId: string | null;
  readonly workflowId: string | null;
  readonly reservationLedgerTxId: string | null;
  readonly releaseLedgerTxId: string | null;
  readonly settlementLedgerTxId: string | null;
  readonly attemptCount: number;
  readonly broadcastEvidenceCount: number;
  readonly lease: {
    readonly ownerIdentity: string | null;
    readonly fencingToken: string | null;
    readonly expiresAt: string | null;
    readonly releasedAt: string | null;
    readonly expired: boolean;
    readonly unreleased: boolean;
  };
  readonly expectedOwnerIdentity: string;
}

export interface Phase10CanaryRecoveryPlan {
  readonly mode: Phase10CanaryRecoveryMode;
  readonly authorized: boolean;
  readonly accepted: boolean;
  readonly refusalReasons: readonly string[];
  readonly snapshot: Phase10CanaryRecoverySnapshot | null;
  readonly plannedTransition: {
    readonly from: 'SIGNING';
    readonly to: 'FAILED_PRE_BROADCAST';
    readonly leaseRelease: {
      readonly ownerIdentity: string;
      readonly fencingToken: string;
      readonly reason: 'FAILED_PRE_BROADCAST';
    };
  } | null;
  readonly temporalNotes: {
    readonly originalWorkflowId: string;
    readonly originalWorkflowMustBeTerminatedNotCompleted: true;
    readonly directPipelineRequiresNewWorkflow: false;
    readonly completionRecordedIn: readonly string[];
  };
  readonly prerequisites: {
    readonly temporalTerminatedConfirmed: boolean;
    readonly payoutWorkerStoppedConfirmed: boolean;
    readonly migration0023Applied: boolean | null;
    readonly ownerAdminUserIdPresent: boolean;
    readonly ownerSessionTokenPresent: boolean;
  };
}

export interface Phase10CanaryRecoveryExecuteResult {
  readonly mode: 'mutate';
  readonly accepted: boolean;
  readonly refusalReasons: readonly string[];
  readonly before: Phase10CanaryRecoverySnapshot | null;
  readonly after: Phase10CanaryRecoverySnapshot | null;
  readonly auditLogId: string | null;
  readonly transition: { readonly id: string; readonly state: string } | null;
  readonly leaseReleased: boolean;
  readonly ownerAdminUserId: string | null;
  /** @deprecated Alias of ownerAdminUserId. */
  readonly operatorAdminUserId: string | null;
}

export interface Phase10CanaryRecoveryInput {
  /**
   * Must equal PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID (or test fixture override).
   * Any other ID is refused (no generic recovery).
   */
  readonly withdrawalId: string;
  /**
   * dry-run (default): plan only, no writes.
   * mutate: requires confirmation + authenticated operator + attestations.
   */
  readonly mode?: Phase10CanaryRecoveryMode;
  /**
   * Intent confirmation phrase only (not authentication).
   * Must equal PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE for mutate.
   */
  readonly confirmationPhrase?: string | null;
  /**
   * @deprecated Use confirmationPhrase. Kept as alias; still confirmation-only.
   */
  readonly authorizationPhrase?: string | null;
  /**
   * Authenticated Owner identity: must be ACTIVE admin_users.id with unrevoked OWNER binding.
   * Required for mutate. Bound into audit_logs.admin_user_id.
   * UUID alone is not authentication — ownerSessionToken + recent reauth are required.
   */
  readonly ownerAdminUserId?: string | null;
  /**
   * @deprecated Use ownerAdminUserId.
   */
  readonly operatorAdminUserId?: string | null;
  /**
   * Raw Owner admin session secret. Hashed and matched to an unrevoked, unexpired
   * admin_sessions row belonging to ownerAdminUserId. Required for mutate.
   */
  readonly ownerSessionToken?: string | null;
  /**
   * Owner attestation that Temporal workflow was terminated (TERMINATED, not COMPLETED).
   * Required for mutate.
   */
  readonly temporalTerminatedConfirmed?: boolean;
  /**
   * Owner attestation that payout worker is stopped (no competing activity pickup).
   * Required for mutate.
   */
  readonly payoutWorkerStoppedConfirmed?: boolean;
  /**
   * Expected fencing token (from forensic snapshot). When provided, must match live lease.
   */
  readonly expectedFencingToken?: bigint | null;
  /**
   * Required when mutating operational database alex_rewards.
   * Must equal PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM.
   */
  readonly operationalMutationConfirm?: string | null;
}

/**
 * Sole allowlisted production canary ID, or a NODE_ENV=test fixture ID that is
 * only honored against an approved isolated test database (never alex_rewards).
 */
export function isPhase10CanaryRecoveryWithdrawalAuthorized(
  withdrawalId: string,
  currentDatabase: string,
): boolean {
  if (withdrawalId === PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID) return true;
  if (process.env.NODE_ENV !== 'test') return false;
  if (currentDatabase === 'alex_rewards') return false;
  if (!isApprovedDestructiveTestDatabaseName(currentDatabase)) return false;
  const fixture = process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
  return typeof fixture === 'string' && fixture.length > 0 && fixture === withdrawalId;
}

function mayBeAuthorizedWithdrawalIdWithoutDb(withdrawalId: string): boolean {
  if (withdrawalId === PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID) return true;
  const fixture = process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
  return (
    process.env.NODE_ENV === 'test' &&
    typeof fixture === 'string' &&
    fixture.length > 0 &&
    fixture === withdrawalId
  );
}

/** Fail-closed: any nonempty CI / GITHUB_ACTIONS marker except explicit falsey values. */
export function isPhase10CanaryRecoveryCiEnvironment(): boolean {
  return isTruthyCiMarker(process.env.CI) || isTruthyCiMarker(process.env.GITHUB_ACTIONS);
}

function isTruthyCiMarker(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '') return false;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return true;
}

function isCiEnvironment(): boolean {
  return isPhase10CanaryRecoveryCiEnvironment();
}

/**
 * Narrow CI exception for isolated integration tests only.
 *
 * Requires ALL of:
 * - NODE_ENV=test
 * - PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID exactly equals the target withdrawalId
 * - target is NOT the production canary ID
 * - current_database() is an approved destructive test DB (_test / _phaseN), never alex_rewards
 *
 * Does not disable the CI guard globally and never authorizes operational mutation.
 */
function isIsolatedCiTestMutationAllowed(
  input: Phase10CanaryRecoveryInput,
  currentDatabase: string,
): boolean {
  if (process.env.NODE_ENV !== 'test') return false;
  if (currentDatabase === 'alex_rewards') return false;
  if (!isApprovedDestructiveTestDatabaseName(currentDatabase)) return false;
  if (input.withdrawalId === PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID) return false;
  const fixture = process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID;
  return typeof fixture === 'string' && fixture.length > 0 && fixture === input.withdrawalId;
}

function readConfirmationPhrase(input: Phase10CanaryRecoveryInput): string | null {
  const phrase = input.confirmationPhrase ?? input.authorizationPhrase ?? null;
  return phrase;
}

function readOwnerAdminUserId(input: Phase10CanaryRecoveryInput): string | null {
  const id = input.ownerAdminUserId ?? input.operatorAdminUserId ?? null;
  if (id === undefined || id === null) return null;
  const trimmed = id.trim();
  return trimmed === '' ? null : trimmed;
}

function ownerAuthPrerequisites(input: Phase10CanaryRecoveryInput) {
  const ownerAdminUserId = readOwnerAdminUserId(input);
  return {
    ownerAdminUserIdPresent: ownerAdminUserId !== null,
    ownerSessionTokenPresent:
      typeof input.ownerSessionToken === 'string' && input.ownerSessionToken.trim() !== '',
  };
}

async function loadSnapshot(
  client: PoolClient,
  withdrawalId: string,
): Promise<Phase10CanaryRecoverySnapshot | null> {
  const w = await client.query<{
    id: string;
    state: string;
    hot_wallet_id: string | null;
    workflow_id: string | null;
    reservation_ledger_tx_id: string | null;
    release_ledger_tx_id: string | null;
    settlement_ledger_tx_id: string | null;
  }>(
    `SELECT id::text, state::text, hot_wallet_id::text, workflow_id,
            reservation_ledger_tx_id::text, release_ledger_tx_id::text,
            settlement_ledger_tx_id::text
     FROM withdrawals WHERE id = $1::uuid`,
    [withdrawalId],
  );
  const row = w.rows[0];
  if (row === undefined) return null;

  const attempts = await client.query<{ c: number; broadcast_evidence: number }>(
    `SELECT count(*)::int AS c,
            count(*) FILTER (
              WHERE broadcast_started_at IS NOT NULL
                 OR broadcast_submitted_at IS NOT NULL
                 OR signed_external_message_boc IS NOT NULL
                 OR signed_wallet_request_boc IS NOT NULL
            )::int AS broadcast_evidence
     FROM withdrawal_attempts WHERE withdrawal_id = $1::uuid`,
    [withdrawalId],
  );

  const lease = await client.query<{
    owner_identity: string | null;
    fencing_token: string | null;
    expires_at: Date | null;
    released_at: Date | null;
  }>(
    `SELECT owner_identity, fencing_token::text, expires_at, released_at
     FROM hot_wallet_dispatch_leases
     WHERE hot_wallet_id = $1::uuid`,
    [row.hot_wallet_id],
  );
  const leaseRow = lease.rows[0];
  const expiresAt = leaseRow?.expires_at ?? null;
  const releasedAt = leaseRow?.released_at ?? null;
  const now = Date.now();

  return {
    withdrawalId: row.id,
    state: row.state,
    hotWalletId: row.hot_wallet_id,
    workflowId: row.workflow_id,
    reservationLedgerTxId: row.reservation_ledger_tx_id,
    releaseLedgerTxId: row.release_ledger_tx_id,
    settlementLedgerTxId: row.settlement_ledger_tx_id,
    attemptCount: attempts.rows[0]?.c ?? 0,
    broadcastEvidenceCount: attempts.rows[0]?.broadcast_evidence ?? 0,
    lease: {
      ownerIdentity: leaseRow?.owner_identity ?? null,
      fencingToken: leaseRow?.fencing_token ?? null,
      expiresAt: expiresAt?.toISOString() ?? null,
      releasedAt: releasedAt?.toISOString() ?? null,
      expired: expiresAt !== null ? expiresAt.getTime() <= now : false,
      unreleased: releasedAt === null,
    },
    expectedOwnerIdentity: hotWalletDispatchOwnerIdentity(withdrawalId),
  };
}

async function migration0023Applied(client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM schema_migrations WHERE version = '0023_attempt_requires_state_init'`,
  );
  return (result.rowCount ?? 0) === 1;
}

async function assertAuthenticatedOwnerContext(
  client: PoolClient,
  input: Phase10CanaryRecoveryInput,
): Promise<{ ok: true; adminUserId: string } | { ok: false; reason: string }> {
  const adminUserId = readOwnerAdminUserId(input);
  if (adminUserId === null) {
    return {
      ok: false,
      reason:
        'ownerAdminUserId required — authenticated Owner with OWNER binding (phrase is not authentication)',
    };
  }
  const sessionToken = input.ownerSessionToken;
  if (sessionToken === undefined || sessionToken === null || sessionToken.trim() === '') {
    return {
      ok: false,
      reason:
        'ownerSessionToken required — trusted Owner admin session (admin UUID alone is not authentication)',
    };
  }

  const admin = await client.query<{
    id: string;
    status: string;
    last_reauthenticated_at: Date | null;
  }>(
    `SELECT id::text, status::text, last_reauthenticated_at
     FROM admin_users WHERE id = $1::uuid`,
    [adminUserId],
  );
  const adminRow = admin.rows[0];
  if (adminRow === undefined) {
    return { ok: false, reason: 'ownerAdminUserId not found in admin_users' };
  }
  if (adminRow.status !== 'ACTIVE') {
    return { ok: false, reason: `ownerAdminUserId is not ACTIVE (status=${adminRow.status})` };
  }

  const binding = await client.query<{ c: number }>(
    `SELECT count(*)::int AS c
     FROM admin_role_bindings b
     INNER JOIN admin_roles r ON r.id = b.role_id
     WHERE b.admin_user_id = $1::uuid
       AND r.code = 'OWNER'
       AND r.status = 'ACTIVE'
       AND b.revoked_at IS NULL`,
    [adminUserId],
  );
  if ((binding.rows[0]?.c ?? 0) < 1) {
    return {
      ok: false,
      reason: 'ownerAdminUserId lacks ACTIVE unrevoked OWNER role binding',
    };
  }

  const tokenHash = hashPhase10CanaryOwnerSessionToken(sessionToken);
  const session = await client.query<{
    id: string;
    admin_user_id: string;
    reauthenticated_at: Date | null;
    idle_expires_at: Date;
    absolute_expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id::text, admin_user_id::text, reauthenticated_at,
            idle_expires_at, absolute_expires_at, revoked_at
     FROM admin_sessions
     WHERE session_token_hash = $1
     LIMIT 1`,
    [tokenHash],
  );
  const sessionRow = session.rows[0];
  if (sessionRow === undefined) {
    return { ok: false, reason: 'ownerSessionToken does not match an admin_sessions row' };
  }
  if (sessionRow.admin_user_id !== adminUserId) {
    return {
      ok: false,
      reason: 'ownerSessionToken is not bound to ownerAdminUserId',
    };
  }
  if (sessionRow.revoked_at !== null) {
    return { ok: false, reason: 'ownerSessionToken session is revoked' };
  }
  const now = Date.now();
  if (sessionRow.idle_expires_at.getTime() <= now) {
    return { ok: false, reason: 'ownerSessionToken session idle timeout expired' };
  }
  if (sessionRow.absolute_expires_at.getTime() <= now) {
    return { ok: false, reason: 'ownerSessionToken session absolute timeout expired' };
  }

  const reauthAt = sessionRow.reauthenticated_at ?? adminRow.last_reauthenticated_at;
  if (reauthAt === null) {
    return {
      ok: false,
      reason: 'Owner reauthentication required (no reauthenticated_at on session or admin)',
    };
  }
  if (now - reauthAt.getTime() > PHASE10_CANARY_RECOVERY_REAUTH_MAX_AGE_MS) {
    return {
      ok: false,
      reason: `Owner reauthentication expired (max age ${PHASE10_CANARY_RECOVERY_REAUTH_MAX_AGE_MS}ms)`,
    };
  }

  return { ok: true, adminUserId };
}

function evaluatePreconditions(
  snapshot: Phase10CanaryRecoverySnapshot,
  input: Phase10CanaryRecoveryInput,
  migrationApplied: boolean,
  currentDatabase: string,
): string[] {
  const reasons: string[] = [];
  if (!isPhase10CanaryRecoveryWithdrawalAuthorized(snapshot.withdrawalId, currentDatabase)) {
    reasons.push(
      currentDatabase === 'alex_rewards'
        ? 'fixture override refused against operational database alex_rewards'
        : 'withdrawalId is not the sole authorized canary recovery target',
    );
  }
  if (snapshot.state !== 'SIGNING') {
    reasons.push(`state must be SIGNING (observed ${snapshot.state})`);
  }
  if (snapshot.attemptCount !== 0) {
    reasons.push(`attemptCount must be 0 (observed ${snapshot.attemptCount})`);
  }
  if (snapshot.broadcastEvidenceCount !== 0) {
    reasons.push('broadcast evidence present on withdrawal_attempts — reconciliation only');
  }
  if (snapshot.reservationLedgerTxId === null) {
    reasons.push('reservation_ledger_tx_id missing');
  }
  if (snapshot.releaseLedgerTxId !== null) {
    reasons.push('release_ledger_tx_id already set — refuse');
  }
  if (snapshot.settlementLedgerTxId !== null) {
    reasons.push('settlement_ledger_tx_id already set — refuse');
  }
  if (snapshot.hotWalletId === null) {
    reasons.push('hot_wallet_id missing');
  }
  const expectedOwner = snapshot.expectedOwnerIdentity;
  if (snapshot.lease.ownerIdentity !== expectedOwner) {
    reasons.push(
      `lease owner_identity mismatch (expected ${expectedOwner}, observed ${snapshot.lease.ownerIdentity})`,
    );
  }
  if (!snapshot.lease.unreleased) {
    reasons.push('lease already released');
  }
  if (!snapshot.lease.expired) {
    reasons.push('lease not expired — live-lease auto path may apply; refuse Owner recovery');
  }
  if (snapshot.lease.fencingToken === null) {
    reasons.push('lease fencing_token missing');
  }
  if (input.expectedFencingToken !== undefined && input.expectedFencingToken !== null) {
    if (
      snapshot.lease.fencingToken === null ||
      BigInt(snapshot.lease.fencingToken) !== input.expectedFencingToken
    ) {
      reasons.push(
        `fencing token mismatch (expected ${input.expectedFencingToken.toString(10)}, observed ${snapshot.lease.fencingToken})`,
      );
    }
  }
  if (!migrationApplied) {
    reasons.push('migration 0023_attempt_requires_state_init not applied');
  }
  return reasons;
}

function mutateEnvironmentRefuseReasons(
  input: Phase10CanaryRecoveryInput,
  currentDatabase: string,
): string[] {
  const reasons: string[] = [];

  // Operational DB must never mutate under CI, even with ops confirm.
  if (currentDatabase === 'alex_rewards' && isCiEnvironment()) {
    reasons.push('mutate refused: operational database alex_rewards cannot be mutated in CI');
  }

  if (isCiEnvironment() && !isIsolatedCiTestMutationAllowed(input, currentDatabase)) {
    reasons.push(
      'mutate refused in CI/GitHub Actions (operational recovery cannot run from CI; isolated test DB + matching non-production fixture only)',
    );
  }

  // Production canary ID cannot be mutated under NODE_ENV=test (fixture override only).
  if (
    process.env.NODE_ENV === 'test' &&
    input.withdrawalId === PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID &&
    process.env.PHASE10_CANARY_RECOVERY_TEST_FIXTURE_ID !== input.withdrawalId
  ) {
    reasons.push('mutate of production canary ID refused under NODE_ENV=test');
  }

  if (currentDatabase === 'alex_rewards' && !isCiEnvironment()) {
    const opsConfirm =
      input.operationalMutationConfirm ??
      process.env.PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM ??
      null;
    if (opsConfirm !== PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM) {
      reasons.push(
        'operational database alex_rewards requires operationalMutationConfirm / env PHASE10_CANARY_RECOVERY_OPERATIONAL_MUTATION_CONFIRM',
      );
    }
  }
  return reasons;
}

function mutateGateReasons(input: Phase10CanaryRecoveryInput): string[] {
  const reasons: string[] = [];
  const phrase = readConfirmationPhrase(input);
  if (phrase !== PHASE10_CANARY_RECOVERY_CONFIRMATION_PHRASE) {
    reasons.push(
      'confirmationPhrase mismatch — intent confirmation only; mutate refused (dry-run is default)',
    );
  }
  if (readOwnerAdminUserId(input) === null) {
    reasons.push(
      'ownerAdminUserId required — authenticated Owner with OWNER binding (phrase is not authentication)',
    );
  }
  if (
    input.ownerSessionToken === undefined ||
    input.ownerSessionToken === null ||
    input.ownerSessionToken.trim() === ''
  ) {
    reasons.push(
      'ownerSessionToken required — trusted Owner admin session (admin UUID alone is not authentication)',
    );
  }
  if (input.temporalTerminatedConfirmed !== true) {
    reasons.push('temporalTerminatedConfirmed must be true before mutate');
  }
  if (input.payoutWorkerStoppedConfirmed !== true) {
    reasons.push('payoutWorkerStoppedConfirmed must be true before mutate');
  }
  return reasons;
}

function temporalNotes(snapshot: Phase10CanaryRecoverySnapshot | null) {
  return {
    originalWorkflowId:
      snapshot?.workflowId ?? `withdrawal/${PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID}`,
    originalWorkflowMustBeTerminatedNotCompleted: true as const,
    directPipelineRequiresNewWorkflow: false as const,
    completionRecordedIn: [
      'withdrawals.state',
      'withdrawal_attempts',
      'audit_logs',
      'hot_wallet_dispatch_leases',
      'ledger settle/release (only via canonical pipeline outcomes)',
    ] as const,
  };
}

/**
 * Plan-only inspection. Never writes.
 */
export async function planPhase10CanarySigningZeroAttemptsRecovery(
  db: WithdrawalDb,
  input: Phase10CanaryRecoveryInput,
): Promise<Phase10CanaryRecoveryPlan> {
  const authPrereqs = ownerAuthPrerequisites(input);
  if (!mayBeAuthorizedWithdrawalIdWithoutDb(input.withdrawalId)) {
    return {
      mode: 'dry-run',
      authorized: false,
      accepted: false,
      refusalReasons: [
        `refusing non-canary withdrawalId=${input.withdrawalId} (only ${PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID} is allowed)`,
      ],
      snapshot: null,
      plannedTransition: null,
      temporalNotes: temporalNotes(null),
      prerequisites: {
        temporalTerminatedConfirmed: input.temporalTerminatedConfirmed === true,
        payoutWorkerStoppedConfirmed: input.payoutWorkerStoppedConfirmed === true,
        migration0023Applied: null,
        ...authPrereqs,
      },
    };
  }

  return withWithdrawalTransaction(db, async (client) => {
    const dbName = await client.query<{ current_database: string }>(`SELECT current_database()`);
    const currentDatabase = dbName.rows[0]?.current_database ?? '';
    if (!isPhase10CanaryRecoveryWithdrawalAuthorized(input.withdrawalId, currentDatabase)) {
      return {
        mode: 'dry-run' as const,
        authorized: false,
        accepted: false,
        refusalReasons: [
          currentDatabase === 'alex_rewards'
            ? 'fixture override refused against operational database alex_rewards'
            : `refusing non-canary withdrawalId=${input.withdrawalId} (only ${PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID} is allowed)`,
        ],
        snapshot: null,
        plannedTransition: null,
        temporalNotes: temporalNotes(null),
        prerequisites: {
          temporalTerminatedConfirmed: input.temporalTerminatedConfirmed === true,
          payoutWorkerStoppedConfirmed: input.payoutWorkerStoppedConfirmed === true,
          migration0023Applied: null,
          ...authPrereqs,
        },
      };
    }

    const snapshot = await loadSnapshot(client, input.withdrawalId);
    if (snapshot === null) {
      return {
        mode: 'dry-run' as const,
        authorized: false,
        accepted: false,
        refusalReasons: ['withdrawal not found'],
        snapshot: null,
        plannedTransition: null,
        temporalNotes: temporalNotes(null),
        prerequisites: {
          temporalTerminatedConfirmed: input.temporalTerminatedConfirmed === true,
          payoutWorkerStoppedConfirmed: input.payoutWorkerStoppedConfirmed === true,
          migration0023Applied: null,
          ...authPrereqs,
        },
      };
    }
    const migrationApplied = await migration0023Applied(client);
    const refusalReasons = evaluatePreconditions(
      snapshot,
      input,
      migrationApplied,
      currentDatabase,
    );
    const accepted = refusalReasons.length === 0;
    return {
      mode: 'dry-run' as const,
      authorized: false,
      accepted,
      refusalReasons,
      snapshot,
      plannedTransition: accepted
        ? {
            from: 'SIGNING' as const,
            to: 'FAILED_PRE_BROADCAST' as const,
            leaseRelease: {
              ownerIdentity: snapshot.expectedOwnerIdentity,
              fencingToken: snapshot.lease.fencingToken!,
              reason: 'FAILED_PRE_BROADCAST' as const,
            },
          }
        : null,
      temporalNotes: temporalNotes(snapshot),
      prerequisites: {
        temporalTerminatedConfirmed: input.temporalTerminatedConfirmed === true,
        payoutWorkerStoppedConfirmed: input.payoutWorkerStoppedConfirmed === true,
        migration0023Applied: migrationApplied,
        ...authPrereqs,
      },
    };
  });
}

/**
 * Atomic recovery mutation. Dry-run is default; mutate requires confirmation phrase
 * (intent only) plus authenticated Owner session (ACTIVE + OWNER binding + recent
 * reauth) and attestations. Rolls back entire transaction on any mismatch.
 */
export async function executePhase10CanarySigningZeroAttemptsRecovery(
  db: Pool,
  input: Phase10CanaryRecoveryInput,
): Promise<Phase10CanaryRecoveryExecuteResult> {
  const mode = input.mode ?? 'dry-run';
  const ownerAdminUserId = readOwnerAdminUserId(input);
  if (mode !== 'mutate') {
    const plan = await planPhase10CanarySigningZeroAttemptsRecovery(db, {
      ...input,
      mode: 'dry-run',
    });
    return {
      mode: 'mutate',
      accepted: false,
      refusalReasons: [
        'executePhase10CanarySigningZeroAttemptsRecovery requires mode=mutate; call plan* for dry-run',
        ...plan.refusalReasons,
      ],
      before: plan.snapshot,
      after: null,
      auditLogId: null,
      transition: null,
      leaseReleased: false,
      ownerAdminUserId: null,
      operatorAdminUserId: null,
    };
  }

  if (!mayBeAuthorizedWithdrawalIdWithoutDb(input.withdrawalId)) {
    return {
      mode: 'mutate',
      accepted: false,
      refusalReasons: [
        `refusing non-canary withdrawalId=${input.withdrawalId} (only ${PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID} is allowed)`,
      ],
      before: null,
      after: null,
      auditLogId: null,
      transition: null,
      leaseReleased: false,
      ownerAdminUserId: null,
      operatorAdminUserId: null,
    };
  }

  const gate = mutateGateReasons(input);
  if (gate.length > 0) {
    const plan = await planPhase10CanarySigningZeroAttemptsRecovery(db, input);
    return {
      mode: 'mutate',
      accepted: false,
      refusalReasons: gate,
      before: plan.snapshot,
      after: null,
      auditLogId: null,
      transition: null,
      leaseReleased: false,
      ownerAdminUserId,
      operatorAdminUserId: ownerAdminUserId,
    };
  }

  try {
    return await withWithdrawalTransaction(db, async (client) => {
      const dbName = await client.query<{ current_database: string }>(`SELECT current_database()`);
      const currentDatabase = dbName.rows[0]?.current_database ?? '';
      const envRefuse = mutateEnvironmentRefuseReasons(input, currentDatabase);
      if (envRefuse.length > 0) {
        return {
          mode: 'mutate' as const,
          accepted: false,
          refusalReasons: envRefuse,
          before: null,
          after: null,
          auditLogId: null,
          transition: null,
          leaseReleased: false,
          ownerAdminUserId,
          operatorAdminUserId: ownerAdminUserId,
        };
      }

      if (!isPhase10CanaryRecoveryWithdrawalAuthorized(input.withdrawalId, currentDatabase)) {
        return {
          mode: 'mutate' as const,
          accepted: false,
          refusalReasons: [
            currentDatabase === 'alex_rewards'
              ? 'fixture override refused against operational database alex_rewards'
              : `refusing non-canary withdrawalId=${input.withdrawalId} (only ${PHASE10_CANARY_RECOVERY_WITHDRAWAL_ID} is allowed)`,
          ],
          before: null,
          after: null,
          auditLogId: null,
          transition: null,
          leaseReleased: false,
          ownerAdminUserId,
          operatorAdminUserId: ownerAdminUserId,
        };
      }

      const ownerAuth = await assertAuthenticatedOwnerContext(client, input);
      if (!ownerAuth.ok) {
        return {
          mode: 'mutate' as const,
          accepted: false,
          refusalReasons: [ownerAuth.reason],
          before: null,
          after: null,
          auditLogId: null,
          transition: null,
          leaseReleased: false,
          ownerAdminUserId,
          operatorAdminUserId: ownerAdminUserId,
        };
      }

      await client.query(`SELECT id FROM withdrawals WHERE id = $1::uuid FOR UPDATE`, [
        input.withdrawalId,
      ]);
      const hwLock = await client.query<{ hot_wallet_id: string | null }>(
        `SELECT hot_wallet_id FROM withdrawals WHERE id = $1::uuid`,
        [input.withdrawalId],
      );
      if (hwLock.rows[0]?.hot_wallet_id) {
        await client.query(
          `SELECT hot_wallet_id FROM hot_wallet_dispatch_leases WHERE hot_wallet_id = $1::uuid FOR UPDATE`,
          [hwLock.rows[0].hot_wallet_id],
        );
      }

      const before = await loadSnapshot(client, input.withdrawalId);
      if (before === null) {
        throw new WithdrawalDomainError('VALIDATION', 'withdrawal not found');
      }

      // Idempotence: already recovered shape → refuse repeated mutate.
      if (before.state === 'FAILED_PRE_BROADCAST' && !before.lease.unreleased) {
        return {
          mode: 'mutate' as const,
          accepted: false,
          refusalReasons: [
            'already recovered (FAILED_PRE_BROADCAST + lease released) — repeated mutate refused',
          ],
          before,
          after: before,
          auditLogId: null,
          transition: null,
          leaseReleased: false,
          ownerAdminUserId: ownerAuth.adminUserId,
          operatorAdminUserId: ownerAuth.adminUserId,
        };
      }

      const migrationApplied = await migration0023Applied(client);
      const refusalReasons = evaluatePreconditions(
        before,
        input,
        migrationApplied,
        currentDatabase,
      );
      if (refusalReasons.length > 0) {
        return {
          mode: 'mutate' as const,
          accepted: false,
          refusalReasons,
          before,
          after: null,
          auditLogId: null,
          transition: null,
          leaseReleased: false,
          ownerAdminUserId: ownerAuth.adminUserId,
          operatorAdminUserId: ownerAuth.adminUserId,
        };
      }

      const fencingToken = BigInt(before.lease.fencingToken!);
      const transition = await transitionWithdrawal(client, {
        id: input.withdrawalId,
        from: 'SIGNING',
        to: 'FAILED_PRE_BROADCAST',
      });

      const leaseReleased = await releaseHotWalletDispatchLease(client, {
        hotWalletId: before.hotWalletId!,
        ownerIdentity: before.expectedOwnerIdentity,
        fencingToken,
        reason: 'FAILED_PRE_BROADCAST',
      });
      if (!leaseReleased) {
        throw new WithdrawalDomainError(
          'STATE_CONFLICT',
          'lease release affected 0 rows — rolling back recovery transaction',
          {
            details: {
              hotWalletId: before.hotWalletId,
              ownerIdentity: before.expectedOwnerIdentity,
              fencingToken: fencingToken.toString(10),
            },
          },
        );
      }

      const auditLogId = await insertWithdrawalAuditLog(client, {
        actionType: PHASE10_CANARY_RECOVERY_AUDIT_ACTION,
        resourceType: 'withdrawal',
        resourceId: input.withdrawalId,
        actorType: 'ADMIN',
        adminUserId: ownerAuth.adminUserId,
        reason:
          'Owner-gated canary recovery: SIGNING+0 attempts+expired lease; no broadcast evidence; Temporal terminated separately; confirmationPhrase is intent-only; Owner session+OWNER RBAC+recent reauth required',
        afterSnapshot: {
          from: 'SIGNING',
          to: 'FAILED_PRE_BROADCAST',
          leaseReleased: true,
          fencingToken: fencingToken.toString(10),
          ownerIdentity: before.expectedOwnerIdentity,
          reservationLedgerTxId: before.reservationLedgerTxId,
          workflowId: before.workflowId,
          temporalOriginalStatusExpected: 'TERMINATED',
          directPipelineRequiresNewWorkflow: false,
          ownerAdminUserId: ownerAuth.adminUserId,
          ownerSessionAuthenticated: true,
          ownerRoleBindingVerified: true,
          confirmationPhraseUsed: true,
          confirmationIsNotAuthentication: true,
          currentDatabase,
        },
      });

      const after = await loadSnapshot(client, input.withdrawalId);
      if (after === null) {
        throw new WithdrawalDomainError('INTERNAL', 'post-recovery snapshot missing');
      }
      if (after.state !== 'FAILED_PRE_BROADCAST') {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'post-recovery state mismatch', {
          details: { state: after.state },
        });
      }
      if (after.lease.unreleased) {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'lease still unreleased after recovery');
      }
      if (after.reservationLedgerTxId !== before.reservationLedgerTxId) {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'reservation_ledger_tx_id changed');
      }
      if (after.releaseLedgerTxId !== null || after.settlementLedgerTxId !== null) {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'release/settlement unexpectedly set');
      }
      if (after.attemptCount !== 0) {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'attempts appeared during recovery');
      }

      return {
        mode: 'mutate' as const,
        accepted: true,
        refusalReasons: [],
        before,
        after,
        auditLogId,
        transition,
        leaseReleased: true,
        ownerAdminUserId: ownerAuth.adminUserId,
        operatorAdminUserId: ownerAuth.adminUserId,
      };
    });
  } catch (error) {
    if (error instanceof WithdrawalDomainError) {
      return {
        mode: 'mutate',
        accepted: false,
        refusalReasons: [error.publicMessage],
        before: null,
        after: null,
        auditLogId: null,
        transition: null,
        leaseReleased: false,
        ownerAdminUserId,
        operatorAdminUserId: ownerAdminUserId,
      };
    }
    throw error;
  }
}
