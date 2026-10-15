/**
 * Phase 21 Generation-4 Owner-authorized recovery — PLAN (read-only).
 *
 * Proves WD-000001 is safe for a fresh Gen-4 one-shot permit after:
 *   - Gen-1 CONSUMED → attempt #1 FAILED_PRE_BROADCAST (no evidence),
 *   - Gen-2 CONSUMED → attempt #2 FAILED_PRE_BROADCAST (no evidence), and
 *   - Gen-3 CONSUMED → attempt #3 FAILED_PRE_BROADCAST (no evidence) with a durable,
 *     cryptographically-unrelated-but-DB-bound Gen-3 Temporal launch claim whose payload
 *     identifies THIS withdrawal + THIS Gen-3 permit (mere presence is insufficient).
 *
 * Exactly three prior attempts are required (Gen-3 required exactly two).
 * Never mutates DB, never arms permits, never signs, never broadcasts.
 *
 * Requires independent dual-provider chain reconciliation evidence supplied by the caller
 * (fresh, toncenter + tonapi, bound to the canary hot wallet / recipient / USDT master /
 * net amount and to the three prior attempt query_ids). Missing Temporal history or a lost
 * Signer response never implies "no payment"; fresh HIGH chain recon is the only proof.
 */
import type { PoolClient } from 'pg';

import { isPayoutDispatchPaused } from './flags.js';
import {
  PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
  PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
  PHASE21_CANARY_PAYOUT_PUBLIC_ID,
  PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID,
  type Phase21CanaryPayoutCheck,
  type Phase21CanaryPayoutPlanClient,
} from './phase21-canary-payout-plan.js';
import { PHASE21_NETWORK_CODE } from './phase21-config.js';
import {
  PHASE21_GEN2_AUTHORIZATION_GENERATION,
  PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS,
  evaluatePhase21Gen2ChainReconciliationFreshness,
  type Phase21Gen2IndependentChainReconciliation,
} from './phase21-gen2-recovery-plan.js';
import {
  PHASE21_GEN3_AUTHORIZATION_GENERATION,
  readPhase21Gen2TemporalLaunchClaimPresent,
} from './phase21-gen3-recovery-plan.js';
import { verifyPhase21Gen3TemporalLaunchClaimBinding } from './phase21-gen3-temporal-launch.js';
import {
  PHASE21_CANARY_FROZEN_JETTON_MASTER,
  getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration,
} from './phase21-manual-dispatch-permit.js';
import {
  isPhase21CanaryPriorWorkflowSafeToRestart,
  isPhase21CanaryWithdrawalStateAllowedForResume,
} from './phase21-resume-canary-gates.js';

export const PHASE21_GEN4_RECOVERY_WITHDRAWAL_ID = PHASE21_CANARY_PAYOUT_WITHDRAWAL_ID;
export const PHASE21_GEN4_RECOVERY_PUBLIC_ID = PHASE21_CANARY_PAYOUT_PUBLIC_ID;
export const PHASE21_GEN4_AUTHORIZATION_GENERATION = 4 as const;

/** Exactly this many prior attempts (#1 Gen-1, #2 Gen-2, #3 Gen-3) must exist before Gen-4. */
export const PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT = 3 as const;

/** Max age for independent chain reconciliation evidence before PLAN/APPLY refuse (same as Gen-2/3). */
export const PHASE21_GEN4_CHAIN_RECON_MAX_AGE_MS = PHASE21_GEN2_CHAIN_RECON_MAX_AGE_MS;

/** Frozen canary Hot Wallet (Owner-approved Mainnet wallet; see PHASE_21_STEP4C closeout). */
export const PHASE21_GEN4_CANARY_HOT_WALLET_FRIENDLY =
  'EQD4NWgFbqCOIGQL9k0SDIP8onQH9cj_MxDcBr3N7DYLy8Lf' as const;
export const PHASE21_GEN4_CANARY_HOT_WALLET_RAW =
  '0:f83568056ea08e20640bf64d120c83fca27407f5c8ff3310dc06bdcdec360bcb' as const;

/** Frozen canary USDT jetton master (same constant the permit gates use). */
export const PHASE21_GEN4_CANARY_USDT_JETTON_MASTER = PHASE21_CANARY_FROZEN_JETTON_MASTER;

/** Provider kinds Gen-4 recon evidence must come from (primary / secondary — never swapped). */
export const PHASE21_GEN4_REQUIRED_PRIMARY_PROVIDER_KIND = 'toncenter' as const;
export const PHASE21_GEN4_REQUIRED_SECONDARY_PROVIDER_KIND = 'tonapi' as const;

/** Exact phrase the Owner must attest to for the dual-provider observation gate. */
export const PHASE21_GEN4_EXTERNAL_PROVIDER_ATTESTATION_PHRASE =
  'I_ATTEST_WD_000001_GEN4_INDEPENDENT_TONCENTER_TONAPI_NO_PAYMENT' as const;

/** Owner-attested dual-provider observation gate.
 * JSON confidence/providersIndependent labels alone are NEVER sufficient proof that
 * Toncenter+TonAPI observations actually occurred. This attestation is mandatory.
 * Digests are Owner tooling fingerprints — not cryptographic TLS binding to providers
 * (residual: Owner must still run independent recon tooling before financial EXECUTE).
 */
export interface Phase21Gen4ExternalProviderObservationAttestation {
  readonly kind: 'OWNER_ATTESTED_INDEPENDENT_TONCENTER_TONAPI_OBSERVATION';
  readonly phrase: typeof PHASE21_GEN4_EXTERNAL_PROVIDER_ATTESTATION_PHRASE;
  readonly attestedAt: string;
  readonly primaryProviderKind: 'toncenter';
  readonly secondaryProviderKind: 'tonapi';
  readonly primaryObservationDigest: string;
  readonly secondaryObservationDigest: string;
}

