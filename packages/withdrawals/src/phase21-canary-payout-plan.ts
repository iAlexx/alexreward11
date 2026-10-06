/**
 * Phase 21 Mainnet canary payout — PLAN (read-only) + future APPLY design.
 *
 * PLAN: BEGIN READ ONLY snapshot + env observations. Never mutates DB, never
 * unlocks signer, never signs, never broadcasts, never changes flags/Railway.
 *
 * APPLY: designed below but NOT implemented / NOT enabled in this module.
 * Future APPLY must remain Owner-interactive, single-withdrawal, single-broadcast,
 * persist signed BOC before send, and stop on UNKNOWN → RECONCILE_REQUIRED.
 */
import {
  PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC,
  tonAddressesEqual,
} from '@alex-rewards/ton';

import {
  PHASE21_NETWORK_CODE,
  PHASE21_NETWORK_GLOBAL_ID,
  PHASE21_WALLET_VERSION,
  buildPhase21PayoutConfig,
  listPhase21MissingResources,
} from './phase21-config.js';
import { validateProviderIndependence } from './phase21-external-probes.js';
import { PHASE21_PRODUCTION_FLAG_BASELINE } from './phase21-production-flag-baseline.js';

/** Sole Owner-authorized Mainnet canary withdrawal for ONE broadcast. */
export const PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID =
  '01a10fac-94cb-7312-aa8d-7e14a8af5390' as const;

export const PHASE21_CANARY_PAYOUT_PUBLIC_ID = 'WD-000001' as const;

export const PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC = 200_000n;
export const PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC = 10_000n;
export const PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC = 190_000n;
export const PHASE21_CANARY_PAYOUT_EXPECTED_AVAILABLE_ATOMIC = 0n;
export const PHASE21_CANARY_PAYOUT_EXPECTED_RESERVED_ATOMIC = 200_000n;

/** Exact Owner-authorized recipient (friendly). */
export const PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY =
  'EQD5XN7uWtm3r1vmzkg3N3zOYtX80OtyVf69IZwpINRXdc3l' as const;

/** Exact Owner-authorized recipient (raw). */
export const PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW =
  '0:f95cdeee5ad9b7af5be6ce4837377cce62d5fcd0eb7255febd219c2920d45775' as const;

/**
 * Must match PHASE21_OWNER_APPROVED_FORWARD_GRAM_ATOMIC in @alex-rewards/signing
 * (withdrawals cannot import signing — circular dependency).
 */
export const PHASE21_CANARY_FORWARD_TON_ATOMIC = 1n;

/**
 * Owner-approved Phase 21 Mainnet attached GRAM (wired from @alex-rewards/ton).
 * 50_000_000 nanogram = 0.05 GRAM. Not SPIKE/Testnet policy identity.
 */
export const PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE = 'OWNER_APPROVED' as const;
export const PHASE21_CANARY_ATTACHED_GRAM_ATOMIC = PHASE21_OWNER_APPROVED_ATTACHED_GRAM_ATOMIC;

/** Hard kill-switch: APPLY path is not enabled in this source slice. */
export const PHASE21_CANARY_PAYOUT_APPLY_ENABLED = false as const;

export type Phase21CanaryPayoutCheckStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'INFO';

export interface Phase21CanaryPayoutCheck {
  readonly id: string;
  readonly status: Phase21CanaryPayoutCheckStatus;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly note: string;
}

export interface Phase21CanaryPayoutPlanClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface Phase21CanaryPayoutSignerProbe {
  readonly performed: boolean;
  readonly reachable: boolean | null;
  readonly signingReady: boolean | null;
  readonly custodyState: string | null;
  readonly locked: boolean | null;
  readonly detail: string | null;
}

export interface Phase21CanaryPayoutEnvObservations {
  readonly phase21MainnetEnabled: boolean;
  readonly realChainEnabled: boolean;
  readonly fakeChainEnabled: boolean;
  readonly jettonMaster: string | null;
  readonly primaryProviderKind: string | null;
  readonly primaryProviderUrl: string | null;
  readonly secondaryProviderKind: string | null;
  readonly secondaryProviderUrl: string | null;
  readonly signerBaseUrl: string | null;
  readonly signerServiceTokenConfigured: boolean;
  readonly networkCode: string | null;
  readonly networkGlobalId: number | null;
}

/**
 * Future APPLY contract (design only — not implemented).
 * Any runtime entry that claims APPLY must refuse while APPLY_ENABLED=false.
 */
export interface Phase21CanaryPayoutFutureApplyDesign {
  readonly applyEnabled: typeof PHASE21_CANARY_PAYOUT_APPLY_ENABLED;
  readonly interactiveOwnerOnly: true;
  readonly hardCapWithdrawals: 1;
  readonly hardCapBroadcasts: 1;
  readonly bindWithdrawalId: typeof PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
  readonly bindPublicId: typeof PHASE21_CANARY_PAYOUT_PUBLIC_ID;
  readonly requireExactState: 'APPROVED';
  readonly requireExactNetAtomic: typeof PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC;
  readonly requireExactRecipientFriendly: typeof PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY;
  readonly idempotent: true;
  readonly persistSignedBocBeforeSend: true;
  readonly neverBlindResend: true;
  readonly unknownResultPolicy: 'RECONCILE_REQUIRED';
  readonly requireExplicitMainnetWorkerAuthority: true;
  readonly signerUnlockOnlyDuringSigningWindow: true;
  readonly relockSignerAfterCeremony: true;
  readonly restoreRetainSafePausesAfterCompletion: true;
  readonly neverGloballyEnablePublicWithdrawalIntake: true;
  readonly neverProcessAnotherPendingWithdrawalOrOutboxRow: true;
  readonly reuseDomainSafety: readonly [
    'runRealTestnetPayoutPipeline gates',
    'broadcast-gate persistPreBroadcastEvidence + claimFirstBroadcastSend',
    'assertBlindResendForbidden',
    'reconcileWithdrawalAttemptFromAdapter / reconcileRealWithdrawalAttemptOnly',
    'isPayoutDispatchPaused fail-closed',
    'assertPhase21Ready / Phase21 transfer policy',
  ];
}

