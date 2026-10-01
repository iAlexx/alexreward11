/**
 * Read-only chain reconciliation for FULL_STEP2B.
 * Zero-scope path: empty restored chain state => PASS without provider calls.
 * Nonzero path: observation-only runPhase10ChainHistoryReadonlyValidate.
 */
import { createHash } from 'node:crypto';

import { runPhase10ChainHistoryReadonlyValidate } from '@alex-rewards/withdrawals';
import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';

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

const CHAIN_SENSITIVE_STATES = [
  'BROADCASTING',
  'BROADCASTED',
  'CONFIRMING',
  'CONFIRMED',
  'RECONCILE_REQUIRED',
] as const;

const CHAIN_RELEVANT_BROADCAST_STATES = ['BROADCASTED', 'UNKNOWN', 'RECONCILE_REQUIRED'] as const;

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
    return { error: 'MAINNET_REFUSED' };
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
    ...overrides,
  };
}


async function capturePayoutAmbiguityCounts(pool: Pool): Promise<{
  readonly confirmedCount: number;
  readonly ambiguousAttemptCount: number;
  readonly ambiguousWithdrawalCount: number;
}> {
  const confirmedCount = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count FROM withdrawals WHERE state::text = 'CONFIRMED'`,
  );
  const ambiguousWithdrawalCount = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count
       FROM withdrawals
      WHERE state::text = ANY($1::text[])`,
    [['BROADCASTING', 'BROADCASTED', 'CONFIRMING', 'UNKNOWN', 'RECONCILE_REQUIRED']],
  );
  const ambiguousAttemptCount = await countOrFail(
    pool,
    `SELECT COUNT(*)::text AS count
       FROM withdrawal_attempts
      WHERE broadcast_submitted_at IS NOT NULL
         OR broadcast_result_state::text = ANY($1::text[])`,
    [['BROADCASTED', 'UNKNOWN', 'RECONCILE_REQUIRED']],
  );
  return { confirmedCount, ambiguousAttemptCount, ambiguousWithdrawalCount };
}
export async function reconcileChainReadOnly(input: {
  readonly pool: Pool;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: Date;
  /** Test injection — when set, skips real provider call. */
  readonly validateOverride?: typeof runPhase10ChainHistoryReadonlyValidate;
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

  // Refuse Mainnet network codes / global ids via env markers
  const networkCode = (env.PHASE18_CHAIN_NETWORK_CODE ?? 'TON_TESTNET').trim();
  if (networkCode !== 'TON_TESTNET') {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'MAINNET_REFUSED',
      withdrawalsRequiringLiveChainCount: requiring,
    });
  }
  const networkGlobalId = (env.PHASE18_CHAIN_NETWORK_GLOBAL_ID ?? '-3').trim();
  if (networkGlobalId === '-239') {
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'MAINNET_REFUSED',
      withdrawalsRequiringLiveChainCount: requiring,
    });
  }

  const now = input.now ?? new Date();
  const windowEnd = now.toISOString();
  // Cover a wide restored history window (observation-only).
  const windowStart = new Date(now.getTime() - 365 * 24 * 3600 * 1000).toISOString();

  const validate = input.validateOverride ?? runPhase10ChainHistoryReadonlyValidate;
  try {
    const report = await validate({
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
      realChainEnabled: true,
      fakeChainEnabled: false,
      generatedAt: windowEnd,
    });

    // Never serialize addresses / transfer payloads — digest only.
    const digest =
      report.reportDigest ??
      createHash('sha256').update(JSON.stringify({ verdict: report.verdict })).digest('hex');

    const primaryHealthy = report.primaryHealth.ok === true;
    const secondaryHealthy = report.secondaryHealth.ok === true;
    const windowFullyCovered =
      report.primaryCoverage.windowFullyCovered === true &&
      report.secondaryCoverage.windowFullyCovered === true;
    const providerAgreement = report.providerAgreement === true;

    const ambiguity = await capturePayoutAmbiguityCounts(input.pool);
    const unexpectedOutgoingCount = report.onlyPrimaryCount + report.onlySecondaryCount;
    const knownExpectedTransferCount = ambiguity.confirmedCount;
    const ambiguousAttemptCount =
      ambiguity.ambiguousAttemptCount + ambiguity.ambiguousWithdrawalCount;

    let status: DrillSectionStatus = 'PASS';
    let reasonCode = 'CHAIN_READONLY_VALIDATION_PASS';
    let confirmedMatchedCount: number | null = null;

    if (!primaryHealthy || !secondaryHealthy) {
      status = 'FAIL';
      reasonCode = 'CHAIN_PROVIDER_UNHEALTHY';
    } else if (!providerAgreement || report.verdict === 'FAIL_PROVIDER_DISAGREEMENT') {
      status = 'OWNER_REVIEW_REQUIRED';
      reasonCode = 'CHAIN_PROVIDER_DISAGREEMENT';
    } else if (!windowFullyCovered || report.verdict === 'FAIL_INCOMPLETE_HISTORY') {
      status = 'OWNER_REVIEW_REQUIRED';
      reasonCode = 'CHAIN_WINDOW_INCOMPLETE';
    } else if (report.verdict === 'FAIL_PROVIDER_HEALTH' || report.verdict === 'FAIL_BINDING') {
      status = 'FAIL';
      reasonCode = report.verdict;
    } else if (unexpectedOutgoingCount > 0) {
      status = 'FAIL';
      reasonCode = 'UNEXPECTED_OUTGOING_TRANSFER';
    } else if (ambiguousAttemptCount > 0) {
      status = 'OWNER_REVIEW_REQUIRED';
      reasonCode = 'AMBIGUOUS_CHAIN_ATTEMPT_STATE';
    } else if (
      knownExpectedTransferCount > 0 &&
      report.verdict === 'PASS_ZERO_OUTGOING'
    ) {
      status = 'FAIL';
      reasonCode = 'CONFIRMED_WITHOUT_TEP74_PROOF';
      confirmedMatchedCount = 0;
    } else if (
      knownExpectedTransferCount > 0 &&
      report.agreedTransferCount < knownExpectedTransferCount
    ) {
      status = 'FAIL';
      reasonCode = 'CONFIRMED_WITHOUT_TEP74_PROOF';
      confirmedMatchedCount = report.agreedTransferCount;
    } else if (
      report.verdict === 'PASS_WITH_OBSERVED_TRANSFERS' ||
      report.verdict === 'PASS_ZERO_OUTGOING'
    ) {
      status = 'PASS';
      reasonCode = report.verdict;
      confirmedMatchedCount =
        knownExpectedTransferCount > 0 ? knownExpectedTransferCount : report.agreedTransferCount;
    } else {
      status = 'OWNER_REVIEW_REQUIRED';
      reasonCode = 'CHAIN_VERDICT_UNKNOWN';
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
      providerReportDigest: digest,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Never echo API keys if present in message
    const redacted = message.replace(/api[_-]?key[=:]\s*\S+/gi, 'api_key=[REDACTED]');
    void redacted;
    return emptyObservedResult({
      status: 'FAIL',
      reasonCode: 'CHAIN_READONLY_VALIDATE_FAILED',
      withdrawalsRequiringLiveChainCount: requiring,
      chainScopeEmpty: false,
    });
  }
}