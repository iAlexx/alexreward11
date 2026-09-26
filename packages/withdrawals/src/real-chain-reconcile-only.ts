/**
 * Real-chain reconcile-only observer/classifier (Phase 10).
 *
 * Safety operation — NOT a payout dispatch path:
 * - Never signs, broadcasts, or rebroadcasts
 * - Never calls confirmAndSettle / settlement
 * - Never transitions withdrawal to CONFIRMED / REJECTED / QUEUED / HELD
 * - Never releases Reserved
 * - Never creates attempts or query_ids
 * - Allowed while PAYOUT_DISPATCH_PAUSE=true (does not check/clear pause)
 * - Does not require WITHDRAWAL_REAL_CHAIN_ENABLED
 *
 * Dual TonAPI + TonCenter (or injected TonChainProvider ports) observation only.
 *
 * Durable DEFINITIVE_NONPAYMENT is supported ONLY via the narrowly scoped
 * Wallet V5R1 conjunction:
 *   WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO
 * Provider "not found" / absence alone is NEVER sufficient.
 */
import { createHash } from 'node:crypto';

import type { JettonTransferEvidence, TonChainProvider } from '@alex-rewards/ton';
import {
  TON_TESTNET_NETWORK_GLOBAL_ID,
  validateWalletV5R1SignedExternalAgainstAttempt,
  type DecodedWalletV5R1SignedExternal,
} from '@alex-rewards/ton';
import type { PoolClient } from 'pg';

import {
  matchIntendedJettonPayout,
  primarySecondaryEvidenceAgree,
  type ExpectedJettonPayout,
} from './confirmation.js';
import { isPool, withWithdrawalTransaction, type WithdrawalDb } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import { compactTep74EvidenceSummary, persistIntendedPayoutProvenEvidence } from './reconcile.js';
import type { WithdrawalState } from './state-machine.js';

export type RealChainReconcileOnlyClassification =
  | 'DUAL_PROVIDER_COMPLETE'
  | 'AMBIGUOUS'
  | 'PROVIDER_DISAGREE'
  | 'DEFINITIVE_NONPAYMENT';

export type RealChainReconcileOnlyResolution =
  | 'INTENDED_PAYOUT_PROVEN'
  | 'AMBIGUOUS'
  | 'DEFINITIVE_NONPAYMENT';

/** Stable reason code for the only real-chain definitive-nonpayment rule. */
export type DefinitiveNonpaymentReasonCode = 'WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO';

export const DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO: DefinitiveNonpaymentReasonCode =
  'WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO';

export interface ReconcileRealWithdrawalAttemptOnlyInput {
  readonly withdrawalId: string;
  readonly attemptId: string;
  /** Primary observer (TonAPI in production). */
  readonly primary: TonChainProvider;
  /** Secondary observer (TonCenter in production). Required — never fake a second primary. */
  readonly secondary: TonChainProvider;
  /**
   * Optional observation clock (unix seconds). Defaults to floor(Date.now()/1000).
   * Tests may inject a fixed clock; production callers omit this.
   */
  readonly observedAtUnix?: number;
}

export interface RealChainReconcileProviderObservation {
  readonly providerKind: string | null;
  readonly matched: boolean;
  readonly proofStage: string | null;
  readonly success: boolean | null;
  readonly bounced: boolean | null;
  readonly amountAtomic: string | null;
  readonly queryId: string | null;
  readonly recipient: string | null;
  readonly jettonMaster: string | null;
  readonly senderJettonWallet: string | null;
  readonly hotWalletTxHash: string | null;
  readonly jettonWalletTxHash: string | null;
  readonly error: string | null;
}

export interface ReconcileRealWithdrawalAttemptOnlyResult {
  readonly classification: RealChainReconcileOnlyClassification;
  readonly resolution: RealChainReconcileOnlyResolution;
  readonly withdrawalState: WithdrawalState;
  readonly reconciliationId: string | null;
  readonly evidenceCreated: boolean;
  readonly attemptId: string;
  readonly queryId: string;
  readonly primary: RealChainReconcileProviderObservation;
  readonly secondary: RealChainReconcileProviderObservation;
  readonly providersAgree: boolean;
  /** Feature is implemented; reason is set only when classification is DEFINITIVE_NONPAYMENT. */
  readonly definitiveNonpaymentSupported: true;
  readonly definitiveNonpaymentReason: DefinitiveNonpaymentReasonCode | null;
  /**
   * Explains why DEFINITIVE_NONPAYMENT was not returned when applicable.
   * Null when classification is DEFINITIVE_NONPAYMENT or DUAL_PROVIDER_COMPLETE.
   */
  readonly definitiveNonpaymentGap: string | null;
  readonly expectedSeqno: number | null;
  readonly observedPrimarySeqno: number | null;
  readonly observedSecondarySeqno: number | null;
  readonly validUntil: number | null;
  readonly observedAt: number | null;
  /** Explicit safety witnesses for callers / tests. */
  readonly safety: {
    readonly signed: false;
    readonly broadcast: false;
    readonly settled: false;
    readonly confirmed: false;
    readonly rejected: false;
    readonly reservationReleased: false;
    readonly attemptCreated: false;
    readonly pauseBypassedForDispatch: false;
  };
}