export const PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN: Phase21CanaryPayoutFutureApplyDesign = {
  applyEnabled: false,
  interactiveOwnerOnly: true,
  hardCapWithdrawals: 1,
  hardCapBroadcasts: 1,
  bindWithdrawalId: PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  bindPublicId: PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  requireExactState: 'APPROVED',
  requireExactNetAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  requireExactRecipientFriendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  idempotent: true,
  persistSignedBocBeforeSend: true,
  neverBlindResend: true,
  unknownResultPolicy: 'RECONCILE_REQUIRED',
  requireExplicitMainnetWorkerAuthority: true,
  signerUnlockOnlyDuringSigningWindow: true,
  relockSignerAfterCeremony: true,
  restoreRetainSafePausesAfterCompletion: true,
  neverGloballyEnablePublicWithdrawalIntake: true,
  neverProcessAnotherPendingWithdrawalOrOutboxRow: true,
  reuseDomainSafety: [
    'runRealTestnetPayoutPipeline gates',
    'broadcast-gate persistPreBroadcastEvidence + claimFirstBroadcastSend',
    'assertBlindResendForbidden',
    'reconcileWithdrawalAttemptFromAdapter / reconcileRealWithdrawalAttemptOnly',
    'isPayoutDispatchPaused fail-closed',
    'assertPhase21Ready / Phase21 transfer policy',
  ],
};

export interface Phase21CanaryPayoutPlanResult {
  readonly ok: boolean;
  readonly mode: 'PLAN';
  readonly applied: false;
  readonly readOnly: true;
  readonly mutated: false;
  readonly signed: false;
  readonly broadcast: false;
  readonly readyForLivePayout: false;
  readonly applyEnabled: false;
  readonly withdrawalId: string;
  readonly checks: readonly Phase21CanaryPayoutCheck[];
  readonly snapshot: Record<string, unknown> | null;
  readonly intendedTransfer: {
    readonly recipientFriendly: typeof PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY;
    readonly usdtNetAtomic: typeof PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC;
    readonly forwardTonAtomic: typeof PHASE21_CANARY_FORWARD_TON_ATOMIC;
    readonly forwardGramAtomic: typeof PHASE21_CANARY_FORWARD_TON_ATOMIC;
    readonly attachedGramLifecycle: typeof PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE;
    readonly status: typeof PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE;
    readonly attachedGramAtomic: string;
    readonly attachedGramAtomicOwnerApproved: string;
    readonly attachedGramNote: string;
  };
  readonly runtimeRequirementsEnumeratedNotApplied: readonly string[];
  readonly futureApplyDesign: Phase21CanaryPayoutFutureApplyDesign;
  readonly refuseCode?: string;
  readonly message?: string;
}

function envNonEmpty(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function envFlagTrue(name: string): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return false;
  return raw.trim().toLowerCase() === 'true';
}

export function observePhase21CanaryPayoutEnv(): Phase21CanaryPayoutEnvObservations {
  const globalIdRaw = envNonEmpty('SIGNER_NETWORK_GLOBAL_ID');
  const networkGlobalId =
    globalIdRaw !== null && Number.isFinite(Number(globalIdRaw)) ? Number(globalIdRaw) : null;
  const token = envNonEmpty('SIGNER_SERVICE_TOKEN');
  return {
    phase21MainnetEnabled: envFlagTrue('PHASE21_MAINNET_ENABLED'),
    realChainEnabled: envFlagTrue('WITHDRAWAL_REAL_CHAIN_ENABLED'),
    fakeChainEnabled: envFlagTrue('WITHDRAWAL_FAKE_CHAIN_ENABLED'),
    jettonMaster: envNonEmpty('TON_MAINNET_USDT_JETTON_MASTER'),
    primaryProviderKind: envNonEmpty('TON_PRIMARY_PROVIDER_KIND'),
    primaryProviderUrl: envNonEmpty('TON_PRIMARY_PROVIDER_URL'),
    secondaryProviderKind: envNonEmpty('TON_SECONDARY_PROVIDER_KIND'),
    secondaryProviderUrl: envNonEmpty('TON_SECONDARY_PROVIDER_URL'),
    signerBaseUrl: envNonEmpty('SIGNER_BASE_URL'),
    signerServiceTokenConfigured: token !== null && token.length >= 32,
    networkCode: envNonEmpty('WITHDRAWAL_NETWORK_CODE'),
    networkGlobalId,
  };
}