export const PHASE21_GEN4_EXTERNAL_ATTESTATION_KIND =
  'OWNER_ATTESTED_INDEPENDENT_TONCENTER_TONAPI_OBSERVATION' as const;

/** Minimum length of each Owner observation digest (tooling fingerprint). */
export const PHASE21_GEN4_EXTERNAL_ATTESTATION_DIGEST_MIN_LENGTH = 16 as const;

/**
 * Gen-4 chain reconciliation contract: Gen-2 fields plus REQUIRED canary bindings and the
 * three prior attempt query_ids (ordered by attempt_number).
 */
export interface Phase21Gen4IndependentChainReconciliation
  extends Phase21Gen2IndependentChainReconciliation {
  readonly externalProviderObservationAttestation: Phase21Gen4ExternalProviderObservationAttestation;
  readonly primaryProviderKind: 'toncenter';
  readonly secondaryProviderKind: 'tonapi';
  readonly hotWalletFriendly: string;
  readonly hotWalletRaw: string;
  readonly recipientFriendly: string;
  readonly recipientRaw: string;
  readonly usdtJettonMaster: string;
  readonly netAmountAtomic: string;
  /** Exactly three distinct query_ids: attempt #1, #2, #3 (order by attempt_number). */
  readonly priorQueryIds: readonly string[];
}

/** Durable status token used when Temporal history is absent but durable Gen-3 terminal evidence holds. */
export const PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS =
  'TEMPORAL_HISTORY_ABSENT_DURABLE_GEN3_TERMINAL' as const;

export interface Phase21Gen4RecoveryPlanResult {
  readonly ok: boolean;
  readonly mode: 'PLAN';
  readonly withdrawalId: string;
  readonly publicId: string;
  readonly authorizationGeneration: number;
  readonly readyForGen4Apply: boolean;
  readonly checks: readonly Phase21CanaryPayoutCheck[];
  readonly gen1PermitStatus: string | null;
  readonly gen1ConsumedAttemptId: string | null;
  readonly gen2PermitStatus: string | null;
  readonly gen2ConsumedAttemptId: string | null;
  readonly gen2TemporalLaunchClaimPresent: boolean;
  readonly gen3PermitStatus: string | null;
  readonly gen3ConsumedAttemptId: string | null;
  readonly gen3TemporalLaunchClaimBound: boolean;
  readonly gen4PermitStatus: string | null;
  readonly attemptCount: number;
  readonly reservationHeld: boolean;
  readonly generalDispatchPausePreserved: boolean;
  readonly broadcastPerformed: false;
  readonly signed: false;
  readonly mutated: false;
}