const ALLOWED_STATES: ReadonlySet<WithdrawalState> = new Set([
  'RECONCILE_REQUIRED',
  'HELD',
  'CONFIRMING',
  'BROADCASTED',
  'BROADCASTING',
]);

function summarizeEvidence(
  evidence: JettonTransferEvidence | null,
  error: string | null,
): RealChainReconcileProviderObservation {
  if (error !== null) {
    return {
      providerKind: null,
      matched: false,
      proofStage: null,
      success: null,
      bounced: null,
      amountAtomic: null,
      queryId: null,
      recipient: null,
      jettonMaster: null,
      senderJettonWallet: null,
      hotWalletTxHash: null,
      jettonWalletTxHash: null,
      error: error.slice(0, 500),
    };
  }
  if (evidence === null) {
    return {
      providerKind: null,
      matched: false,
      proofStage: null,
      success: null,
      bounced: null,
      amountAtomic: null,
      queryId: null,
      recipient: null,
      jettonMaster: null,
      senderJettonWallet: null,
      hotWalletTxHash: null,
      jettonWalletTxHash: null,
      error: null,
    };
  }
  return {
    providerKind: evidence.providerKind ?? null,
    matched: false,
    proofStage: evidence.proofStage ?? null,
    success: evidence.success,
    bounced: evidence.bounced,
    amountAtomic: evidence.amountAtomic,
    queryId: evidence.queryId,
    recipient: evidence.recipient,
    jettonMaster: evidence.jettonMaster,
    senderJettonWallet: evidence.senderJettonWallet ?? null,
    hotWalletTxHash: evidence.hotWalletTxHash ?? null,
    jettonWalletTxHash: evidence.jettonWalletTxHash ?? null,
    error: null,
  };
}

function evidenceFingerprint(summary: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(summary)).digest('hex');
}

function safetyWitnesses(): ReconcileRealWithdrawalAttemptOnlyResult['safety'] {
  return {
    signed: false,
    broadcast: false,
    settled: false,
    confirmed: false,
    rejected: false,
    reservationReleased: false,
    attemptCreated: false,
    pauseBypassedForDispatch: false,
  };
}