export async function probePhase21CanarySignerLockedReadOnly(
  signerBaseUrl: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<Phase21CanaryPayoutSignerProbe> {
  if (signerBaseUrl === null || signerBaseUrl.trim() === '') {
    return {
      performed: false,
      reachable: null,
      signingReady: null,
      custodyState: null,
      locked: null,
      detail: 'SIGNER_BASE_URL not configured; signer lock not probed',
    };
  }
  const url = `${signerBaseUrl.replace(/\/$/, '')}/health/ready`;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const signingReady = body.signingReady === true;
    const custodyState =
      typeof body.custodyState === 'string' && body.custodyState.trim() !== ''
        ? body.custodyState.trim()
        : null;
    return {
      performed: true,
      reachable: true,
      signingReady,
      custodyState,
      locked: !signingReady,
      detail: response.ok ? null : `signer /health/ready HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      performed: true,
      reachable: false,
      signingReady: null,
      custodyState: null,
      locked: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function pass(
  id: string,
  note: string,
  expected?: unknown,
  actual?: unknown,
): Phase21CanaryPayoutCheck {
  return { id, status: 'PASS', expected, actual, note };
}

function fail(
  id: string,
  note: string,
  expected?: unknown,
  actual?: unknown,
): Phase21CanaryPayoutCheck {
  return { id, status: 'FAIL', expected, actual, note };
}

function blocked(
  id: string,
  note: string,
  expected?: unknown,
  actual?: unknown,
): Phase21CanaryPayoutCheck {
  return { id, status: 'BLOCKED', expected, actual, note };
}

function info(
  id: string,
  note: string,
  expected?: unknown,
  actual?: unknown,
): Phase21CanaryPayoutCheck {
  return { id, status: 'INFO', expected, actual, note };
}

function enumerateRuntimeRequirementsNotApplied(
  env: Phase21CanaryPayoutEnvObservations,
): string[] {
  const missing: string[] = [];
  if (!env.phase21MainnetEnabled) {
    missing.push('PHASE21_MAINNET_ENABLED=true (NOT applied by PLAN)');
  }
  if (!env.realChainEnabled) {
    missing.push('WITHDRAWAL_REAL_CHAIN_ENABLED=true (NOT applied by PLAN)');
  }
  if (env.fakeChainEnabled) {
    missing.push('WITHDRAWAL_FAKE_CHAIN_ENABLED=false (NOT applied by PLAN)');
  }
  if (env.jettonMaster === null) {
    missing.push('TON_MAINNET_USDT_JETTON_MASTER (observed; NOT applied by PLAN)');
  }
  if (env.primaryProviderKind === null || env.primaryProviderUrl === null) {
    missing.push('TON_PRIMARY_PROVIDER_* (observed; NOT applied by PLAN)');
  }
  if (env.secondaryProviderKind === null || env.secondaryProviderUrl === null) {
    missing.push('TON_SECONDARY_PROVIDER_* (observed; NOT applied by PLAN)');
  }
  if (env.signerBaseUrl === null || !env.signerServiceTokenConfigured) {
    missing.push('SIGNER_BASE_URL + SIGNER_SERVICE_TOKEN (observed; NOT applied by PLAN)');
  }
  if (env.networkCode !== null && env.networkCode !== PHASE21_NETWORK_CODE) {
    missing.push(`WITHDRAWAL_NETWORK_CODE=${PHASE21_NETWORK_CODE} (NOT applied by PLAN)`);
  }
  if (env.networkGlobalId !== null && env.networkGlobalId !== PHASE21_NETWORK_GLOBAL_ID) {
    missing.push(`SIGNER_NETWORK_GLOBAL_ID=${PHASE21_NETWORK_GLOBAL_ID} (NOT applied by PLAN)`);
  }
  try {
    const cfg = buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: env.realChainEnabled,
      fakeChainEnabled: env.fakeChainEnabled,
      signerBaseUrl: env.signerBaseUrl ?? '',
      signerServiceToken: process.env.SIGNER_SERVICE_TOKEN ?? '',
      jettonMasterIdentity: env.jettonMaster,
      primaryProviderKind: env.primaryProviderKind,
      primaryProviderUrl: env.primaryProviderUrl,
      secondaryProviderKind: env.secondaryProviderKind,
      secondaryProviderUrl: env.secondaryProviderUrl,
    });
    for (const m of listPhase21MissingResources(cfg)) {
      missing.push(`${m} (enumerated; NOT applied by PLAN)`);
    }
  } catch (error: unknown) {
    missing.push(
      `PHASE21_CONFIG: ${error instanceof Error ? error.message : String(error)} (enumerated; NOT applied by PLAN)`,
    );
  }
  return [...new Set(missing)];
}

/**
 * Read-only PLAN for the Owner-authorized Phase 21 Mainnet canary payout.
 * Uses BEGIN READ ONLY / ROLLBACK. Never writes.
 */
export async function planPhase21CanaryPayout(
  client: Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly env?: Phase21CanaryPayoutEnvObservations;
    readonly signerProbe?: Phase21CanaryPayoutSignerProbe;
  },
): Promise<Phase21CanaryPayoutPlanResult> {
  const env = input.env ?? observePhase21CanaryPayoutEnv();
  const checks: Phase21CanaryPayoutCheck[] = [];
  const intendedTransfer = {
    recipientFriendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
    usdtNetAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
    forwardTonAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
    forwardGramAtomic: PHASE21_CANARY_FORWARD_TON_ATOMIC,
    attachedGramLifecycle: PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE,
    status: PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE,
    attachedGramAtomic: PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10),
    attachedGramAtomicOwnerApproved: PHASE21_CANARY_ATTACHED_GRAM_ATOMIC.toString(10),
    attachedGramNote:
      'Owner-approved Phase 21 Mainnet attached GRAM = 50000000 nanogram (0.05 GRAM) from prior Mainnet fee-estimate decision; source wiring reflects OWNER_APPROVED. Not SPIKE/Testnet defaults.',
  } as const;

  const runtimeRequirementsEnumeratedNotApplied = enumerateRuntimeRequirementsNotApplied(env);

  if (input.withdrawalId !== PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID) {
    checks.push(
      fail(
        'canary_withdrawal_id_bind',
        'PLAN hard-binds to the sole Owner-authorized canary withdrawal',
        PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
        input.withdrawalId,
      ),
    );
    return {
      ok: false,
      mode: 'PLAN',
      applied: false,
      readOnly: true,
      mutated: false,
      signed: false,
      broadcast: false,
      readyForLivePayout: false,
      applyEnabled: false,
      withdrawalId: input.withdrawalId,
      checks,
      snapshot: null,
      intendedTransfer,
      runtimeRequirementsEnumeratedNotApplied,
      futureApplyDesign: PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
      refuseCode: 'CANARY_WITHDRAWAL_ID_MISMATCH',
      message: 'withdrawal-id is not the sole Owner-authorized Phase 21 canary',
    };
  }
  checks.push(
    pass(
      'canary_withdrawal_id_bind',
      'bound to sole Owner-authorized canary withdrawal',
      PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
      input.withdrawalId,
    ),
  );

  await client.query('BEGIN READ ONLY');
  try {
    const ro = await client.query<{ transaction_read_only: string }>(
      `SHOW transaction_read_only`,
    );
    const flag = (ro.rows[0]?.transaction_read_only ?? '').toLowerCase();
    if (flag !== 'on' && flag !== 'true') {
      checks.push(
        fail(
          'read_only_transaction',
          'SHOW transaction_read_only must be on for canary PLAN',
          'on',
          flag,
        ),
      );
      return {
        ok: false,
        mode: 'PLAN',
        applied: false,
        readOnly: true,
        mutated: false,
        signed: false,
        broadcast: false,
        readyForLivePayout: false,
        applyEnabled: false,
        withdrawalId: input.withdrawalId,
        checks,
        snapshot: null,
        intendedTransfer,
        runtimeRequirementsEnumeratedNotApplied,
        futureApplyDesign: PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
        refuseCode: 'READ_ONLY_TRANSACTION_REQUIRED',
      };
    }
    checks.push(pass('read_only_transaction', 'PLAN uses BEGIN READ ONLY', 'on', flag));

    const w = await client.query<{
      id: string;
      public_id: string;
      state: string;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      user_id: string;
      asset_id: string;
      network_id: string;
      wallet_id: string;
      hot_wallet_id: string | null;
      workflow_id: string | null;
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
      settlement_ledger_tx_id: string | null;
    }>(
      `SELECT w.id::text AS id, w.public_id, w.state::text AS state,
              w.requested_amount_atomic::text AS requested_amount_atomic,
              w.fee_amount_atomic::text AS fee_amount_atomic,
              w.net_amount_atomic::text AS net_amount_atomic,
              w.user_id::text AS user_id, w.asset_id::text AS asset_id,
              w.network_id::text AS network_id, w.wallet_id::text AS wallet_id,
              w.hot_wallet_id::text AS hot_wallet_id,
              w.workflow_id, w.reservation_ledger_tx_id::text AS reservation_ledger_tx_id,
              w.release_ledger_tx_id::text AS release_ledger_tx_id,
              w.settlement_ledger_tx_id::text AS settlement_ledger_tx_id
       FROM withdrawals w
       WHERE w.id = $1::uuid`,
      [input.withdrawalId],
    );
    const row = w.rows[0];
    if (row === undefined) {
      checks.push(fail('withdrawal_exists', 'withdrawal row must exist', true, false));
      return {
        ok: false,
        mode: 'PLAN',
        applied: false,
        readOnly: true,
        mutated: false,
        signed: false,
        broadcast: false,
        readyForLivePayout: false,
        applyEnabled: false,
        withdrawalId: input.withdrawalId,
        checks,
        snapshot: null,
        intendedTransfer,
        runtimeRequirementsEnumeratedNotApplied,
        futureApplyDesign: PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
        refuseCode: 'WITHDRAWAL_NOT_FOUND',
      };
    }

    if (row.public_id === PHASE21_CANARY_PAYOUT_PUBLIC_ID && row.state === 'APPROVED') {
      checks.push(
        pass(
          'withdrawal_public_id_and_state',
          'exact WD-000001 + APPROVED',
          { publicId: PHASE21_CANARY_PAYOUT_PUBLIC_ID, state: 'APPROVED' },
          { publicId: row.public_id, state: row.state },
        ),
      );
    } else {
      checks.push(
        fail(
          'withdrawal_public_id_and_state',
          'exact WD-000001 + APPROVED required',
          { publicId: PHASE21_CANARY_PAYOUT_PUBLIC_ID, state: 'APPROVED' },
          { publicId: row.public_id, state: row.state },
        ),
      );
    }

    const grossOk = BigInt(row.requested_amount_atomic) === PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC;
    const feeOk = BigInt(row.fee_amount_atomic) === PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC;
    const netOk = BigInt(row.net_amount_atomic) === PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC;
    if (grossOk && feeOk && netOk) {
      checks.push(
        pass(
          'exact_amounts',
          'gross/fee/net match Owner-authorized canary economics',
          {
            gross: PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10),
            fee: PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10),
            net: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10),
          },
          {
            gross: row.requested_amount_atomic,
            fee: row.fee_amount_atomic,
            net: row.net_amount_atomic,
          },
        ),
      );
    } else {
      checks.push(
        fail(
          'exact_amounts',
          'gross/fee/net mismatch',
          {
            gross: PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10),
            fee: PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10),
            net: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10),
          },
          {
            gross: row.requested_amount_atomic,
            fee: row.fee_amount_atomic,
            net: row.net_amount_atomic,
          },
        ),
      );
    }

    const approvals = await client.query<{ c: number; approve_count: number }>(
      `SELECT count(*)::int AS c,
              count(*) FILTER (WHERE decision::text = 'APPROVE')::int AS approve_count
       FROM withdrawal_approvals
       WHERE withdrawal_id = $1::uuid`,
      [input.withdrawalId],
    );
    const approvalCount = approvals.rows[0]?.c ?? 0;
    const approveCount = approvals.rows[0]?.approve_count ?? 0;
    if (approvalCount === 1 && approveCount === 1) {
      checks.push(
        pass('exactly_one_approval', 'exactly one APPROVE approval row', 1, approvalCount),
      );
    } else {
      checks.push(
        fail(
          'exactly_one_approval',
          'exactly one APPROVE approval required',
          { total: 1, approve: 1 },
          { total: approvalCount, approve: approveCount },
        ),
      );
    }

    const attempts = await client.query<{
      c: number;
      signature_evidence: number;
      submitted: number;
      chain_ref: number;
      broadcast_started: number;
      ambiguous: number;
    }>(
      `SELECT count(*)::int AS c,
              count(*) FILTER (
                WHERE signed_external_message_boc IS NOT NULL
                   OR signed_wallet_request_boc IS NOT NULL
                   OR external_message_cell_hash IS NOT NULL
                   OR normalized_external_message_hash IS NOT NULL
                   OR signed_message_hash IS NOT NULL
              )::int AS signature_evidence,
              count(*) FILTER (WHERE broadcast_submitted_at IS NOT NULL)::int AS submitted,
              count(*) FILTER (
                WHERE chain_reference IS NOT NULL AND btrim(chain_reference) <> ''
              )::int AS chain_ref,
              count(*) FILTER (WHERE broadcast_started_at IS NOT NULL)::int AS broadcast_started,
              count(*) FILTER (
                WHERE broadcast_result_state::text IN (
                  'PENDING', 'UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED'
                )
              )::int AS ambiguous
       FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid`,
      [input.withdrawalId],
    );
    const attemptCount = attempts.rows[0]?.c ?? 0;
    const signatureEvidence = attempts.rows[0]?.signature_evidence ?? 0;
    const submitted = attempts.rows[0]?.submitted ?? 0;
    const chainRef = attempts.rows[0]?.chain_ref ?? 0;
    const broadcastStarted = attempts.rows[0]?.broadcast_started ?? 0;
    const ambiguous = attempts.rows[0]?.ambiguous ?? 0;

    if (attemptCount === 0) {
      checks.push(pass('zero_attempts', 'exactly zero withdrawal_attempts', 0, attemptCount));
    } else {
      checks.push(fail('zero_attempts', 'attempts must be zero for virgin canary', 0, attemptCount));
    }

    if (
      signatureEvidence === 0 &&
      submitted === 0 &&
      chainRef === 0 &&
      broadcastStarted === 0 &&
      ambiguous === 0
    ) {
      checks.push(
        pass(
          'no_broadcast_or_reconcile_evidence',
          'no signature/broadcast/UNKNOWN/reconcile evidence',
          0,
          {
            signatureEvidence,
            submitted,
            chainRef,
            broadcastStarted,
            ambiguous,
          },
        ),
      );
    } else {
      checks.push(
        fail(
          'no_broadcast_or_reconcile_evidence',
          'broadcast/signature/UNKNOWN/reconcile evidence present — RECONCILE FIRST, NEVER RESEND',
          0,
          {
            signatureEvidence,
            submitted,
            chainRef,
            broadcastStarted,
            ambiguous,
          },
        ),
      );
    }

    const wallet = await client.query<{
      friendly_address: string;
      raw_address: string;
      is_primary: boolean;
      verified: boolean;
      verification_method: string | null;
      disabled_at: Date | null;
      network_code: string;
    }>(
      `SELECT uw.friendly_address, uw.raw_address, uw.is_primary, uw.verified,
              uw.verification_method::text AS verification_method, uw.disabled_at,
              n.code AS network_code
       FROM user_wallets uw
       JOIN networks n ON n.id = uw.network_id
       WHERE uw.id = $1::uuid`,
      [row.wallet_id],
    );
    const walletRow = wallet.rows[0];
    if (walletRow === undefined) {
      checks.push(fail('recipient_wallet', 'withdrawal wallet row missing', true, false));
    } else {
      const recipientMatch =
        tonAddressesEqual(
          walletRow.friendly_address,
          PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
        ) ||
        tonAddressesEqual(walletRow.raw_address, PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW) ||
        tonAddressesEqual(
          walletRow.raw_address,
          PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
        );
      const recipientOk =
        recipientMatch &&
        walletRow.is_primary === true &&
        walletRow.verified === true &&
        walletRow.verification_method === 'TON_PROOF' &&
        walletRow.disabled_at === null &&
        walletRow.network_code === PHASE21_NETWORK_CODE;
      if (recipientOk) {
        checks.push(
          pass(
            'recipient_wallet',
            'exact verified primary TON_PROOF Mainnet wallet',
            {
              friendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
              primary: true,
              verified: true,
              method: 'TON_PROOF',
              disabled: false,
              network: PHASE21_NETWORK_CODE,
            },
            {
              friendly: walletRow.friendly_address,
              raw: walletRow.raw_address,
              primary: walletRow.is_primary,
              verified: walletRow.verified,
              method: walletRow.verification_method,
              disabled: walletRow.disabled_at !== null,
              network: walletRow.network_code,
            },
          ),
        );
      } else {
        checks.push(
          fail(
            'recipient_wallet',
            'recipient wallet does not match Owner-authorized verified primary Mainnet TON_PROOF wallet',
            {
              friendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
              primary: true,
              verified: true,
              method: 'TON_PROOF',
              disabled: false,
              network: PHASE21_NETWORK_CODE,
            },
            {
              friendly: walletRow.friendly_address,
              raw: walletRow.raw_address,
              primary: walletRow.is_primary,
              verified: walletRow.verified,
              method: walletRow.verification_method,
              disabled: walletRow.disabled_at !== null,
              network: walletRow.network_code,
            },
          ),
        );
      }
    }

    const balances = await client.query<{
      account_type: string;
      balance_atomic: string;
    }>(
      `SELECT la.account_type::text AS account_type,
              COALESCE(lab.balance_atomic, 0)::text AS balance_atomic
       FROM ledger_accounts la
       LEFT JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
       WHERE la.owner_id = $1::uuid
         AND la.asset_id = $2::uuid
         AND la.account_type IN ('USER_AVAILABLE_LIABILITY', 'USER_RESERVED_LIABILITY')`,
      [row.user_id, row.asset_id],
    );
    const availableAtomic =
      balances.rows.find((b) => b.account_type === 'USER_AVAILABLE_LIABILITY')?.balance_atomic ??
      null;
    const reservedAtomic =
      balances.rows.find((b) => b.account_type === 'USER_RESERVED_LIABILITY')?.balance_atomic ??
      null;
    const availableOk =
      availableAtomic !== null &&
      BigInt(availableAtomic) === PHASE21_CANARY_PAYOUT_EXPECTED_AVAILABLE_ATOMIC;
    const reservedOk =
      reservedAtomic !== null &&
      BigInt(reservedAtomic) === PHASE21_CANARY_PAYOUT_EXPECTED_RESERVED_ATOMIC;
    if (availableOk && reservedOk) {
      checks.push(
        pass(
          'ledger_available_reserved',
          'Available=0 and Reserved=200000',
          {
            available: PHASE21_CANARY_PAYOUT_EXPECTED_AVAILABLE_ATOMIC.toString(10),
            reserved: PHASE21_CANARY_PAYOUT_EXPECTED_RESERVED_ATOMIC.toString(10),
          },
          { available: availableAtomic, reserved: reservedAtomic },
        ),
      );
    } else {
      checks.push(
        fail(
          'ledger_available_reserved',
          'Available/Reserved mismatch',
          {
            available: PHASE21_CANARY_PAYOUT_EXPECTED_AVAILABLE_ATOMIC.toString(10),
            reserved: PHASE21_CANARY_PAYOUT_EXPECTED_RESERVED_ATOMIC.toString(10),
          },
          { available: availableAtomic, reserved: reservedAtomic },
        ),
      );
    }

    const network = await client.query<{
      id: string;
      code: string;
      status: string;
    }>(
      `SELECT id::text AS id, code, status::text AS status
       FROM networks WHERE id = $1::uuid`,
      [row.network_id],
    );
    const net = network.rows[0];
    const asset = await client.query<{
      symbol: string;
      decimals: number;
      is_native: boolean;
      contract_identity: string | null;
      status: string;
    }>(
      `SELECT symbol, decimals, is_native, contract_identity, status::text AS status
       FROM assets WHERE id = $1::uuid`,
      [row.asset_id],
    );
    const assetRow = asset.rows[0];
    const registryOk =
      net?.code === PHASE21_NETWORK_CODE &&
      assetRow?.symbol === 'USDT' &&
      assetRow.decimals === 6 &&
      assetRow.is_native === false &&
      (env.jettonMaster === null ||
        (assetRow.contract_identity !== null &&
          tonAddressesEqual(assetRow.contract_identity, env.jettonMaster)));
    if (registryOk) {
      checks.push(
        pass(
          'mainnet_usdt_registry',
          'withdrawal network/USDT registry matches Mainnet USDT',
          {
            network: PHASE21_NETWORK_CODE,
            symbol: 'USDT',
            decimals: 6,
            jettonMasterEnv: env.jettonMaster,
          },
          {
            network: net?.code ?? null,
            symbol: assetRow?.symbol ?? null,
            decimals: assetRow?.decimals ?? null,
            contractIdentity: assetRow?.contract_identity ?? null,
          },
        ),
      );
    } else {
      checks.push(
        fail(
          'mainnet_usdt_registry',
          'Mainnet network/USDT registry mismatch',
          {
            network: PHASE21_NETWORK_CODE,
            symbol: 'USDT',
            decimals: 6,
            jettonMasterEnv: env.jettonMaster,
          },
          {
            network: net?.code ?? null,
            symbol: assetRow?.symbol ?? null,
            decimals: assetRow?.decimals ?? null,
            isNative: assetRow?.is_native ?? null,
            contractIdentity: assetRow?.contract_identity ?? null,
          },
        ),
      );
    }

    const hot = await client.query<{
      id: string;
      address: string;
      friendly_address: string | null;
      wallet_version: string;
      signer_type: string;
      status: string;
      network_code: string;
    }>(
      `SELECT hw.id::text AS id, hw.address, hw.friendly_address, hw.wallet_version,
              hw.signer_type::text AS signer_type, hw.status::text AS status,
              n.code AS network_code
       FROM hot_wallets hw
       JOIN networks n ON n.id = hw.network_id
       WHERE n.code = $1
         AND hw.status = 'ACTIVE'
         AND hw.signer_type = 'FALLBACK_ENCRYPTED'
         AND hw.wallet_version = $2`,
      [PHASE21_NETWORK_CODE, PHASE21_WALLET_VERSION],
    );
    if (hot.rows.length === 1) {
      const hw = hot.rows[0]!;
      const boundOk =
        row.hot_wallet_id === null || row.hot_wallet_id === hw.id;
      if (boundOk) {
        checks.push(
          pass(
            'hot_wallet_identity',
            'exactly one ACTIVE FALLBACK_ENCRYPTED v5R1 Mainnet Hot Wallet; withdrawal binding matches when set',
            { count: 1, walletVersion: PHASE21_WALLET_VERSION },
            {
              count: 1,
              hotWalletId: hw.id,
              address: hw.address,
              friendlyAddress: hw.friendly_address,
              withdrawalHotWalletId: row.hot_wallet_id,
            },
          ),
        );
      } else {
        checks.push(
          fail(
            'hot_wallet_identity',
            'withdrawal.hot_wallet_id does not match registered Mainnet Hot Wallet',
            hw.id,
            row.hot_wallet_id,
          ),
        );
      }
    } else {
      checks.push(
        fail(
          'hot_wallet_identity',
          'expected exactly one ACTIVE FALLBACK_ENCRYPTED v5R1 Mainnet Hot Wallet',
          1,
          hot.rows.length,
        ),
      );
    }

    checks.push(
      info(
        'runtime_requirements_enumerated_not_applied',
        'PHASE21 Mainnet runtime requirements enumerated; PLAN does not apply them',
        undefined,
        runtimeRequirementsEnumeratedNotApplied,
      ),
    );

    const signerProbe =
      input.signerProbe ??
      ({
        performed: false,
        reachable: null,
        signingReady: null,
        custodyState: null,
        locked: null,
        detail: 'signer probe not supplied to planPhase21CanaryPayout',
      } satisfies Phase21CanaryPayoutSignerProbe);
    if (signerProbe.locked === true) {
      checks.push(
        pass(
          'signer_locked',
          'signer currently LOCKED (signingReady=false)',
          true,
          {
            locked: signerProbe.locked,
            signingReady: signerProbe.signingReady,
            custodyState: signerProbe.custodyState,
          },
        ),
      );
    } else if (signerProbe.locked === false) {
      checks.push(
        fail(
          'signer_locked',
          'signer is UNLOCKED — PLAN requires LOCKED; do not unlock during PLAN',
          true,
          {
            locked: false,
            signingReady: signerProbe.signingReady,
            custodyState: signerProbe.custodyState,
          },
        ),
      );
    } else {
      checks.push(
        fail(
          'signer_locked',
          'signer lock not proven (probe missing/unreachable)',
          true,
          signerProbe,
        ),
      );
    }

    const pauseKeys = [
      'PAYOUT_DISPATCH_PAUSE',
      'WITHDRAWAL_REQUESTS_PAUSE',
      'AUTO_PAYOUT_PAUSE',
    ] as const;
    for (const flagKey of pauseKeys) {
      const flagRow = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags
         WHERE flag_key = $1 AND environment = 'PRODUCTION'::environment_name
         LIMIT 1`,
        [flagKey],
      );
      const enabled = flagRow.rows[0]?.enabled;
      if (enabled === true) {
        checks.push(
          pass(flagKey.toLowerCase(), `${flagKey} remains true (paused)`, true, enabled),
        );
      } else {
        checks.push(
          fail(
            flagKey.toLowerCase(),
            `${flagKey} must remain true (paused) for canary PLAN`,
            true,
            enabled ?? null,
          ),
        );
      }
    }

    const rewardPauseKeys = [
      'GLOBAL_REWARDS_PAUSE',
      'REFERRAL_REWARD_PAUSE',
      'MISSION_REWARD_PAUSE',
      'MEMBERSHIP_BONUS_PAUSE',
    ] as const;
    for (const flagKey of rewardPauseKeys) {
      const flagRow = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM feature_flags
         WHERE flag_key = $1 AND environment = 'PRODUCTION'::environment_name
         LIMIT 1`,
        [flagKey],
      );
      const enabled = flagRow.rows[0]?.enabled;
      const baseline = PHASE21_PRODUCTION_FLAG_BASELINE.find((f) => f.flagKey === flagKey);
      if (enabled === true && baseline?.enabled === true) {
        checks.push(
          pass(
            `${flagKey.toLowerCase()}_not_enabled_for_canary`,
            `${flagKey} remains paused — AdsGram/referral/mission/general payout not enabled by this operation`,
            true,
            enabled,
          ),
        );
      } else {
        checks.push(
          fail(
            `${flagKey.toLowerCase()}_not_enabled_for_canary`,
            `${flagKey} must remain paused; canary must not enable AdsGram/referral/mission/general payout state`,
            true,
            enabled ?? null,
          ),
        );
      }
    }

    const independence = validateProviderIndependence(
      {
        kind: env.primaryProviderKind,
        url: env.primaryProviderUrl,
      },
      {
        kind: env.secondaryProviderKind,
        url: env.secondaryProviderUrl,
      },
    );
    if (independence.ok) {
      checks.push(
        pass(
          'two_provider_reconciliation_independent',
          'two-provider reconciliation configuration present and independent',
          true,
          independence,
        ),
      );
    } else {
      checks.push(
        fail(
          'two_provider_reconciliation_independent',
          independence.message,
          true,
          independence,
        ),
      );
    }

    const attachedApproved =
      PHASE21_CANARY_ATTACHED_GRAM_LIFECYCLE === 'OWNER_APPROVED' &&
      PHASE21_CANARY_ATTACHED_GRAM_ATOMIC === 50_000_000n &&
      intendedTransfer.attachedGramAtomic === '50000000' &&
      intendedTransfer.status === 'OWNER_APPROVED';
    const forwardApproved =
      PHASE21_CANARY_FORWARD_TON_ATOMIC === 1n &&
      intendedTransfer.forwardTonAtomic === 1n &&
      intendedTransfer.forwardGramAtomic === 1n;
    if (attachedApproved && forwardApproved) {
      checks.push(
        pass(
          'intended_transfer',
          'exact intended transfer: Owner-approved attached=50000000, forward=1',
          {
            recipient: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
            usdtNetAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10),
            forwardGramAtomic: '1',
            attachedGramAtomic: '50000000',
            status: 'OWNER_APPROVED',
          },
          intendedTransfer,
        ),
      );
    } else {
      checks.push(
        fail(
          'intended_transfer',
          'canary attached/forward source truth mismatch',
          {
            attachedGramAtomic: '50000000',
            status: 'OWNER_APPROVED',
            forwardGramAtomic: '1',
          },
          intendedTransfer,
        ),
      );
    }

    checks.push(
      blocked(
        'apply_not_enabled',
        'Future APPLY designed but not enabled/implemented in this task',
        false,
        PHASE21_CANARY_PAYOUT_APPLY_ENABLED,
      ),
    );

    const failing = checks.filter((c) => c.status === 'FAIL');
    const ok = failing.length === 0;

    const snapshot = {
      withdrawalId: row.id,
      publicId: row.public_id,
      state: row.state,
      grossAtomic: row.requested_amount_atomic,
      feeAtomic: row.fee_amount_atomic,
      netAtomic: row.net_amount_atomic,
      approvalCount,
      approveCount,
      attemptCount,
      signatureEvidence,
      broadcastSubmitted: submitted,
      chainReference: chainRef,
      broadcastStarted,
      ambiguousOutcome: ambiguous,
      availableAtomic,
      reservedAtomic,
      wallet: walletRow
        ? {
            friendly: walletRow.friendly_address,
            raw: walletRow.raw_address,
            primary: walletRow.is_primary,
            verified: walletRow.verified,
            verificationMethod: walletRow.verification_method,
            disabled: walletRow.disabled_at !== null,
            network: walletRow.network_code,
          }
        : null,
      hotWallet:
        hot.rows.length === 1
          ? {
              id: hot.rows[0]!.id,
              address: hot.rows[0]!.address,
              friendlyAddress: hot.rows[0]!.friendly_address,
              walletVersion: hot.rows[0]!.wallet_version,
              signerType: hot.rows[0]!.signer_type,
              status: hot.rows[0]!.status,
            }
          : { count: hot.rows.length },
      workflowId: row.workflow_id,
      reservationLedgerTxId: row.reservation_ledger_tx_id,
      releaseLedgerTxId: row.release_ledger_tx_id,
      settlementLedgerTxId: row.settlement_ledger_tx_id,
      signerProbe,
      envObservations: {
        phase21MainnetEnabled: env.phase21MainnetEnabled,
        realChainEnabled: env.realChainEnabled,
        fakeChainEnabled: env.fakeChainEnabled,
        jettonMasterConfigured: env.jettonMaster !== null,
        primaryProviderKind: env.primaryProviderKind,
        secondaryProviderKind: env.secondaryProviderKind,
        signerBaseUrlConfigured: env.signerBaseUrl !== null,
      },
    };

    return {
      ok,
      mode: 'PLAN',
      applied: false,
      readOnly: true,
      mutated: false,
      signed: false,
      broadcast: false,
      readyForLivePayout: false,
      applyEnabled: false,
      withdrawalId: input.withdrawalId,
      checks,
      snapshot,
      intendedTransfer,
      runtimeRequirementsEnumeratedNotApplied,
      futureApplyDesign: PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
      ...(ok
        ? {
            message: 'Phase 21 canary PLAN complete (read-only). APPLY not enabled.',
          }
        : {
            refuseCode: 'CANARY_PLAN_CHECKS_FAILED',
            message: 'Phase 21 canary PLAN completed with FAIL checks. No mutation.',
          }),
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

/** Always refuses — APPLY is designed but not enabled in this source slice. */
export function refusePhase21CanaryPayoutApply(): {
  readonly ok: false;
  readonly mode: 'APPLY_REFUSED';
  readonly applied: false;
  readonly refuseCode: 'PHASE21_CANARY_PAYOUT_APPLY_NOT_ENABLED';
  readonly applyEnabled: false;
  readonly futureApplyDesign: Phase21CanaryPayoutFutureApplyDesign;
  readonly readyForLivePayout: false;
  readonly message: string;
} {
  return {
    ok: false,
    mode: 'APPLY_REFUSED',
    applied: false,
    refuseCode: 'PHASE21_CANARY_PAYOUT_APPLY_NOT_ENABLED',
    applyEnabled: false,
    futureApplyDesign: PHASE21_CANARY_PAYOUT_FUTURE_APPLY_DESIGN,
    readyForLivePayout: false,
    message:
      'Phase 21 canary APPLY is designed but not enabled. Wait for a later explicit Owner instruction.',
  };
}