function check(
  id: string,
  pass: boolean,
  note: string,
  extra?: { expected?: unknown; actual?: unknown },
): Phase21CanaryPayoutCheck {
  return {
    id,
    status: pass ? 'PASS' : 'FAIL',
    note,
    ...(extra?.expected !== undefined ? { expected: extra.expected } : {}),
    ...(extra?.actual !== undefined ? { actual: extra.actual } : {}),
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Gen-4 chain reconciliation freshness + binding gate.
 *
 * IMPORTANT: `confidence: 'HIGH'` and `providersIndependent: true` alone are INSUFFICIENT proof
 * that Toncenter + TonAPI observations occurred. A mandatory
 * {@link Phase21Gen4ExternalProviderObservationAttestation} (exact kind + phrase, toncenter/
 * tonapi, distinct non-trivial digests, fresh `attestedAt`) is an ADDITIONAL gate. Digests are
 * Owner tooling fingerprints, not cryptographic TLS bindings to the providers.
 *
 * Refuses missing / incomplete / contradictory evidence: wrong providers, wrong canary
 * wallets / recipient / jetton master / net amount, wrong query_id count or duplicates,
 * stale (> 15 min) or future-dated evidence, payment observed, non-HIGH confidence.
 *
 * `options.expectedPriorQueryIds` (PLAN / APPLY / Temporal claim, read from DB under the
 * attempt row locks) additionally requires `priorQueryIds` to equal the DB list exactly.
 */
export function evaluatePhase21Gen4ChainReconciliationFreshness(
  evidence: Phase21Gen4IndependentChainReconciliation | null | undefined,
  nowMs: number = Date.now(),
  options?: { readonly expectedPriorQueryIds?: readonly string[] },
): { readonly ok: boolean; readonly reason: string | null } {
  if (evidence == null || typeof evidence !== 'object') {
    return { ok: false, reason: 'chain_recon_missing' };
  }
  const e = evidence as unknown as Record<string, unknown>;

  if (e.providersIndependent !== true) {
    return { ok: false, reason: 'providers_not_independent' };
  }
  if (e.paymentObserved !== false) {
    return { ok: false, reason: 'payment_observed' };
  }
  if (e.recipientUsdtTransferObserved !== false) {
    return { ok: false, reason: 'recipient_usdt_transfer_observed' };
  }
  if (e.confidence !== 'HIGH') {
    return { ok: false, reason: 'confidence_not_high' };
  }
  if (
    e.primaryProviderKind !== PHASE21_GEN4_REQUIRED_PRIMARY_PROVIDER_KIND ||
    e.secondaryProviderKind !== PHASE21_GEN4_REQUIRED_SECONDARY_PROVIDER_KIND
  ) {
    return { ok: false, reason: 'provider_kinds_invalid' };
  }
  if (typeof e.hotWalletAccountActive !== 'boolean') {
    return { ok: false, reason: 'hot_wallet_account_active_missing' };
  }
  if (!isNonEmptyString(e.detail)) {
    return { ok: false, reason: 'detail_missing' };
  }

  if (!isNonEmptyString(e.hotWalletFriendly) || !isNonEmptyString(e.hotWalletRaw)) {
    return { ok: false, reason: 'hot_wallet_missing' };
  }
  if (
    e.hotWalletFriendly !== PHASE21_GEN4_CANARY_HOT_WALLET_FRIENDLY ||
    e.hotWalletRaw !== PHASE21_GEN4_CANARY_HOT_WALLET_RAW
  ) {
    return { ok: false, reason: 'hot_wallet_mismatch' };
  }
  if (!isNonEmptyString(e.recipientFriendly) || !isNonEmptyString(e.recipientRaw)) {
    return { ok: false, reason: 'recipient_missing' };
  }
  if (
    e.recipientFriendly !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY ||
    e.recipientRaw !== PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW
  ) {
    return { ok: false, reason: 'recipient_mismatch' };
  }
  if (!isNonEmptyString(e.usdtJettonMaster)) {
    return { ok: false, reason: 'usdt_jetton_master_missing' };
  }
  if (e.usdtJettonMaster !== PHASE21_GEN4_CANARY_USDT_JETTON_MASTER) {
    return { ok: false, reason: 'usdt_jetton_master_mismatch' };
  }
  if (!isNonEmptyString(e.netAmountAtomic)) {
    return { ok: false, reason: 'net_amount_missing' };
  }
  if (e.netAmountAtomic !== PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10)) {
    return { ok: false, reason: 'net_amount_mismatch' };
  }

  const ids = e.priorQueryIds;
  if (!Array.isArray(ids)) {
    return { ok: false, reason: 'prior_query_ids_missing' };
  }
  if (ids.length !== PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT) {
    return { ok: false, reason: 'prior_query_ids_wrong_count' };
  }
  if (!ids.every((id) => isNonEmptyString(id))) {
    return { ok: false, reason: 'prior_query_ids_invalid' };
  }
  if (new Set(ids).size !== ids.length) {
    return { ok: false, reason: 'prior_query_ids_not_distinct' };
  }
  if (options?.expectedPriorQueryIds !== undefined) {
    const expected = options.expectedPriorQueryIds;
    const matches =
      expected.length === ids.length && expected.every((id, i) => ids[i] === id);
    if (!matches) {
      return { ok: false, reason: 'prior_query_ids_mismatch_db' };
    }
  }

  // Mandatory Owner-attested external provider observation (ADDITIONAL gate).
  const attestation = evaluatePhase21Gen4ExternalProviderAttestation(
    e.externalProviderObservationAttestation,
    nowMs,
  );
  if (!attestation.ok) {
    return attestation;
  }

  // Shared Gen-2 contract last (distinct providers, performedAt parse, max age).
  return evaluatePhase21Gen2ChainReconciliationFreshness(
    evidence,
    nowMs,
  );
}

function evaluatePhase21Gen4ExternalProviderAttestation(
  raw: unknown,
  nowMs: number,
): { readonly ok: boolean; readonly reason: string | null } {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'external_attestation_missing' };
  }
  const a = raw as Record<string, unknown>;
  if (a.kind !== PHASE21_GEN4_EXTERNAL_ATTESTATION_KIND) {
    return { ok: false, reason: 'external_attestation_kind_invalid' };
  }
  if (a.phrase !== PHASE21_GEN4_EXTERNAL_PROVIDER_ATTESTATION_PHRASE) {
    return { ok: false, reason: 'external_attestation_phrase_invalid' };
  }
  if (
    a.primaryProviderKind !== PHASE21_GEN4_REQUIRED_PRIMARY_PROVIDER_KIND ||
    a.secondaryProviderKind !== PHASE21_GEN4_REQUIRED_SECONDARY_PROVIDER_KIND
  ) {
    return { ok: false, reason: 'external_attestation_provider_kinds_invalid' };
  }
  const p = a.primaryObservationDigest;
  const s = a.secondaryObservationDigest;
  if (
    !isNonEmptyString(p) ||
    !isNonEmptyString(s) ||
    p.trim().length < PHASE21_GEN4_EXTERNAL_ATTESTATION_DIGEST_MIN_LENGTH ||
    s.trim().length < PHASE21_GEN4_EXTERNAL_ATTESTATION_DIGEST_MIN_LENGTH
  ) {
    return { ok: false, reason: 'external_attestation_digest_invalid' };
  }
  if (p.trim() === s.trim()) {
    return { ok: false, reason: 'external_attestation_digests_not_distinct' };
  }
  const attestedMs = typeof a.attestedAt === 'string' ? Date.parse(a.attestedAt) : Number.NaN;
  if (!Number.isFinite(attestedMs)) {
    return { ok: false, reason: 'external_attestation_stale_or_future' };
  }
  const age = nowMs - attestedMs;
  if (age < 0 || age > PHASE21_GEN4_CHAIN_RECON_MAX_AGE_MS) {
    return { ok: false, reason: 'external_attestation_stale_or_future' };
  }
  return { ok: true, reason: null };
}

/**
 * Exact permit→attempt_number bindings: Gen-1 consumed attempt MUST be attempt #1, Gen-2 #2,
 * Gen-3 #3 (not merely "some distinct attempt"). Call under the attempt row locks when
 * revalidating mutations / claims.
 */
