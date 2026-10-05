/**
 * Read-only chain reconciliation for FULL_STEP2B.
 * Zero-scope path: empty restored chain state => PASS without provider calls.
 * Nonzero path: observation-only runPhase10ChainHistoryReadonlyValidate
 * with per-CONFIRMED individual TEP-74 matching (never count-only proof).
 */
import {
  assertPhase10ReadonlyValidationReportIntegrity,
  buildPhase10EconomicKey,
  checkPhase10PayoutInvariants,
  runPhase10ChainHistoryReadonlyValidate,
} from '@alex-rewards/withdrawals';

type Phase10ReadonlyValidationReport = Awaited<
  ReturnType<typeof runPhase10ChainHistoryReadonlyValidate>
>;
type RunPhase10ChainHistoryReadonlyValidateInput = Parameters<
  typeof runPhase10ChainHistoryReadonlyValidate
>[0];
import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';
import { hashOpaqueReference } from './user-reference.js';

/** Production invocation MUST keep both execution modes disabled. */
export const RESTORE_DRILL_READONLY_VALIDATE_FLAGS = {
  realChainEnabled: false,
  fakeChainEnabled: false,
} as const;

export interface ChainScopeCounts {
  readonly withdrawals: number;
  readonly withdrawalAttempts: number;
  readonly blockchainTransactions: number;
  readonly chainObservations: number;
  readonly withdrawalPayoutReconciliations: number;
  readonly chainRelevantAttempts: number;
  readonly chainSensitiveWithdrawals: number;
}

export interface ChainReconciliationResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly liveProviderQueryPerformed: boolean;
  readonly chainScopeEmpty: boolean;
  readonly liveChainReconciliation: 'OBSERVED' | 'NOT_REQUIRED_EMPTY_SCOPE' | 'NOT_OBSERVED';
  readonly withdrawalsRequiringLiveChainCount: number;
  readonly providerQueryPerformed: boolean;
  readonly primaryHealthy: boolean | null;
  readonly secondaryHealthy: boolean | null;
  readonly providerAgreement: boolean | null;
  readonly windowFullyCovered: boolean | null;
  readonly agreedTransferCount: number | null;
  readonly knownExpectedTransferCount: number | null;
  readonly confirmedMatchedCount: number | null;
  readonly unexpectedOutgoingCount: number | null;
  readonly ambiguousAttemptCount: number | null;
  readonly providerReportDigest: string | null;
  readonly payoutInvariantFailCount: number | null;
  readonly payoutInvariantFindingCodes: readonly string[];
  readonly mismatchReferences: readonly string[];
  readonly observationWindowStart: string | null;
  readonly observationWindowEnd: string | null;
  readonly restoreTargetAt: string | null;
}

export interface ChainProviderEnv {
  readonly primaryKind: string;
  readonly primaryUrl: string;
  readonly primaryApiKey: string | null;
  readonly secondaryKind: string;
  readonly secondaryUrl: string;
  readonly secondaryApiKey: string | null;
  readonly jettonMaster: string;
}

/** Internal only — never serialized into reports. */
export interface ExpectedConfirmedPayout {
  readonly withdrawalId: string;
  readonly attemptId: string;
  readonly queryId: string;
  readonly recipient: string;
  readonly amountAtomic: string;
  readonly jettonMaster: string;
  readonly hotWallet: string;
  readonly senderJettonWallet: string;
}

const CHAIN_SENSITIVE_STATES = [
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMING',
  'CONFIRMED',
  'RECONCILE_REQUIRED',
] as const;

const CHAIN_RELEVANT_BROADCAST_STATES = ['BROADCASTED', 'UNKNOWN', 'RECONCILE_REQUIRED'] as const;

const AMBIGUOUS_WITHDRAWAL_STATES = [
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMING',
  'UNKNOWN',
  'RECONCILE_REQUIRED',
] as const;

async function countOrFail(pool: Pool, sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query<{ count: string }>(sql, params);
  return Number(result.rows[0]?.count ?? 0);
}