async function persistResolutionEvidence(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly attemptId: string;
    readonly resolution: 'AMBIGUOUS' | 'DEFINITIVE_NONPAYMENT';
    readonly evidenceSummary: Readonly<Record<string, unknown>>;
    readonly observedRecipient: string | null;
    readonly observedAmountAtomic: string | null;
    readonly observedQueryId: string | null;
  },
): Promise<{ readonly reconciliationId: string; readonly created: boolean }> {
  const fingerprint = evidenceFingerprint(input.evidenceSummary);
  const existing = await client.query<{ id: string; evidence_summary: unknown }>(
    `SELECT id, evidence_summary
     FROM withdrawal_payout_reconciliations
     WHERE withdrawal_attempt_id = $1::uuid
       AND resolution = $2::withdrawal_payout_reconcile_resolution
     ORDER BY created_at DESC
     LIMIT 5`,
    [input.attemptId, input.resolution],
  );
  for (const row of existing.rows) {
    const prior =
      row.evidence_summary !== null && typeof row.evidence_summary === 'object'
        ? (row.evidence_summary as Record<string, unknown>)
        : {};
    if (prior.evidenceFingerprint === fingerprint) {
      return { reconciliationId: row.id, created: false };
    }
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO withdrawal_payout_reconciliations (
       withdrawal_id, withdrawal_attempt_id, resolution, evidence_summary,
       observed_recipient, observed_amount_atomic, observed_asset_symbol,
       observed_query_id, correlation_reference, resolved_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::withdrawal_payout_reconcile_resolution, $4::jsonb,
       $5, $6::bigint, $7, $8::bigint, $9, now()
     )
     RETURNING id`,
    [
      input.withdrawalId,
      input.attemptId,
      input.resolution,
      JSON.stringify({ ...input.evidenceSummary, evidenceFingerprint: fingerprint }),
      input.observedRecipient,
      input.observedAmountAtomic,
      'USDT',
      input.observedQueryId,
      null,
    ],
  );
  const reconciliationId = inserted.rows[0]?.id;
  if (reconciliationId === undefined) {
    throw new WithdrawalDomainError('INTERNAL', `${input.resolution} reconciliation insert failed`);
  }
  return { reconciliationId, created: true };
}

interface SeqnoObservation {
  readonly primarySeqno: number | null;
  readonly secondarySeqno: number | null;
  readonly primaryError: string | null;
  readonly secondaryError: string | null;
  readonly agree: boolean;
}

async function observeDualSeqno(
  primary: TonChainProvider,
  secondary: TonChainProvider,
  hotWallet: string,
): Promise<SeqnoObservation> {
  let primarySeqno: number | null = null;
  let secondarySeqno: number | null = null;
  let primaryError: string | null = null;
  let secondaryError: string | null = null;
  try {
    primarySeqno = await primary.getSeqno(hotWallet);
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error);
  }
  try {
    secondarySeqno = await secondary.getSeqno(hotWallet);
  } catch (error) {
    secondaryError = error instanceof Error ? error.message : String(error);
  }
  const agree =
    primarySeqno !== null &&
    secondarySeqno !== null &&
    primaryError === null &&
    secondaryError === null &&
    primarySeqno === secondarySeqno;
  return { primarySeqno, secondarySeqno, primaryError, secondaryError, agree };
}

interface DefinitiveNonpaymentEval {
  readonly eligible: boolean;
  readonly reason: DefinitiveNonpaymentReasonCode | null;
  readonly gap: string | null;
  readonly decoded: DecodedWalletV5R1SignedExternal | null;
  readonly seqno: SeqnoObservation | null;
  readonly observedAt: number;
  readonly expectedSeqno: number | null;
  readonly validUntil: number | null;
}

function evaluateV5R1ExpiredUnconsumedSeqno(input: {
  readonly snapshot: ReconcileSnapshot;
  readonly dualComplete: boolean;
  readonly primaryMatched: boolean;
  readonly secondaryMatched: boolean;
  readonly classificationBeforeDnp: RealChainReconcileOnlyClassification;
  readonly seqno: SeqnoObservation;
  readonly observedAt: number;
}): DefinitiveNonpaymentEval {
  const observedAt = input.observedAt;
  const base = {
    decoded: null as DecodedWalletV5R1SignedExternal | null,
    seqno: input.seqno,
    observedAt,
    expectedSeqno: input.snapshot.expectedSeqno,
    validUntil: null as number | null,
  };

  if (input.dualComplete || input.primaryMatched || input.secondaryMatched) {
    return {
      eligible: false,
      reason: null,
      gap: 'Positive TEP-74 match present — DEFINITIVE_NONPAYMENT refused',
      ...base,
    };
  }
  if (input.classificationBeforeDnp === 'PROVIDER_DISAGREE') {
    return {
      eligible: false,
      reason: null,
      gap: 'Provider TEP-74 disagreement — DEFINITIVE_NONPAYMENT refused',
      ...base,
    };
  }
  if (input.snapshot.hasIntendedPayoutProven) {
    return {
      eligible: false,
      reason: null,
      gap: 'Existing INTENDED_PAYOUT_PROVEN — DEFINITIVE_NONPAYMENT refused',
      ...base,
    };
  }
  if (input.snapshot.settlementLedgerTxId !== null || input.snapshot.confirmedAt !== null) {
    return {
      eligible: false,
      reason: null,
      gap: 'Existing settlement/confirmation — DEFINITIVE_NONPAYMENT refused',
      ...base,
    };
  }

  const boc = input.snapshot.signedWalletRequestBoc;
  if (boc === null || boc.trim() === '') {
    return {
      eligible: false,
      reason: null,
      gap: 'Missing signed_wallet_request_boc — V5R1 definitive-nonpayment unavailable',
      ...base,
    };
  }

  const identity = validateWalletV5R1SignedExternalAgainstAttempt({
    signedWalletRequestBoc: boc,
    expectedSeqno: input.snapshot.expectedSeqno,
    canonicalMessageHash: input.snapshot.canonicalMessageHash,
    validUntilUnix: input.snapshot.validUntilUnix,
    hotWalletAddress: input.snapshot.hotWalletAddress,
    networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
    signedExternalMessageBoc: input.snapshot.signedExternalMessageBoc,
    normalizedExternalMessageHash: input.snapshot.normalizedExternalMessageHash,
    externalMessageCellHash: input.snapshot.externalMessageCellHash,
  });
  if (!identity.ok) {
    return {
      eligible: false,
      reason: null,
      gap: `V5R1 identity validation failed (${identity.code}): ${identity.message}`,
      ...base,
      validUntil: null,
    };
  }

  const decoded = identity.decoded;
  const validUntil = decoded.validUntil;

  if (input.seqno.primaryError !== null || input.seqno.primarySeqno === null) {
    return {
      eligible: false,
      reason: null,
      gap: `Primary seqno unavailable — DEFINITIVE_NONPAYMENT refused (${input.seqno.primaryError ?? 'null'})`,
      decoded,
      seqno: input.seqno,
      observedAt,
      expectedSeqno: input.snapshot.expectedSeqno,
      validUntil,
    };
  }
  if (input.seqno.secondaryError !== null || input.seqno.secondarySeqno === null) {
    return {
      eligible: false,
      reason: null,
      gap: `Secondary seqno unavailable — DEFINITIVE_NONPAYMENT refused (${input.seqno.secondaryError ?? 'null'})`,
      decoded,
      seqno: input.seqno,
      observedAt,
      expectedSeqno: input.snapshot.expectedSeqno,
      validUntil,
    };
  }
  if (!input.seqno.agree) {
    return {
      eligible: false,
      reason: null,
      gap: `Provider seqno disagreement (primary=${input.seqno.primarySeqno}, secondary=${input.seqno.secondarySeqno})`,
      decoded,
      seqno: input.seqno,
      observedAt,
      expectedSeqno: input.snapshot.expectedSeqno,
      validUntil,
    };
  }

  const current = input.seqno.primarySeqno!;
  const expected = input.snapshot.expectedSeqno;
  if (current > expected) {
    return {
      eligible: false,
      reason: null,
      gap: `Expected seqno slot consumed (current=${current} > expected=${expected}) — forensic classification required; this rule cannot prove nonpayment`,
      decoded,
      seqno: input.seqno,
      observedAt,
      expectedSeqno: expected,
      validUntil,
    };
  }
  if (current < expected) {
    return {
      eligible: false,
      reason: null,
      gap: `Current seqno ${current} < expected ${expected} — DEFINITIVE_NONPAYMENT refused`,
      decoded,
      seqno: input.seqno,
      observedAt,
      expectedSeqno: expected,
      validUntil,
    };
  }
  // current === expected
  if (observedAt <= validUntil) {
    return {
      eligible: false,
      reason: null,
      gap: `Request not yet expired (observedAt=${observedAt} <= valid_until=${validUntil}) — AMBIGUOUS`,
      decoded,
      seqno: input.seqno,
      observedAt,
      expectedSeqno: expected,
      validUntil,
    };
  }

  return {
    eligible: true,
    reason: DEFINITIVE_NONPAYMENT_REASON_V5R1_EXPIRED_UNCONSUMED_SEQNO,
    gap: null,
    decoded,
    seqno: input.seqno,
    observedAt,
    expectedSeqno: expected,
    validUntil,
  };
}

/**
 * Authoritative real-chain reconcile-only classification for an existing attempt.
 * Injected providers only — no signer client, no sendBoc invocation.
 */
export async function reconcileRealWithdrawalAttemptOnly(
  db: WithdrawalDb,
  input: ReconcileRealWithdrawalAttemptOnlyInput,
): Promise<ReconcileRealWithdrawalAttemptOnlyResult> {
  const snapshot = await loadReconcileSnapshot(db, input.withdrawalId, input.attemptId);
  const observedAt = input.observedAtUnix ?? Math.floor(Date.now() / 1000);

  const expected: ExpectedJettonPayout = {
    hotWallet: snapshot.hotWalletAddress,
    jettonMaster: snapshot.jettonMaster,
    recipient: snapshot.recipient,
    amountAtomic: snapshot.netAmountAtomic,
    queryId: snapshot.queryId,
    networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
    senderJettonWallet: snapshot.payoutJettonWallet,
  };

  if (
    snapshot.normalizedExternalMessageHash === null ||
    snapshot.normalizedExternalMessageHash.trim() === ''
  ) {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'Reconcile-only requires persisted normalized_external_message_hash on the attempt',
    );
  }

  const observeInput = {
    hotWallet: snapshot.hotWalletAddress,
    jettonMaster: snapshot.jettonMaster,
    queryId: snapshot.queryId,
    recipient: snapshot.recipient,
    amountAtomic: snapshot.netAmountAtomic,
    senderJettonWallet: snapshot.payoutJettonWallet,
    normalizedExternalMessageHash: snapshot.normalizedExternalMessageHash,
    ...(snapshot.externalMessageCellHash !== null &&
    snapshot.externalMessageCellHash.trim() !== ''
      ? { externalMessageCellHash: snapshot.externalMessageCellHash }
      : {}),
  };

  let primaryEvidence: JettonTransferEvidence | null = null;
  let primaryError: string | null = null;
  try {
    primaryEvidence = await input.primary.observeJettonTransfer(observeInput);
  } catch (error) {
    primaryError = error instanceof Error ? error.message : String(error);
  }

  let secondaryEvidence: JettonTransferEvidence | null = null;
  let secondaryError: string | null = null;
  try {
    secondaryEvidence = await input.secondary.observeJettonTransfer(observeInput);
  } catch (error) {
    secondaryError = error instanceof Error ? error.message : String(error);
  }

  const primaryMatched =
    primaryEvidence !== null && matchIntendedJettonPayout(primaryEvidence, expected);
  const secondaryMatched =
    secondaryEvidence !== null && matchIntendedJettonPayout(secondaryEvidence, expected);
  const primarySummary = {
    ...summarizeEvidence(primaryEvidence, primaryError),
    matched: primaryMatched,
  };
  const secondarySummary = {
    ...summarizeEvidence(secondaryEvidence, secondaryError),
    matched: secondaryMatched,
  };

  const providersAgree =
    primaryEvidence !== null &&
    secondaryEvidence !== null &&
    primarySecondaryEvidenceAgree(primaryEvidence, secondaryEvidence, expected);

  const dualComplete = primaryMatched && secondaryMatched && providersAgree;

  let classification: RealChainReconcileOnlyClassification;
  if (dualComplete) {
    classification = 'DUAL_PROVIDER_COMPLETE';
  } else if (primaryMatched !== secondaryMatched) {
    classification = 'PROVIDER_DISAGREE';
  } else {
    classification = 'AMBIGUOUS';
  }

  const seqnoObs = await observeDualSeqno(
    input.primary,
    input.secondary,
    snapshot.hotWalletAddress,
  );

  const dnpEval = evaluateV5R1ExpiredUnconsumedSeqno({
    snapshot,
    dualComplete,
    primaryMatched,
    secondaryMatched,
    classificationBeforeDnp: classification,
    seqno: seqnoObs,
    observedAt,
  });

  if (dnpEval.eligible && dnpEval.reason !== null) {
    classification = 'DEFINITIVE_NONPAYMENT';
  }

  const persistResult = await withWithdrawalTransaction(db, async (client) => {
    const locked = await client.query<{
      state: WithdrawalState;
      settlement_ledger_tx_id: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT state, settlement_ledger_tx_id::text AS settlement_ledger_tx_id, confirmed_at
       FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
      [input.withdrawalId],
    );
    const state = locked.rows[0]?.state;
    if (state === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
    }
    if (!ALLOWED_STATES.has(state)) {
      throw new WithdrawalDomainError(
        'STATE_CONFLICT',
        'Real-chain reconcile-only refused for withdrawal state',
        { details: { state } },
      );
    }

    const attemptCheck = await client.query<{ id: string; query_id: string; cnt: string }>(
      `SELECT a.id::text AS id, a.query_id::text AS query_id,
              (SELECT COUNT(*)::text FROM withdrawal_attempts wa WHERE wa.withdrawal_id = a.withdrawal_id) AS cnt
       FROM withdrawal_attempts a
       WHERE a.id = $1::uuid AND a.withdrawal_id = $2::uuid
       FOR UPDATE`,
      [input.attemptId, input.withdrawalId],
    );
    if (attemptCheck.rows[0] === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Attempt not found for withdrawal');
    }
    if (attemptCheck.rows[0].query_id !== snapshot.queryId) {
      throw new WithdrawalDomainError('STATE_CONFLICT', 'Attempt query_id changed under lock');
    }

    // Re-check positive payout evidence under lock.
    const proven = await client.query<{ id: string }>(
      `SELECT id FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid
         AND resolution = 'INTENDED_PAYOUT_PROVEN'
       LIMIT 1`,
      [input.attemptId],
    );
    const hasProven = proven.rows[0] !== undefined;
    const hasSettlement =
      locked.rows[0]?.settlement_ledger_tx_id !== null || locked.rows[0]?.confirmed_at !== null;

    if (dualComplete && primaryEvidence !== null && secondaryEvidence !== null) {
      const primaryKind =
        primaryEvidence.providerKind ?? input.primary.constructor?.name ?? 'primary';
      const secondaryKind =
        secondaryEvidence.providerKind ?? input.secondary.constructor?.name ?? 'secondary';
      const evidenceSummary = {
        ...compactTep74EvidenceSummary({
          withdrawalId: input.withdrawalId,
          attemptId: input.attemptId,
          primary: {
            hotWallet: primaryEvidence.hotWallet,
            jettonMaster: primaryEvidence.jettonMaster,
            recipient: primaryEvidence.recipient,
            amountAtomic: primaryEvidence.amountAtomic,
            queryId: primaryEvidence.queryId,
            success: primaryEvidence.success,
            bounced: primaryEvidence.bounced,
            providerKind: String(primaryKind),
            networkGlobalId: primaryEvidence.networkGlobalId ?? TON_TESTNET_NETWORK_GLOBAL_ID,
            ...(primaryEvidence.senderJettonWallet !== undefined
              ? { senderJettonWallet: primaryEvidence.senderJettonWallet }
              : {}),
            ...(primaryEvidence.proofStage !== undefined
              ? { proofStage: primaryEvidence.proofStage }
              : {}),
            ...(primaryEvidence.transactionHash !== undefined
              ? { transactionHash: primaryEvidence.transactionHash }
              : {}),
            ...(primaryEvidence.hotWalletTxHash !== undefined
              ? { hotWalletTxHash: primaryEvidence.hotWalletTxHash }
              : {}),
            ...(primaryEvidence.jettonWalletTxHash !== undefined
              ? { jettonWalletTxHash: primaryEvidence.jettonWalletTxHash }
              : {}),
          },
          secondaryAgree: true,
        }),
        reconcileOnly: true,
        neverSettle: true,
        neverConfirm: true,
        classification: 'DUAL_PROVIDER_COMPLETE',
        secondaryProviderKind: String(secondaryKind),
        secondaryProofStage: secondaryEvidence.proofStage ?? null,
        secondaryTxIdentity:
          secondaryEvidence.transactionHash ??
          secondaryEvidence.hotWalletTxHash ??
          secondaryEvidence.jettonWalletTxHash ??
          null,
      };
      const persisted = await persistIntendedPayoutProvenEvidence(client, {
        withdrawalId: input.withdrawalId,
        attemptId: input.attemptId,
        observedRecipient: primaryEvidence.recipient,
        observedAmountAtomic: primaryEvidence.amountAtomic,
        observedQueryId: primaryEvidence.queryId,
        correlationReference:
          primaryEvidence.transactionHash ?? primaryEvidence.hotWalletTxHash ?? null,
        evidenceSummary,
      });
      return {
        resolution: 'INTENDED_PAYOUT_PROVEN' as const,
        reconciliationId: persisted.reconciliationId,
        evidenceCreated: persisted.created,
        withdrawalState: state,
        definitiveNonpaymentReason: null as DefinitiveNonpaymentReasonCode | null,
        definitiveNonpaymentGap: null as string | null,
      };
    }

    // DEFINITIVE_NONPAYMENT — evidence only; never HELD/REJECTED/settle/release.
    if (
      classification === 'DEFINITIVE_NONPAYMENT' &&
      dnpEval.eligible &&
      dnpEval.reason !== null &&
      !hasProven &&
      !hasSettlement
    ) {
      const dnpSummary: Record<string, unknown> = {
        reconcileOnly: true,
        neverSettle: true,
        neverConfirm: true,
        neverReject: true,
        neverReleaseReservation: true,
        classification: 'DEFINITIVE_NONPAYMENT',
        reason: dnpEval.reason,
        definitiveNonpaymentSupported: true,
        queryId: snapshot.queryId,
        expectedSeqno: dnpEval.expectedSeqno,
        observedPrimarySeqno: dnpEval.seqno?.primarySeqno ?? null,
        observedSecondarySeqno: dnpEval.seqno?.secondarySeqno ?? null,
        validUntil: dnpEval.validUntil,
        observedAt: dnpEval.observedAt,
        walletVersion: 'v5r1',
        opcode: dnpEval.decoded?.opcode ?? null,
        walletIdSerialized: dnpEval.decoded?.walletIdSerialized ?? null,
        signingMessageHash: dnpEval.decoded?.signingMessageHashHex ?? null,
        signedRequestCellHash: dnpEval.decoded?.signedRequestCellHashHex ?? null,
        canonicalMessageHash: snapshot.canonicalMessageHash,
        normalizedExternalMessageHash: snapshot.normalizedExternalMessageHash,
        externalMessageCellHash: snapshot.externalMessageCellHash,
        primary: primarySummary,
        secondary: secondarySummary,
        seqno: {
          primary: dnpEval.seqno?.primarySeqno ?? null,
          secondary: dnpEval.seqno?.secondarySeqno ?? null,
          primaryError: dnpEval.seqno?.primaryError ?? null,
          secondaryError: dnpEval.seqno?.secondaryError ?? null,
          agree: dnpEval.seqno?.agree ?? false,
        },
        note: 'Provider absence alone is never sufficient; proof is expired exact signed V5R1 request + unconsumed expected seqno under dual-provider agreement.',
      };
      const persisted = await persistResolutionEvidence(client, {
        withdrawalId: input.withdrawalId,
        attemptId: input.attemptId,
        resolution: 'DEFINITIVE_NONPAYMENT',
        evidenceSummary: dnpSummary,
        observedRecipient: null,
        observedAmountAtomic: null,
        observedQueryId: snapshot.queryId,
      });
      return {
        resolution: 'DEFINITIVE_NONPAYMENT' as const,
        reconciliationId: persisted.reconciliationId,
        evidenceCreated: persisted.created,
        withdrawalState: state,
        definitiveNonpaymentReason: dnpEval.reason,
        definitiveNonpaymentGap: null as string | null,
      };
    }

    const ambiguousSummary: Record<string, unknown> = {
      reconcileOnly: true,
      neverSettle: true,
      neverConfirm: true,
      classification,
      definitiveNonpaymentSupported: true,
      definitiveNonpaymentReason: null,
      definitiveNonpaymentGap: dnpEval.gap,
      queryId: snapshot.queryId,
      expectedNetAtomic: snapshot.netAmountAtomic,
      expectedRecipient: snapshot.recipient,
      expectedJettonMaster: snapshot.jettonMaster,
      expectedSenderJettonWallet: snapshot.payoutJettonWallet,
      expectedSeqno: snapshot.expectedSeqno,
      observedPrimarySeqno: seqnoObs.primarySeqno,
      observedSecondarySeqno: seqnoObs.secondarySeqno,
      validUntil: dnpEval.validUntil ?? snapshot.validUntilUnix,
      observedAt,
      primary: primarySummary,
      secondary: secondarySummary,
      providersAgree,
      primaryMatched,
      secondaryMatched,
      seqno: {
        primary: seqnoObs.primarySeqno,
        secondary: seqnoObs.secondarySeqno,
        primaryError: seqnoObs.primaryError,
        secondaryError: seqnoObs.secondaryError,
        agree: seqnoObs.agree,
      },
    };
    const persisted = await persistResolutionEvidence(client, {
      withdrawalId: input.withdrawalId,
      attemptId: input.attemptId,
      resolution: 'AMBIGUOUS',
      evidenceSummary: ambiguousSummary,
      observedRecipient: primaryMatched
        ? (primaryEvidence?.recipient ?? null)
        : secondaryMatched
          ? (secondaryEvidence?.recipient ?? null)
          : null,
      observedAmountAtomic: primaryMatched
        ? (primaryEvidence?.amountAtomic ?? null)
        : secondaryMatched
          ? (secondaryEvidence?.amountAtomic ?? null)
          : null,
      observedQueryId: snapshot.queryId,
    });
    return {
      resolution: 'AMBIGUOUS' as const,
      reconciliationId: persisted.reconciliationId,
      evidenceCreated: persisted.created,
      withdrawalState: state,
      definitiveNonpaymentReason: null as DefinitiveNonpaymentReasonCode | null,
      definitiveNonpaymentGap: dnpEval.gap,
    };
  });

  const finalClassification: RealChainReconcileOnlyClassification =
    persistResult.resolution === 'DEFINITIVE_NONPAYMENT'
      ? 'DEFINITIVE_NONPAYMENT'
      : persistResult.resolution === 'INTENDED_PAYOUT_PROVEN'
        ? 'DUAL_PROVIDER_COMPLETE'
        : classification === 'PROVIDER_DISAGREE'
          ? 'PROVIDER_DISAGREE'
          : 'AMBIGUOUS';

  return {
    classification: finalClassification,
    resolution: persistResult.resolution,
    withdrawalState: persistResult.withdrawalState,
    reconciliationId: persistResult.reconciliationId,
    evidenceCreated: persistResult.evidenceCreated,
    attemptId: input.attemptId,
    queryId: snapshot.queryId,
    primary: primarySummary,
    secondary: secondarySummary,
    providersAgree,
    definitiveNonpaymentSupported: true,
    definitiveNonpaymentReason: persistResult.definitiveNonpaymentReason,
    definitiveNonpaymentGap: persistResult.definitiveNonpaymentGap,
    expectedSeqno: snapshot.expectedSeqno,
    observedPrimarySeqno: seqnoObs.primarySeqno,
    observedSecondarySeqno: seqnoObs.secondarySeqno,
    validUntil: dnpEval.validUntil ?? snapshot.validUntilUnix,
    observedAt,
    safety: safetyWitnesses(),
  };
}

interface ReconcileSnapshot {
  readonly withdrawalState: WithdrawalState;
  readonly netAmountAtomic: string;
  readonly recipient: string;
  readonly hotWalletAddress: string;
  readonly payoutJettonWallet: string;
  readonly jettonMaster: string;
  readonly queryId: string;
  readonly expectedSeqno: number;
  readonly validUntilUnix: number;
  readonly canonicalMessageHash: string;
  readonly normalizedExternalMessageHash: string | null;
  readonly externalMessageCellHash: string | null;
  readonly signedWalletRequestBoc: string | null;
  readonly signedExternalMessageBoc: string | null;
  readonly settlementLedgerTxId: string | null;
  readonly confirmedAt: Date | null;
  readonly hasIntendedPayoutProven: boolean;
}

async function loadReconcileSnapshot(
  db: WithdrawalDb,
  withdrawalId: string,
  attemptId: string,
): Promise<ReconcileSnapshot> {
  const run = async (client: PoolClient): Promise<ReconcileSnapshot> => {
    const row = await client.query<{
      state: WithdrawalState;
      net_amount_atomic: string;
      recipient: string;
      hot_wallet_address: string;
      payout_jetton_wallet: string;
      jetton_master: string;
      query_id: string;
      expected_seqno: string;
      valid_until: Date;
      canonical_message_hash: string;
      normalized_external_message_hash: string | null;
      external_message_cell_hash: string | null;
      signed_wallet_request_boc: string | null;
      signed_external_message_boc: string | null;
      settlement_ledger_tx_id: string | null;
      confirmed_at: Date | null;
    }>(
      `SELECT w.state,
              w.net_amount_atomic::text AS net_amount_atomic,
              uw.raw_address AS recipient,
              hw.address AS hot_wallet_address,
              hw.payout_jetton_wallet_address AS payout_jetton_wallet,
              a.contract_identity AS jetton_master,
              att.query_id::text AS query_id,
              att.expected_seqno::text AS expected_seqno,
              att.valid_until,
              att.canonical_message_hash,
              att.normalized_external_message_hash,
              att.external_message_cell_hash,
              att.signed_wallet_request_boc,
              att.signed_external_message_boc,
              w.settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
              w.confirmed_at
       FROM withdrawals w
       JOIN user_wallets uw ON uw.id = w.wallet_id
       JOIN hot_wallets hw ON hw.id = w.hot_wallet_id
       JOIN assets a ON a.id = w.asset_id
       JOIN withdrawal_attempts att
         ON att.id = $2::uuid AND att.withdrawal_id = w.id
       WHERE w.id = $1::uuid`,
      [withdrawalId, attemptId],
    );
    const snap = row.rows[0];
    if (snap === undefined) {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'Withdrawal/attempt not found for real-chain reconcile-only',
      );
    }
    if (!ALLOWED_STATES.has(snap.state)) {
      throw new WithdrawalDomainError(
        'STATE_CONFLICT',
        'Real-chain reconcile-only refused for withdrawal state',
        { details: { state: snap.state } },
      );
    }
    if (
      snap.payout_jetton_wallet === null ||
      snap.payout_jetton_wallet.trim() === '' ||
      snap.jetton_master === null ||
      snap.jetton_master.trim() === ''
    ) {
      throw new WithdrawalDomainError(
        'VALIDATION',
        'Hot Jetton wallet / Jetton master missing for reconcile-only',
      );
    }

    const proven = await client.query<{ id: string }>(
      `SELECT id FROM withdrawal_payout_reconciliations
       WHERE withdrawal_attempt_id = $1::uuid
         AND resolution = 'INTENDED_PAYOUT_PROVEN'
       LIMIT 1`,
      [attemptId],
    );

    return {
      withdrawalState: snap.state,
      netAmountAtomic: snap.net_amount_atomic,
      recipient: snap.recipient,
      hotWalletAddress: snap.hot_wallet_address,
      payoutJettonWallet: snap.payout_jetton_wallet,
      jettonMaster: snap.jetton_master,
      queryId: snap.query_id,
      expectedSeqno: Number(snap.expected_seqno),
      validUntilUnix: Math.floor(new Date(snap.valid_until).getTime() / 1000),
      canonicalMessageHash: snap.canonical_message_hash,
      normalizedExternalMessageHash: snap.normalized_external_message_hash,
      externalMessageCellHash: snap.external_message_cell_hash,
      signedWalletRequestBoc: snap.signed_wallet_request_boc,
      signedExternalMessageBoc: snap.signed_external_message_boc,
      settlementLedgerTxId: snap.settlement_ledger_tx_id,
      confirmedAt: snap.confirmed_at,
      hasIntendedPayoutProven: proven.rows[0] !== undefined,
    };
  };

  if (!isPool(db)) {
    return run(db);
  }
  const client = await db.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}