export async function verifyPhase21Gen4ExactPermitAttemptBindings(
  client: Pick<PoolClient, 'query'>,
  input: {
    readonly withdrawalId: string;
    readonly gen1ConsumedAttemptId: string;
    readonly gen2ConsumedAttemptId: string;
    readonly gen3ConsumedAttemptId: string;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const res = await client.query<{ id: string; attempt_number: number | string }>(
    `SELECT id::text AS id, attempt_number
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
       AND attempt_number IN (1, 2, 3)`,
    [input.withdrawalId],
  );
  const byNumber = new Map<number, string[]>();
  for (const r of res.rows) {
    const n = Number(r.attempt_number);
    const list = byNumber.get(n) ?? [];
    list.push(r.id);
    byNumber.set(n, list);
  }
  const a1 = byNumber.get(1);
  const a2 = byNumber.get(2);
  const a3 = byNumber.get(3);
  if (a1?.length !== 1 || a2?.length !== 1 || a3?.length !== 1) {
    return { ok: false, reason: 'attempt_rows_incomplete' };
  }
  if (input.gen1ConsumedAttemptId !== a1[0]) {
    return { ok: false, reason: 'gen1_not_bound_to_attempt_1' };
  }
  if (input.gen2ConsumedAttemptId !== a2[0]) {
    return { ok: false, reason: 'gen2_not_bound_to_attempt_2' };
  }
  if (input.gen3ConsumedAttemptId !== a3[0]) {
    return { ok: false, reason: 'gen3_not_bound_to_attempt_3' };
  }
  return { ok: true };
}

/** Test-only mint with valid canary bindings and placeholder (overridable) query ids. */
export function mintPhase21Gen4IndependentChainReconciliationForTests(input?: {
  readonly performedAt?: string;
  readonly hotWalletAccountActive?: boolean;
  readonly detail?: string;
  readonly priorQueryIds?: readonly string[];
  readonly attestedAt?: string;
  readonly primaryObservationDigest?: string;
  readonly secondaryObservationDigest?: string;
  /** Partial override of the whole attestation (unsafe values allowed for refusal tests). */
  readonly attestation?: Partial<Phase21Gen4ExternalProviderObservationAttestation>;
}): Phase21Gen4IndependentChainReconciliation {
  const attestation = {
    kind: PHASE21_GEN4_EXTERNAL_ATTESTATION_KIND,
    phrase: PHASE21_GEN4_EXTERNAL_PROVIDER_ATTESTATION_PHRASE,
    attestedAt: input?.attestedAt ?? new Date().toISOString(),
    primaryProviderKind: 'toncenter',
    secondaryProviderKind: 'tonapi',
    primaryObservationDigest:
      input?.primaryObservationDigest ?? 'toncenter-observation-digest-0001',
    secondaryObservationDigest:
      input?.secondaryObservationDigest ?? 'tonapi-observation-digest-0002',
    ...(input?.attestation ?? {}),
  } as Phase21Gen4ExternalProviderObservationAttestation;
  return {
    externalProviderObservationAttestation: attestation,
    performedAt: input?.performedAt ?? new Date().toISOString(),
    primaryProviderKind: 'toncenter',
    secondaryProviderKind: 'tonapi',
    providersIndependent: true,
    paymentObserved: false,
    confidence: 'HIGH',
    hotWalletAccountActive: input?.hotWalletAccountActive ?? false,
    recipientUsdtTransferObserved: false,
    detail:
      input?.detail ??
      'test: dual-provider HIGH confidence no USDT payout observed (Gen-4 recon contract)',
    hotWalletFriendly: PHASE21_GEN4_CANARY_HOT_WALLET_FRIENDLY,
    hotWalletRaw: PHASE21_GEN4_CANARY_HOT_WALLET_RAW,
    recipientFriendly: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY,
    recipientRaw: PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW,
    usdtJettonMaster: PHASE21_GEN4_CANARY_USDT_JETTON_MASTER,
    netAmountAtomic: PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10),
    priorQueryIds: input?.priorQueryIds ?? ['900000000001', '900000000002', '900000000003'],
  };
}

/**
 * Prior Temporal status safe for Gen-4 ALLOW_DUPLICATE restart.
 * Accepts the durable Gen-3 terminal token in addition to live closed statuses.
 */
export function isPhase21Gen4PriorWorkflowSafeToRestart(statusName: string): boolean {
  if (statusName.trim().toUpperCase() === PHASE21_GEN4_TEMPORAL_HISTORY_ABSENT_STATUS) {
    return true;
  }
  return isPhase21CanaryPriorWorkflowSafeToRestart(statusName);
}

/**
 * Pure eligibility helper for Gen-4 recovery after Gen-1 + Gen-2 + Gen-3 CONSUMED and
 * exactly three FAILED_PRE attempts with no durable signing/broadcast evidence.
 */
export function evaluatePhase21Gen4RecoveryEligibility(input: {
  readonly withdrawalState: string;
  readonly gen1PermitStatus: string;
  readonly gen2PermitStatus: string;
  readonly gen3PermitStatus: string;
  readonly gen3LaunchClaimBound: boolean;
  readonly gen4PermitStatus: string | null;
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly signatureOrBroadcastEvidenceCount: number;
  readonly reservationHeld: boolean;
  readonly settlementPresent: boolean;
  readonly releasePresent: boolean;
  readonly chainReconOk: boolean;
}): { readonly eligible: boolean; readonly reason: string | null } {
  if (
    input.withdrawalState !== 'FAILED_PRE_BROADCAST' &&
    input.withdrawalState !== 'QUEUED'
  ) {
    return { eligible: false, reason: 'withdrawal_state_not_allowed' };
  }
  if (input.gen1PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen1_not_consumed' };
  }
  if (input.gen2PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen2_not_consumed' };
  }
  if (input.gen3PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen3_not_consumed' };
  }
  if (input.gen3LaunchClaimBound !== true) {
    return { eligible: false, reason: 'gen3_launch_claim_not_bound' };
  }
  if (input.gen4PermitStatus === 'CANCELLED') {
    return { eligible: false, reason: 'gen4_cancelled' };
  }
  if (input.attemptCount !== PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT) {
    return { eligible: false, reason: 'prior_attempt_count_not_three' };
  }
  if (input.failedPreAttemptCount !== input.attemptCount) {
    return { eligible: false, reason: 'non_failed_pre_attempts' };
  }
  if (input.signatureOrBroadcastEvidenceCount !== 0) {
    return { eligible: false, reason: 'signature_or_broadcast_evidence' };
  }
  if (!input.reservationHeld) {
    return { eligible: false, reason: 'reservation_not_held' };
  }
  if (input.settlementPresent) {
    return { eligible: false, reason: 'already_settled' };
  }
  if (input.releasePresent) {
    return { eligible: false, reason: 'already_released' };
  }
  if (!input.chainReconOk) {
    return { eligible: false, reason: 'chain_recon_required' };
  }
  return { eligible: true, reason: null };
}