export async function captureChainScope(pool: Pool): Promise<ChainScopeCounts> {
  const withdrawals = await countOrFail(pool, `SELECT COUNT(*)::text AS count FROM withdrawals`);
  const withdrawalAttempts = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count FROM withdrawal_attempts`,
  );
  const blockchainTransactions = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count FROM blockchain_transactions`,
  );
  const chainObservations = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count FROM chain_observations`,
  );
  const withdrawalPayoutReconciliations = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count FROM withdrawal_payout_reconciliations`,
  );
  const chainRelevantAttempts = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count
       FROM withdrawal_attempts
      WHERE broadcast_submitted_at IS NOT NULL
         OR broadcast_result_state::text = ANY($1::text[])`,
    [CHAIN_RELEVANT_BROADCAST_STATES],
  );
  const chainSensitiveWithdrawals = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count
       FROM withdrawals
      WHERE state::text = ANY($1::text[])`,
    [CHAIN_SENSITIVE_STATES],
  );
  return {
    withdrawals,
    withdrawalAttempts,
    blockchainTransactions,
    chainObservations,
    withdrawalPayoutReconciliations,
    chainRelevantAttempts,
    chainSensitiveWithdrawals,
  };
}

export function isChainScopeEmpty(scope: ChainScopeCounts): boolean {
  return (
    scope.withdrawals === 0 &&
    scope.withdrawalAttempts === 0 &&
    scope.blockchainTransactions === 0 &&
    scope.chainObservations === 0 &&
    scope.withdrawalPayoutReconciliations === 0 &&
    scope.chainRelevantAttempts === 0 &&
    scope.chainSensitiveWithdrawals === 0
  );
}

function parseProviderEnv(env: NodeJS.ProcessEnv): ChainProviderEnv | { error: string } {
  const primaryKind = (env.TON_PRIMARY_PROVIDER_KIND ?? '').trim();
  const primaryUrl = (env.TON_PRIMARY_PROVIDER_URL ?? '').trim();
  const secondaryKind = (env.TON_SECONDARY_PROVIDER_KIND ?? '').trim();
  const secondaryUrl = (env.TON_SECONDARY_PROVIDER_URL ?? '').trim();
  const jettonMaster = (env.TON_TESTNET_JETTON_MASTER ?? '').trim();
  if (!primaryKind || !primaryUrl || !secondaryKind || !secondaryUrl || !jettonMaster) {
    return { error: 'CHAIN_PROVIDER_ENV_INCOMPLETE' };
  }
  if (/mainnet/i.test(primaryKind) || /mainnet/i.test(secondaryKind)) {
    return { error: 'MAINNET_OR_NON_TESTNET_REFUSED' };
  }
  if (primaryKind.toLowerCase() === 'fake' || secondaryKind.toLowerCase() === 'fake') {
    return { error: 'FAKE_PROVIDER_REFUSED' };
  }
  const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  if (norm(primaryUrl) === norm(secondaryUrl) && primaryKind === secondaryKind) {
    return { error: 'PROVIDER_ROLES_NOT_DISTINCT' };
  }
  return {
    primaryKind,
    primaryUrl,
    primaryApiKey: nonempty(env.TON_PRIMARY_PROVIDER_API_KEY),
    secondaryKind,
    secondaryUrl,
    secondaryApiKey: nonempty(env.TON_SECONDARY_PROVIDER_API_KEY),
    jettonMaster,
  };
}

/** Require exact Testnet markers — anything else fails closed. */
export function assertStrictTestnetNetworkEnv(
  env: NodeJS.ProcessEnv,
): { readonly ok: true } | { readonly ok: false; readonly reasonCode: string } {
  const networkCode = (env.PHASE18_CHAIN_NETWORK_CODE ?? 'TON_TESTNET').trim();
  if (networkCode !== 'TON_TESTNET') {
    return { ok: false, reasonCode: 'MAINNET_OR_NON_TESTNET_REFUSED' };
  }
  const rawGlobal = (env.PHASE18_CHAIN_NETWORK_GLOBAL_ID ?? '-3').trim();
  if (!/^-?\d+$/.test(rawGlobal)) {
    return { ok: false, reasonCode: 'MAINNET_OR_NON_TESTNET_REFUSED' };
  }
  if (rawGlobal !== '-3') {
    return { ok: false, reasonCode: 'MAINNET_OR_NON_TESTNET_REFUSED' };
  }
  return { ok: true };
}