/**
 * Owner-gated Gen-4 resume eligibility (mirrors evaluatePhase21Gen3ConsumedFailedPreRecovery):
 * live ARMED Gen-4 permit, Gen-1 + Gen-2 + Gen-3 CONSUMED, exactly three FAILED_PRE attempts
 * with no evidence, and a prior Temporal status safe to restart (or durable Gen-3 terminal).
 */
export function evaluatePhase21Gen4ConsumedFailedPreRecovery(input: {
  readonly withdrawalState: string;
  readonly gen1PermitStatus: string;
  readonly gen2PermitStatus: string;
  readonly gen3PermitStatus: string;
  readonly gen4PermitStatus: string;
  readonly gen4AuthorizationGeneration: number;
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly broadcastEvidenceCount: number;
  readonly priorWorkflowStatus: string;
}): {
  readonly eligible: boolean;
  readonly reason: string | null;
} {
  if (
    input.withdrawalState !== 'FAILED_PRE_BROADCAST' &&
    input.withdrawalState !== 'QUEUED'
  ) {
    return { eligible: false, reason: 'withdrawal_state_not_allowed' };
  }
  if (!isPhase21CanaryWithdrawalStateAllowedForResume(input.withdrawalState)) {
    return { eligible: false, reason: 'withdrawal_state_not_allowed' };
  }
  if (input.gen1PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen1_not_consumed' };
  }
  if (input.gen2PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen2_not_consumed' };
  }
  if (input.gen3PermitStatus !== 'CONSUMED') {
    return { eligible: false, reason: 'gen3_not_consumed' };
  }
  if (input.gen4PermitStatus !== 'ARMED') {
    return { eligible: false, reason: 'gen4_not_armed' };
  }
  if (input.gen4AuthorizationGeneration !== PHASE21_GEN4_AUTHORIZATION_GENERATION) {
    return { eligible: false, reason: 'gen4_generation_invalid' };
  }
  if (input.attemptCount !== PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT) {
    return { eligible: false, reason: 'prior_attempt_count_not_three' };
  }
  if (input.failedPreAttemptCount !== input.attemptCount) {
    return { eligible: false, reason: 'non_failed_pre_attempts' };
  }
  if (input.broadcastEvidenceCount !== 0) {
    return { eligible: false, reason: 'broadcast_evidence_exists' };
  }
  if (!isPhase21Gen4PriorWorkflowSafeToRestart(input.priorWorkflowStatus)) {
    return { eligible: false, reason: 'prior_workflow_not_safe' };
  }
  return { eligible: true, reason: null };
}

/** Aggregated attempt shape used by PLAN / APPLY revalidation / Temporal launch. */
export interface Phase21Gen4AttemptShape {
  readonly attemptCount: number;
  readonly failedPreAttemptCount: number;
  readonly evidenceCount: number;
  readonly attempt1FailedPre: boolean;
  readonly attempt2FailedPre: boolean;
  readonly attempt3FailedPre: boolean;
}

export function isPhase21Gen4AttemptShapeAccepted(shape: Phase21Gen4AttemptShape): boolean {
  return (
    shape.attemptCount === PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT &&
    shape.failedPreAttemptCount === shape.attemptCount &&
    shape.evidenceCount === 0 &&
    shape.attempt1FailedPre &&
    shape.attempt2FailedPre &&
    shape.attempt3FailedPre
  );
}

/**
 * Read-only aggregate. APPLY revalidation and Temporal claim revalidation MUST call
 * {@link lockPhase21Gen4AttemptRowsAndReadQueryIds} first (FOR UPDATE on the attempt rows,
 * inside the open write transaction) and then this function in the SAME transaction.
 */
export async function readPhase21Gen4AttemptShape(
  client: Pick<PoolClient, 'query'>,
  withdrawalId: string,
): Promise<Phase21Gen4AttemptShape> {
  const attempts = await client.query<{
    c: number;
    failed_pre: number;
    evidence: number;
    attempt1_failed_pre: number;
    attempt2_failed_pre: number;
    attempt3_failed_pre: number;
  }>(
    `SELECT count(*)::int AS c,
            count(*) FILTER (
              WHERE broadcast_result_state::text = 'FAILED_PRE_BROADCAST'
            )::int AS failed_pre,
            count(*) FILTER (
              WHERE signed_external_message_boc IS NOT NULL
                 OR signed_wallet_request_boc IS NOT NULL
                 OR external_message_cell_hash IS NOT NULL
                 OR normalized_external_message_hash IS NOT NULL
                 OR signed_message_hash IS NOT NULL
                 OR broadcast_submitted_at IS NOT NULL
                 OR broadcast_started_at IS NOT NULL
                 OR (chain_reference IS NOT NULL AND btrim(chain_reference) <> '')
            )::int AS evidence,
            count(*) FILTER (
              WHERE attempt_number = 1
                AND broadcast_result_state::text = 'FAILED_PRE_BROADCAST'
            )::int AS attempt1_failed_pre,
            count(*) FILTER (
              WHERE attempt_number = 2
                AND broadcast_result_state::text = 'FAILED_PRE_BROADCAST'
            )::int AS attempt2_failed_pre,
            count(*) FILTER (
              WHERE attempt_number = 3
                AND broadcast_result_state::text = 'FAILED_PRE_BROADCAST'
            )::int AS attempt3_failed_pre
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid`,
    [withdrawalId],
  );
  const row = attempts.rows[0];
  return {
    attemptCount: row?.c ?? 0,
    failedPreAttemptCount: row?.failed_pre ?? 0,
    evidenceCount: row?.evidence ?? 0,
    attempt1FailedPre: (row?.attempt1_failed_pre ?? 0) === 1,
    attempt2FailedPre: (row?.attempt2_failed_pre ?? 0) === 1,
    attempt3FailedPre: (row?.attempt3_failed_pre ?? 0) === 1,
  };
}

/** Query ids of the prior attempts, ordered by attempt_number (read-only, no locks). */
export async function readPhase21Gen4AttemptQueryIds(
  client: Pick<PoolClient, 'query'>,
  withdrawalId: string,
): Promise<readonly string[]> {
  const rows = await client.query<{ query_id: string | null }>(
    `SELECT query_id::text AS query_id
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     ORDER BY attempt_number`,
    [withdrawalId],
  );
  return rows.rows.map((r) => (r.query_id ?? '').trim());
}

/**
 * Lock every attempt row of the withdrawal (FOR UPDATE; cannot be combined with aggregates)
 * and return the ordered query ids. Must run inside the caller's open write transaction,
 * BEFORE {@link readPhase21Gen4AttemptShape} so the shape is read under the row locks.
 */
export async function lockPhase21Gen4AttemptRowsAndReadQueryIds(
  client: Pick<PoolClient, 'query'>,
  withdrawalId: string,
): Promise<readonly string[]> {
  const rows = await client.query<{ query_id: string | null }>(
    `SELECT query_id::text AS query_id
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     ORDER BY attempt_number
     FOR UPDATE`,
    [withdrawalId],
  );
  return rows.rows.map((r) => (r.query_id ?? '').trim());
}

export async function planPhase21Gen4Recovery(
  client: PoolClient & Phase21CanaryPayoutPlanClient,
  input: {
    readonly withdrawalId: string;
    readonly chainReconciliation: Phase21Gen4IndependentChainReconciliation;
    readonly deploymentEnvironment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
    /** Disposable E2E only — production APPLY never sets this. */
    readonly allowNonCanaryWithdrawalIdForTests?: boolean;
  },
): Promise<Phase21Gen4RecoveryPlanResult> {
  const checks: Phase21CanaryPayoutCheck[] = [];
  const env = input.deploymentEnvironment ?? 'LOCAL';

  const canaryIdOk =
    input.withdrawalId === PHASE21_GEN4_RECOVERY_WITHDRAWAL_ID ||
    input.allowNonCanaryWithdrawalIdForTests === true;
  checks.push(
    check(
      'withdrawal_id_authorized',
      canaryIdOk,
      'Gen-4 PLAN hard-binds to Owner canary (or disposable test override)',
      { expected: PHASE21_GEN4_RECOVERY_WITHDRAWAL_ID, actual: input.withdrawalId },
    ),
  );

  const recon = evaluatePhase21Gen4ChainReconciliationFreshness(input.chainReconciliation);
  checks.push(
    check(
      'independent_chain_reconciliation',
      recon.ok,
      recon.ok
        ? 'fresh dual-provider HIGH-confidence no-payment recon bound to canary wallets + 3 query ids'
        : `chain recon refused: ${recon.reason}`,
      {
        actual: {
          performedAt: input.chainReconciliation?.performedAt,
          confidence: input.chainReconciliation?.confidence,
          paymentObserved: input.chainReconciliation?.paymentObserved,
          reason: recon.reason,
        },
      },
    ),
  );

  let publicId: string = PHASE21_GEN4_RECOVERY_PUBLIC_ID;
  let gen1PermitStatus: string | null = null;
  let gen1ConsumedAttemptId: string | null = null;
  let gen2PermitStatus: string | null = null;
  let gen2ConsumedAttemptId: string | null = null;
  let gen2TemporalLaunchClaimPresent = false;
  let gen3PermitStatus: string | null = null;
  let gen3ConsumedAttemptId: string | null = null;
  let gen3TemporalLaunchClaimBound = false;
  let gen4PermitStatus: string | null = null;
  let attemptCount = 0;
  let reservationHeld = false;
  let generalDispatchPausePreserved: boolean;

  await client.query('BEGIN READ ONLY');
  try {
    const paused = await isPayoutDispatchPaused(client, env);
    generalDispatchPausePreserved = paused === true;
    checks.push(
      check(
        'payout_dispatch_pause_preserved',
        paused === true,
        'global PAYOUT_DISPATCH_PAUSE must remain ON',
        { expected: true, actual: paused },
      ),
    );

    const w = await client.query<{
      id: string;
      public_id: string;
      state: string;
      requested_amount_atomic: string;
      fee_amount_atomic: string;
      net_amount_atomic: string;
      reservation_ledger_tx_id: string | null;
      release_ledger_tx_id: string | null;
      settlement_ledger_tx_id: string | null;
      network_code: string;
      recipient_friendly: string;
      recipient_raw: string;
    }>(
      `SELECT w.id::text AS id, w.public_id, w.state::text AS state,
              w.requested_amount_atomic::text AS requested_amount_atomic,
              w.fee_amount_atomic::text AS fee_amount_atomic,
              w.net_amount_atomic::text AS net_amount_atomic,
              w.reservation_ledger_tx_id::text AS reservation_ledger_tx_id,
              w.release_ledger_tx_id::text AS release_ledger_tx_id,
              w.settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
              n.code AS network_code,
              uw.friendly_address AS recipient_friendly,
              uw.raw_address AS recipient_raw
       FROM withdrawals w
       JOIN networks n ON n.id = w.network_id
       JOIN user_wallets uw ON uw.id = w.wallet_id
       WHERE w.id = $1::uuid`,
      [input.withdrawalId],
    );
    const row = w.rows[0];
    checks.push(check('withdrawal_present', row !== undefined, 'withdrawal row must exist'));

    if (row !== undefined) {
      publicId = row.public_id;
      const bindOk =
        input.allowNonCanaryWithdrawalIdForTests === true ||
        (row.public_id === PHASE21_GEN4_RECOVERY_PUBLIC_ID &&
          row.requested_amount_atomic ===
            PHASE21_CANARY_PAYOUT_EXPECTED_GROSS_ATOMIC.toString(10) &&
          row.fee_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_FEE_ATOMIC.toString(10) &&
          row.net_amount_atomic === PHASE21_CANARY_PAYOUT_EXPECTED_NET_ATOMIC.toString(10) &&
          row.recipient_friendly === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_FRIENDLY &&
          row.recipient_raw === PHASE21_CANARY_PAYOUT_EXPECTED_RECIPIENT_RAW &&
          row.network_code === PHASE21_NETWORK_CODE);
      checks.push(
        check('frozen_bindings', bindOk, 'amounts/recipient/network match Gen-4 frozen bindings'),
      );

      const stateOk = row.state === 'FAILED_PRE_BROADCAST' || row.state === 'QUEUED';
      checks.push(
        check('withdrawal_state', stateOk, 'state must be FAILED_PRE_BROADCAST or QUEUED', {
          actual: row.state,
        }),
      );

      reservationHeld = row.reservation_ledger_tx_id !== null;
      checks.push(
        check('reservation_held', reservationHeld, 'reuse existing reservation; no double debit'),
      );
      checks.push(
        check('no_settlement', row.settlement_ledger_tx_id === null, 'must not be settled', {
          actual: row.settlement_ledger_tx_id,
        }),
      );
      checks.push(
        check('no_release', row.release_ledger_tx_id === null, 'must not be released', {
          actual: row.release_ledger_tx_id,
        }),
      );

      const gen1 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        1,
      );
      gen1PermitStatus = gen1?.status ?? null;
      gen1ConsumedAttemptId = gen1?.consumedAttemptId ?? null;
      checks.push(
        check(
          'gen1_consumed_preserved',
          gen1?.status === 'CONSUMED',
          'Gen-1 CONSUMED permit must remain',
          { actual: gen1PermitStatus },
        ),
      );
      const gen2 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        PHASE21_GEN2_AUTHORIZATION_GENERATION,
      );
      gen2PermitStatus = gen2?.status ?? null;
      gen2ConsumedAttemptId = gen2?.consumedAttemptId ?? null;
      checks.push(
        check(
          'gen2_consumed_preserved',
          gen2?.status === 'CONSUMED',
          'Gen-2 CONSUMED permit must remain (never reuse Gen-2)',
          { actual: gen2PermitStatus },
        ),
      );
      checks.push(
        check(
          'gen2_bound_attempt_differs_from_gen1',
          gen1?.consumedAttemptId != null &&
            gen2?.consumedAttemptId != null &&
            gen1.consumedAttemptId !== gen2.consumedAttemptId,
          'Gen-1 and Gen-2 must be bound to distinct attempts',
        ),
      );

      if (gen2 !== null) {
        gen2TemporalLaunchClaimPresent = await readPhase21Gen2TemporalLaunchClaimPresent(client, {
          withdrawalId: input.withdrawalId,
          gen2PermitId: gen2.id,
        });
      }
      checks.push(
        check(
          'gen2_temporal_launch_claim_preserved',
          gen2TemporalLaunchClaimPresent,
          'durable Gen-2 Temporal one-shot claim must remain DISPATCHED (never cleared)',
          { actual: gen2TemporalLaunchClaimPresent ? 'present' : 'absent' },
        ),
      );

      const gen3 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        PHASE21_GEN3_AUTHORIZATION_GENERATION,
      );
      gen3PermitStatus = gen3?.status ?? null;
      gen3ConsumedAttemptId = gen3?.consumedAttemptId ?? null;
      checks.push(
        check(
          'gen3_consumed_preserved',
          gen3?.status === 'CONSUMED',
          'Gen-3 CONSUMED permit must remain (never reuse Gen-3)',
          { actual: gen3PermitStatus },
        ),
      );
      const exactBindings =
        gen1?.consumedAttemptId != null &&
        gen2?.consumedAttemptId != null &&
        gen3?.consumedAttemptId != null
          ? await verifyPhase21Gen4ExactPermitAttemptBindings(client, {
              withdrawalId: input.withdrawalId,
              gen1ConsumedAttemptId: gen1.consumedAttemptId,
              gen2ConsumedAttemptId: gen2.consumedAttemptId,
              gen3ConsumedAttemptId: gen3.consumedAttemptId,
            })
          : ({ ok: false, reason: 'consumed_attempt_id_missing' } as const);
      const bindingReason = exactBindings.ok ? null : exactBindings.reason;
      // The helper reports the first failure in Gen-1 → Gen-2 → Gen-3 order; an earlier
      // generation's check passes only when the first failure belongs to a later generation.
      checks.push(
        check(
          'gen1_bound_to_attempt_1',
          exactBindings.ok ||
            bindingReason === 'gen2_not_bound_to_attempt_2' ||
            bindingReason === 'gen3_not_bound_to_attempt_3',
          'Gen-1 consumed_attempt_id must equal attempt_number 1 (exact binding)',
          { actual: bindingReason ?? gen1ConsumedAttemptId },
        ),
      );
      checks.push(
        check(
          'gen2_bound_to_attempt_2',
          exactBindings.ok || bindingReason === 'gen3_not_bound_to_attempt_3',
          'Gen-2 consumed_attempt_id must equal attempt_number 2 (exact binding)',
          { actual: bindingReason ?? gen2ConsumedAttemptId },
        ),
      );
      checks.push(
        check(
          'gen3_bound_to_attempt_3',
          exactBindings.ok,
          'Gen-3 consumed_attempt_id must equal attempt_number 3 (exact binding)',
          { actual: bindingReason ?? gen3ConsumedAttemptId },
        ),
      );
      checks.push(
        check(
          'gen3_bound_attempt_distinct',
          gen1?.consumedAttemptId != null &&
            gen2?.consumedAttemptId != null &&
            gen3?.consumedAttemptId != null &&
            gen3.consumedAttemptId !== gen1.consumedAttemptId &&
            gen3.consumedAttemptId !== gen2.consumedAttemptId,
          'Gen-3 must be bound to an attempt distinct from Gen-1 and Gen-2',
        ),
      );

      const claimBinding = await verifyPhase21Gen3TemporalLaunchClaimBinding(client, {
        withdrawalId: input.withdrawalId,
      });
      gen3TemporalLaunchClaimBound = claimBinding.ok;
      checks.push(
        check(
          'gen3_temporal_launch_claim_bound',
          claimBinding.ok,
          claimBinding.ok
            ? 'Gen-3 launch claim DISPATCHED, payload bound to this withdrawal + Gen-3 permit, attempt #3 FAILED_PRE with query_id'
            : `Gen-3 launch claim binding refused: ${claimBinding.reason}`,
          { actual: claimBinding.ok ? 'bound' : claimBinding.reason },
        ),
      );

      const gen4 = await getPhase21ManualDispatchPermitByWithdrawalIdAndGeneration(
        client,
        input.withdrawalId,
        PHASE21_GEN4_AUTHORIZATION_GENERATION,
      );
      gen4PermitStatus = gen4?.status ?? null;
      const gen4Ok = gen4 === null || gen4.status === 'ARMED';
      checks.push(
        check(
          'gen4_absent_or_armed',
          gen4Ok,
          'Gen-4 must be absent (fresh) or already ARMED (idempotent)',
          { actual: gen4PermitStatus },
        ),
      );
      checks.push(
        check(
          'gen4_not_prior_generation_reuse',
          gen4 === null ||
            (gen1 !== null &&
              gen2 !== null &&
              gen3 !== null &&
              gen4.id !== gen1.id &&
              gen4.id !== gen2.id &&
              gen4.id !== gen3.id),
          'Gen-4 permit id must differ from Gen-1, Gen-2 and Gen-3 (never reuse prior permits)',
        ),
      );

      const queryIds = await readPhase21Gen4AttemptQueryIds(client, input.withdrawalId);
      const shape = await readPhase21Gen4AttemptShape(client, input.withdrawalId);
      attemptCount = shape.attemptCount;
      checks.push(
        check(
          'prior_attempts_exactly_three_failed_pre',
          isPhase21Gen4AttemptShapeAccepted({ ...shape, evidenceCount: 0 }),
          'exactly attempts #1, #2 and #3 must exist and all be FAILED_PRE_BROADCAST',
          {
            expected: { attemptCount: 3, failedPre: 3 },
            actual: {
              attemptCount: shape.attemptCount,
              failedPre: shape.failedPreAttemptCount,
              attempt1FailedPre: shape.attempt1FailedPre,
              attempt2FailedPre: shape.attempt2FailedPre,
              attempt3FailedPre: shape.attempt3FailedPre,
            },
          },
        ),
      );
      checks.push(
        check(
          'no_signature_or_broadcast_evidence',
          shape.evidenceCount === 0,
          'no BOC / signature / submit / chain reference on attempts #1-#3 (signed-but-lost acceptable only when nothing persisted)',
          { actual: shape.evidenceCount },
        ),
      );

      const reconIds = (input.chainReconciliation as { priorQueryIds?: unknown } | null | undefined)
        ?.priorQueryIds;
      const idsMatch =
        queryIds.length === PHASE21_GEN4_REQUIRED_PRIOR_ATTEMPT_COUNT &&
        queryIds.every((id) => id !== '') &&
        Array.isArray(reconIds) &&
        reconIds.length === queryIds.length &&
        queryIds.every((id, i) => (reconIds as unknown[])[i] === id);
      checks.push(
        check(
          'chain_recon_prior_query_ids_match_db',
          idsMatch,
          'chain recon priorQueryIds must equal attempt #1/#2/#3 query_ids from the DB (order by attempt_number)',
          { expected: queryIds, actual: input.chainReconciliation?.priorQueryIds },
        ),
      );
    }

    await client.query('ROLLBACK');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best-effort
    }
    throw error;
  }

  const hardFails = checks.filter((c) => c.status === 'FAIL');
  const ok = hardFails.length === 0;
  return {
    ok,
    mode: 'PLAN',
    withdrawalId: input.withdrawalId,
    publicId,
    authorizationGeneration: PHASE21_GEN4_AUTHORIZATION_GENERATION,
    readyForGen4Apply: ok,
    checks,
    gen1PermitStatus,
    gen1ConsumedAttemptId,
    gen2PermitStatus,
    gen2ConsumedAttemptId,
    gen2TemporalLaunchClaimPresent,
    gen3PermitStatus,
    gen3ConsumedAttemptId,
    gen3TemporalLaunchClaimBound,
    gen4PermitStatus,
    attemptCount,
    reservationHeld,
    generalDispatchPausePreserved,
    broadcastPerformed: false,
    signed: false,
    mutated: false,
  };
}