function nonempty(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

function emptyObservedResult(
  overrides: Partial<ChainReconciliationResult> &
    Pick<ChainReconciliationResult, 'status' | 'reasonCode'>,
): ChainReconciliationResult {
  return {
    liveProviderQueryPerformed: false,
    chainScopeEmpty: false,
    liveChainReconciliation: 'NOT_OBSERVED',
    withdrawalsRequiringLiveChainCount: 0,
    providerQueryPerformed: false,
    primaryHealthy: null,
    secondaryHealthy: null,
    providerAgreement: null,
    windowFullyCovered: null,
    agreedTransferCount: null,
    knownExpectedTransferCount: null,
    confirmedMatchedCount: null,
    unexpectedOutgoingCount: null,
    ambiguousAttemptCount: null,
    providerReportDigest: null,
    payoutInvariantFailCount: null,
    payoutInvariantFindingCodes: [],
    mismatchReferences: [],
    observationWindowStart: null,
    observationWindowEnd: null,
    restoreTargetAt: null,
    ...overrides,
  };
}

/**
 * Unresolved possibly-broadcast attempts only.
 * Settled/confirmed historical attempts are NOT ambiguous merely because
 * broadcast_submitted_at IS NOT NULL.
 */
export async function captureUnresolvedAmbiguityCounts(pool: Pool): Promise<{
  readonly ambiguousAttemptCount: number;
  readonly ambiguousWithdrawalCount: number;
}> {
  const ambiguousAttemptCount = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count
       FROM withdrawal_attempts
      WHERE broadcast_result_state::text IN ('UNKNOWN', 'RECONCILE_REQUIRED')
         OR (
              broadcast_submitted_at IS NOT NULL
          AND broadcast_result_state::text IN ('PENDING', 'BROADCASTED', 'UNKNOWN', 'RECONCILE_REQUIRED')
          AND settled_at IS NULL
         )`,
  );
  const ambiguousWithdrawalCount = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count
       FROM withdrawals
      WHERE state::text = ANY($1::text[])`,
    [AMBIGUOUS_WITHDRAWAL_STATES],
  );
  return { ambiguousAttemptCount, ambiguousWithdrawalCount };
}

/**
 * Capture authoritative expected transfer identity for each CONFIRMED withdrawal.
 * Requires exactly one settled attempt; never guesses.
 */
export async function captureExpectedConfirmedPayouts(pool: Pool): Promise<
  | { readonly ok: true; readonly expected: readonly ExpectedConfirmedPayout[] }
  | {
      readonly ok: false;
      readonly reasonCode: string;
      readonly mismatchReferences: readonly string[];
    }
> {
  let confirmedIds: string[];
  try {
    const rows = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM withdrawals WHERE state::text = 'CONFIRMED' ORDER BY id`,
    );
    confirmedIds = rows.rows.map((r) => r.id);
  } catch {
    return { ok: false, reasonCode: 'CONFIRMED_WITHDRAWAL_QUERY_FAILED', mismatchReferences: [] };
  }

  const expected: ExpectedConfirmedPayout[] = [];
  const mismatchReferences: string[] = [];

  for (const withdrawalId of confirmedIds) {
    let settled;
    try {
      settled = await pool.query<{
        attempt_id: string;
        query_id: string;
        recipient: string;
        amount_atomic: string;
        jetton_master: string;
        hot_wallet: string;
        sender_jetton_wallet: string | null;
      }>(
        `SELECT a.id::text AS attempt_id,
                a.query_id::text AS query_id,
                COALESCE(uw.raw_address, uw.friendly_address) AS recipient,
                w.net_amount_atomic::text AS amount_atomic,
                ast.contract_identity AS jetton_master,
                hw.address AS hot_wallet,
                hw.payout_jetton_wallet_address AS sender_jetton_wallet
           FROM withdrawals w
           INNER JOIN withdrawal_attempts a ON a.withdrawal_id = w.id
           INNER JOIN user_wallets uw ON uw.id = w.wallet_id
           INNER JOIN hot_wallets hw ON hw.id = w.hot_wallet_id
           INNER JOIN assets ast ON ast.id = w.asset_id
          WHERE w.id = $1::uuid
            AND a.settled_at IS NOT NULL
          ORDER BY a.attempt_number ASC`,
        [withdrawalId],
      );
    } catch {
      return {
        ok: false,
        reasonCode: 'EXPECTED_PAYOUT_QUERY_FAILED',
        mismatchReferences: [hashOpaqueReference('expected-payout-query', withdrawalId)],
      };
    }

    if (settled.rows.length === 0) {
      mismatchReferences.push(hashOpaqueReference('confirmed-missing-settled-attempt', withdrawalId));
      continue;
    }
    if (settled.rows.length > 1) {
      mismatchReferences.push(
        hashOpaqueReference('confirmed-multiple-settled-attempts', withdrawalId),
      );
      continue;
    }
    const row = settled.rows[0]!;
    if (
      !row.query_id?.trim() ||
      !row.recipient?.trim() ||
      !row.amount_atomic?.trim() ||
      !row.jetton_master?.trim() ||
      !row.hot_wallet?.trim() ||
      !row.sender_jetton_wallet?.trim()
    ) {
      mismatchReferences.push(hashOpaqueReference('confirmed-binding-incomplete', withdrawalId));
      continue;
    }
    expected.push({
      withdrawalId,
      attemptId: row.attempt_id,
      queryId: row.query_id,
      recipient: row.recipient,
      amountAtomic: row.amount_atomic,
      jettonMaster: row.jetton_master,
      hotWallet: row.hot_wallet,
      senderJettonWallet: row.sender_jetton_wallet,
    });
  }

  if (mismatchReferences.length > 0) {
    return {
      ok: false,
      reasonCode: 'EXPECTED_PAYOUT_BINDING_INVALID',
      mismatchReferences,
    };
  }
  return { ok: true, expected };
}


export interface ChainObservationBounds {
  readonly earliestRelevantAt: string;
  readonly latestRelevantAt: string;
}

/**
 * Derive earliest/latest authoritative restored financial/chain timestamps.
 * Does not use updated_at. Fail-closed when nonempty scope has no valid timestamps.
 */
export async function deriveChainObservationBounds(pool: Pool): Promise<
  | { readonly ok: true; readonly bounds: ChainObservationBounds }
  | { readonly ok: false; readonly reasonCode: string }
> {
  try {
    const result = await pool.query<{ earliest: string | null; latest: string | null }>(
      `SELECT MIN(ts)::text AS earliest, MAX(ts)::text AS latest
         FROM (
           SELECT requested_at AS ts FROM withdrawals
           UNION ALL
           SELECT created_at AS ts FROM withdrawal_attempts
           UNION ALL
           SELECT signing_started_at AS ts FROM withdrawal_attempts
           UNION ALL
           SELECT broadcast_started_at AS ts FROM withdrawal_attempts
            WHERE broadcast_started_at IS NOT NULL
           UNION ALL
           SELECT broadcast_submitted_at AS ts FROM withdrawal_attempts
            WHERE broadcast_submitted_at IS NOT NULL
           UNION ALL
           SELECT first_seen_at AS ts FROM blockchain_transactions
           UNION ALL
           SELECT confirmed_at AS ts FROM blockchain_transactions
            WHERE confirmed_at IS NOT NULL
           UNION ALL
           SELECT observed_at AS ts FROM chain_observations
           UNION ALL
           SELECT created_at AS ts FROM withdrawal_payout_reconciliations
           UNION ALL
           SELECT resolved_at AS ts FROM withdrawal_payout_reconciliations
            WHERE resolved_at IS NOT NULL
         ) relevant
        WHERE ts IS NOT NULL`,
    );
    const earliestRaw = result.rows[0]?.earliest ?? null;
    const latestRaw = result.rows[0]?.latest ?? null;
    if (earliestRaw === null || latestRaw === null) {
      return { ok: false, reasonCode: 'CHAIN_WINDOW_DERIVATION_FAILED' };
    }
    const earliestMs = Date.parse(earliestRaw);
    const latestMs = Date.parse(latestRaw);
    if (!Number.isFinite(earliestMs) || !Number.isFinite(latestMs)) {
      return { ok: false, reasonCode: 'CHAIN_WINDOW_DERIVATION_FAILED' };
    }
    return {
      ok: true,
      bounds: {
        earliestRelevantAt: new Date(earliestMs).toISOString(),
        latestRelevantAt: new Date(latestMs).toISOString(),
      },
    };
  } catch {
    return { ok: false, reasonCode: 'CHAIN_WINDOW_DERIVATION_FAILED' };
  }
}

export function matchConfirmedPayoutsToAgreedTransfers(input: {
  readonly expected: readonly ExpectedConfirmedPayout[];
  readonly report: Pick<
    Phase10ReadonlyValidationReport,
    | 'hotWalletAddress'
    | 'hotWalletJettonWallet'
    | 'jettonMaster'
    | 'agreedTransfers'
  >;
}): {
  readonly confirmedMatchedCount: number;
  readonly unexpectedOutgoingCount: number;
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly mismatchReferences: readonly string[];
} {
  const used = new Set<number>();
  const mismatchReferences: string[] = [];
  let confirmedMatchedCount = 0;

  for (const payout of input.expected) {
    const hotWalletBindKey = buildPhase10EconomicKey({
      queryId: 'restore-drill-hw-bind',
      amountAtomic: '0',
      recipient: input.report.hotWalletAddress,
      jettonMaster: input.report.hotWalletJettonWallet,
    });
    const expectedHotWalletBindKey = buildPhase10EconomicKey({
      queryId: 'restore-drill-hw-bind',
      amountAtomic: '0',
      recipient: payout.hotWallet,
      jettonMaster: payout.senderJettonWallet,
    });
    if (hotWalletBindKey !== expectedHotWalletBindKey) {
      mismatchReferences.push(
        hashOpaqueReference('report-identity-mismatch', payout.withdrawalId),
      );
      continue;
    }

    const expectedKey = buildPhase10EconomicKey({
      queryId: payout.queryId,
      amountAtomic: payout.amountAtomic,
      recipient: payout.recipient,
      jettonMaster: payout.jettonMaster,
    });

    const matches: number[] = [];
    for (let i = 0; i < input.report.agreedTransfers.length; i += 1) {
      if (used.has(i)) continue;
      const transfer = input.report.agreedTransfers[i]!;
      const transferKey = buildPhase10EconomicKey({
        queryId: transfer.queryId,
        amountAtomic: transfer.amountAtomic,
        recipient: transfer.recipient,
        jettonMaster: input.report.jettonMaster,
      });
      if (transferKey === expectedKey) matches.push(i);
    }

    if (matches.length === 0) {
      mismatchReferences.push(hashOpaqueReference('confirmed-unmatched', payout.withdrawalId));
      continue;
    }
    if (matches.length > 1) {
      mismatchReferences.push(
        hashOpaqueReference('confirmed-duplicate-live-matches', payout.withdrawalId),
      );
      continue;
    }
    used.add(matches[0]!);
    confirmedMatchedCount += 1;
  }

  const unexpectedOutgoingCount = input.report.agreedTransfers.length - used.size;
  const knownExpected = input.expected.length;

  if (mismatchReferences.length > 0) {
    return {
      confirmedMatchedCount,
      unexpectedOutgoingCount,
      status: 'FAIL',
      reasonCode: 'CONFIRMED_WITHOUT_TEP74_PROOF',
      mismatchReferences,
    };
  }
  if (confirmedMatchedCount !== knownExpected) {
    return {
      confirmedMatchedCount,
      unexpectedOutgoingCount,
      status: 'FAIL',
      reasonCode: 'CONFIRMED_WITHOUT_TEP74_PROOF',
      mismatchReferences: [
        hashOpaqueReference(
          'confirmed-match-count',
          `${confirmedMatchedCount}/${knownExpected}`,
        ),
      ],
    };
  }
  if (unexpectedOutgoingCount > 0) {
    return {
      confirmedMatchedCount,
      unexpectedOutgoingCount,
      status: 'FAIL',
      reasonCode: 'UNEXPECTED_OUTGOING_TRANSFER',
      mismatchReferences: [
        hashOpaqueReference('unexpected-outgoing', String(unexpectedOutgoingCount)),
      ],
    };
  }
  return {
    confirmedMatchedCount,
    unexpectedOutgoingCount: 0,
    status: 'PASS',
    reasonCode: 'CONFIRMED_TRANSFERS_INDIVIDUALLY_MATCHED',
    mismatchReferences: [],
  };
}

function assertReadonlyReportIntegrity(report: Phase10ReadonlyValidationReport): string | null {
  if (report.validationOnly !== true) return 'READONLY_REPORT_NOT_VALIDATION_ONLY';
  if (report.acceptanceEnabled !== false) return 'READONLY_REPORT_ACCEPTANCE_ENABLED';
  if (report.networkCode !== 'TON_TESTNET') return 'READONLY_REPORT_NON_TESTNET';
  if (report.networkGlobalId !== -3) return 'READONLY_REPORT_NON_TESTNET';
  try {
    assertPhase10ReadonlyValidationReportIntegrity(report);
  } catch {
    return 'READONLY_REPORT_DIGEST_INVALID';
  }
  return null;
}

export async function reconcileChainReadOnly(input: {
  readonly pool: Pool;
  readonly env?: NodeJS.ProcessEnv;
  /** Exact restore cutoff (RFC3339 ISO) — required for nonzero chain scope. */
  readonly restoreTargetAt: string;
  readonly now?: Date;
  /** Test injection — when set, skips real provider call. */
  readonly validateOverride?: (
    input: RunPhase10ChainHistoryReadonlyValidateInput,
  ) => Promise<Phase10ReadonlyValidationReport>;
  /** Test injection — payout invariant checker. */
  readonly checkPayoutInvariants?: typeof checkPhase10PayoutInvariants;
  /** Test injection — observation bounds override. */
  readonly observationBoundsOverride?: ChainObservationBounds;
}): Promise<ChainReconciliationResult> {
  let scope: ChainScopeCounts;
  try {
    scope = await captureChainScope(input.pool);
  } catch {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'CHAIN_SCOPE_QUERY_FAILED',
    });
  }

  const requiring = scope.chainSensitiveWithdrawals + scope.chainRelevantAttempts;

  const restoreTargetMs = Date.parse(input.restoreTargetAt);
  if (!Number.isFinite(restoreTargetMs)) {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'RESTORE_TARGET_AT_INVALID',
      restoreTargetAt: input.restoreTargetAt,
    });
  }
  const restoreTargetAt = new Date(restoreTargetMs).toISOString();

  if (isChainScopeEmpty(scope)) {
    return {
      status: 'PASS',
      reasonCode: 'NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE',
      liveProviderQueryPerformed: false,
      chainScopeEmpty: true,
      liveChainReconciliation: 'NOT_REQUIRED_EMPTY_SCOPE',
      withdrawalsRequiringLiveChainCount: 0,
      providerQueryPerformed: false,
      primaryHealthy: null,
      secondaryHealthy: null,
      providerAgreement: null,
      windowFullyCovered: null,
      agreedTransferCount: null,
      knownExpectedTransferCount: null,
      confirmedMatchedCount: null,
      unexpectedOutgoingCount: null,
      ambiguousAttemptCount: null,
      providerReportDigest: null,
      payoutInvariantFailCount: null,
      payoutInvariantFindingCodes: [],
      mismatchReferences: [],
      observationWindowStart: null,
      observationWindowEnd: restoreTargetAt,
      restoreTargetAt,
    };
  }

  const env = input.env ?? process.env;
  const providers = parseProviderEnv(env);
  if ('error' in providers) {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: providers.error,
      withdrawalsRequiringLiveChainCount: requiring,
      chainScopeEmpty: false,
    });
  }

  const network = assertStrictTestnetNetworkEnv(env);
  if (!network.ok) {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: network.reasonCode,
      withdrawalsRequiringLiveChainCount: requiring,
    });
  }

  // Authoritative payout invariants for every chain-sensitive withdrawal.
  let sensitiveIds: string[] = [];
  try {
    const rows = await input.pool.query<{ id: string }>(
      `SELECT id::text AS id
         FROM withdrawals
        WHERE state::text = ANY($1::text[])
        ORDER BY id`,
      [CHAIN_SENSITIVE_STATES],
    );
    sensitiveIds = rows.rows.map((r) => r.id);
  } catch {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'CHAIN_SENSITIVE_QUERY_FAILED',
      withdrawalsRequiringLiveChainCount: requiring,
    });
  }

  const checkInvariants = input.checkPayoutInvariants ?? checkPhase10PayoutInvariants;
  const findingCodes: string[] = [];
  const invariantMismatchRefs: string[] = [];
  let invariantFailCount = 0;
  for (const withdrawalId of sensitiveIds) {
    try {
      const report = await checkInvariants(input.pool, withdrawalId, {
        requireLiveAcceptanceProof: true,
      });
      if (!report.ok) {
        invariantFailCount += 1;
        for (const f of report.findings) {
          if (f.severity === 'FAIL') findingCodes.push(f.code);
        }
        invariantMismatchRefs.push(hashOpaqueReference('payout-invariant-fail', withdrawalId));
      }
    } catch {
      invariantFailCount += 1;
      findingCodes.push('PAYOUT_INVARIANT_CHECK_FAILED');
      invariantMismatchRefs.push(hashOpaqueReference('payout-invariant-error', withdrawalId));
    }
  }
  if (invariantFailCount > 0) {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'PAYOUT_INVARIANT_FAILED',
      withdrawalsRequiringLiveChainCount: requiring,
      payoutInvariantFailCount: invariantFailCount,
      payoutInvariantFindingCodes: [...new Set(findingCodes)],
      mismatchReferences: invariantMismatchRefs,
    });
  }

  const expectedCapture = await captureExpectedConfirmedPayouts(input.pool);
  if (!expectedCapture.ok) {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: expectedCapture.reasonCode,
      withdrawalsRequiringLiveChainCount: requiring,
      payoutInvariantFailCount: 0,
      payoutInvariantFindingCodes: [],
      mismatchReferences: expectedCapture.mismatchReferences,
    });
  }

  const ambiguity = await captureUnresolvedAmbiguityCounts(input.pool);
  const ambiguousAttemptCount =
    ambiguity.ambiguousAttemptCount + ambiguity.ambiguousWithdrawalCount;

  let bounds: ChainObservationBounds;
  if (input.observationBoundsOverride !== undefined) {
    bounds = input.observationBoundsOverride;
  } else {
    const derived = await deriveChainObservationBounds(input.pool);
    if (!derived.ok) {
      return emptyObservedResult({
        status: 'FAIL',
        reasonCode: derived.reasonCode,
        withdrawalsRequiringLiveChainCount: requiring,
        restoreTargetAt,
        observationWindowEnd: restoreTargetAt,
      });
    }
    bounds = derived.bounds;
  }

  if (Date.parse(bounds.latestRelevantAt) > Date.parse(restoreTargetAt)) {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'RESTORED_CHAIN_TIMESTAMP_AFTER_TARGET',
      withdrawalsRequiringLiveChainCount: requiring,
      restoreTargetAt,
      observationWindowStart: bounds.earliestRelevantAt,
      observationWindowEnd: restoreTargetAt,
    });
  }
  if (Date.parse(bounds.earliestRelevantAt) > Date.parse(restoreTargetAt)) {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'RESTORED_CHAIN_TIMESTAMP_AFTER_TARGET',
      withdrawalsRequiringLiveChainCount: requiring,
      restoreTargetAt,
      observationWindowStart: bounds.earliestRelevantAt,
      observationWindowEnd: restoreTargetAt,
    });
  }

  const windowStart = bounds.earliestRelevantAt;
  const windowEnd = restoreTargetAt;
  const generatedAt = (input.now ?? new Date()).toISOString();

  const validate = input.validateOverride ?? runPhase10ChainHistoryReadonlyValidate;
  const validateInput: RunPhase10ChainHistoryReadonlyValidateInput = {
    db: input.pool,
    windowStart,
    windowEnd,
    primary: {
      kind: providers.primaryKind,
      baseUrl: providers.primaryUrl,
      ...(providers.primaryApiKey !== null ? { apiKey: providers.primaryApiKey } : {}),
    },
    secondary: {
      kind: providers.secondaryKind,
      baseUrl: providers.secondaryUrl,
      ...(providers.secondaryApiKey !== null ? { apiKey: providers.secondaryApiKey } : {}),
    },
    jettonMaster: providers.jettonMaster,
    networkCode: 'TON_TESTNET',
    realChainEnabled: RESTORE_DRILL_READONLY_VALIDATE_FLAGS.realChainEnabled,
    fakeChainEnabled: RESTORE_DRILL_READONLY_VALIDATE_FLAGS.fakeChainEnabled,
    generatedAt,
  };

  try {
    const report = await validate(validateInput);

    const integrityError = assertReadonlyReportIntegrity(report);
    if (integrityError !== null) {
      return emptyObservedResult({
        status: 'FAIL',
        reasonCode: integrityError,
        withdrawalsRequiringLiveChainCount: requiring,
        payoutInvariantFailCount: 0,
        payoutInvariantFindingCodes: [],
      });
    }

    const primaryHealthy = report.primaryHealth.ok === true;
    const secondaryHealthy = report.secondaryHealth.ok === true;
    const windowFullyCovered =
      report.primaryCoverage.windowFullyCovered === true &&
      report.secondaryCoverage.windowFullyCovered === true;
    const providerAgreement = report.providerAgreement === true;
    const knownExpectedTransferCount = expectedCapture.expected.length;

    let status: DrillSectionStatus = 'PASS';
    let reasonCode = 'CHAIN_READONLY_VALIDATION_PASS';
    let confirmedMatchedCount: number | null = null;
    let unexpectedOutgoingCount: number | null = null;
    let mismatchReferences: readonly string[] = [];

    if (!primaryHealthy || !secondaryHealthy) {
      status = 'FAIL';
      reasonCode = 'CHAIN_PROVIDER_UNHEALTHY';
    } else if (
      !providerAgreement ||
      report.verdict === 'FAIL_PROVIDER_DISAGREEMENT' ||
      report.onlyPrimaryCount > 0 ||
      report.onlySecondaryCount > 0
    ) {
      // Provider-only differences are disagreement evidence — separate from unexpected agreed outgoing.
      status = 'OWNER_REVIEW_REQUIRED';
      reasonCode = 'CHAIN_PROVIDER_DISAGREEMENT';
    } else if (!windowFullyCovered || report.verdict === 'FAIL_INCOMPLETE_HISTORY') {
      status = 'OWNER_REVIEW_REQUIRED';
      reasonCode = 'CHAIN_WINDOW_INCOMPLETE';
    } else if (report.verdict === 'FAIL_PROVIDER_HEALTH' || report.verdict === 'FAIL_BINDING') {
      status = 'FAIL';
      reasonCode = report.verdict;
    } else if (ambiguousAttemptCount > 0) {
      status = 'OWNER_REVIEW_REQUIRED';
      reasonCode = 'AMBIGUOUS_CHAIN_ATTEMPT_STATE';
    } else {
      const matched = matchConfirmedPayoutsToAgreedTransfers({
        expected: expectedCapture.expected,
        report,
      });
      confirmedMatchedCount = matched.confirmedMatchedCount;
      unexpectedOutgoingCount = matched.unexpectedOutgoingCount;
      mismatchReferences = matched.mismatchReferences;
      if (matched.status !== 'PASS') {
        status = matched.status;
        reasonCode = matched.reasonCode;
      } else if (
        report.verdict === 'PASS_WITH_OBSERVED_TRANSFERS' ||
        report.verdict === 'PASS_ZERO_OUTGOING'
      ) {
        status = 'PASS';
        reasonCode =
          knownExpectedTransferCount === 0
            ? report.verdict
            : 'CONFIRMED_TRANSFERS_INDIVIDUALLY_MATCHED';
      } else {
        status = 'OWNER_REVIEW_REQUIRED';
        reasonCode = 'CHAIN_VERDICT_UNKNOWN';
      }
    }

    return {
      status,
      reasonCode,
      liveProviderQueryPerformed: true,
      chainScopeEmpty: false,
      liveChainReconciliation: 'OBSERVED',
      withdrawalsRequiringLiveChainCount: requiring,
      providerQueryPerformed: true,
      primaryHealthy,
      secondaryHealthy,
      providerAgreement,
      windowFullyCovered,
      agreedTransferCount: report.agreedTransferCount,
      knownExpectedTransferCount,
      confirmedMatchedCount,
      unexpectedOutgoingCount,
      ambiguousAttemptCount,
      providerReportDigest: report.reportDigest,
      payoutInvariantFailCount: 0,
      payoutInvariantFindingCodes: [],
      mismatchReferences,
      observationWindowStart: windowStart,
      observationWindowEnd: windowEnd,
      restoreTargetAt,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const redacted = message.replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[REDACTED]');
    void redacted;
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'CHAIN_READONLY_VALIDATE_FAILED',
      withdrawalsRequiringLiveChainCount: requiring,
      chainScopeEmpty: false,
      payoutInvariantFailCount: 0,
      payoutInvariantFindingCodes: [],
    });
  }
}