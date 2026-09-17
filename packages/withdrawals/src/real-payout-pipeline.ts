import type { Pool, PoolClient } from 'pg';

import {
  admitWalletSeqno,
  createTonChainProvider,
  FakeTonChainProvider,
  type TonChainProvider,
  type TonProviderKind,
} from '@alex-rewards/ton';

import {
  acquireHotWalletDispatchLease,
  assertHotWalletDispatchFence,
  createWithdrawalAttempt,
  hotWalletDispatchOwnerIdentity,
  releaseHotWalletDispatchLease,
  updateAttemptBroadcastState,
} from './attempts.js';
import {
  assertBlindResendForbidden,
  classifySubmitError,
  markBroadcastSubmitted,
  persistPreBroadcastEvidence,
} from './broadcast-gate.js';
import { matchIntendedJettonPayout, primarySecondaryEvidenceAgree } from './confirmation.js';
import type { WithdrawalEngineConfig } from './config.js';
import { withWithdrawalTransaction } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  assertPhase10Ready,
  listPhase10MissingResources,
  type Phase10PayoutConfig,
} from './phase10-config.js';
import { compactTep74EvidenceSummary, persistIntendedPayoutProvenEvidence } from './reconcile.js';
import { settleWithdrawalReservation } from './settlement.js';
import {
  SignerHttpClient,
  type SignerClientSignResult,
  type SignerSigningIdentity,
} from './signer-client.js';
import type { WithdrawalState } from './state-machine.js';
import { transitionWithdrawal } from './transitions.js';
import type { JettonTransferEvidence } from '@alex-rewards/ton';

/** Intent fields required to compute an immutable canonical payout hash (TEP-74). */
export interface RealPayoutCanonicalIntent {
  readonly publicKey: Buffer;
  readonly networkGlobalId: number;
  readonly workchain: number;
  readonly subwalletNumber: number;
  readonly seqno: number;
  readonly validUntil: number;
  readonly queryId: bigint;
  readonly netAmountAtomic: bigint;
  readonly recipientAddress: string;
  readonly hotWalletAddress: string;
  readonly payoutJettonWalletAddress: string;
  readonly jettonMasterIdentity: string;
}

export type BuildCanonicalMessageHash = (intent: RealPayoutCanonicalIntent) => Promise<string>;

export type RealTestnetPayoutPipelineState =
  | 'BLOCKED'
  | 'PAUSED'
  | 'FAILED_PRE_BROADCAST'
  | 'BROADCASTED'
  | 'RECONCILE_REQUIRED'
  | 'CONFIRMED';

export type RealPipelineCrashPoint =
  | 'AFTER_ENTER_SIGNING'
  | 'AFTER_ATTEMPT_CREATED'
  | 'AFTER_SIGNED'
  | 'AFTER_BOC_PERSISTED'
  | 'AFTER_SUBMIT_INTENT'
  | 'AFTER_SEND_ACCEPTED_BEFORE_EVIDENCE'
  | 'AFTER_BROADCAST_EVIDENCE'
  | 'AFTER_CONFIRMATION_BEFORE_SETTLE';

export class PipelineCrashError extends Error {
  readonly point: RealPipelineCrashPoint;

  constructor(point: RealPipelineCrashPoint) {
    super(`PIPELINE_CRASH:${point}`);
    this.name = 'PipelineCrashError';
    this.point = point;
  }
}

export interface RealTestnetPayoutPipelineResult {
  readonly state: RealTestnetPayoutPipelineState;
  readonly attemptId: string | null;
  readonly reason?: string;
  readonly missingResources?: readonly string[];
  readonly seqno?: number;
  readonly stagesCompleted?: readonly string[];
}

export interface RealPayoutSignerPort {
  getSigningIdentity(): Promise<SignerSigningIdentity>;
  signWithdrawalAttempt(withdrawalAttemptId: string): Promise<SignerClientSignResult>;
}

export interface RunRealTestnetPayoutPipelineInput {
  readonly withdrawalId: string;
  readonly phase10: Phase10PayoutConfig;
  readonly engine: WithdrawalEngineConfig;
  /**
   * Build immutable canonical message hash (hex). Wired from `@alex-rewards/signing`
   * by the worker; kept injectable so withdrawals does not depend on signing at build time.
   */
  readonly buildCanonicalMessageHash: BuildCanonicalMessageHash;
  /**
   * Inject FakeTonChainProvider (or other) in unit/integration tests.
   * Production path constructs adapters from Phase 10 provider config.
   */
  readonly chainProvider?: TonChainProvider;
  readonly secondaryChainProvider?: TonChainProvider | null;
  readonly signer?: RealPayoutSignerPort;
  /** When true, skip assertPhase10Ready (tests exercising fake provider only). */
  readonly skipAssertReady?: boolean;
  /**
   * Test-only: when true, persist/sign/broadcast path runs against injected providers
   * without requiring Owner-complete real-chain enablement.
   */
  readonly allowTestExecutionPath?: boolean;
  /** Test-only durable-boundary crash injection. */
  readonly crashAfter?: RealPipelineCrashPoint;
}

function createProviderFromConfig(
  kind: TonProviderKind | null,
  url: string | null,
  apiKey: string | null,
): TonChainProvider | null {
  if (kind === null || url === null) return null;
  if (kind !== 'toncenter' && kind !== 'tonapi') return null;
  return createTonChainProvider({ kind, baseUrl: url, apiKey });
}

function deriveQueryId(withdrawalId: string, attemptNumber: number, salt: string): bigint {
  return (
    (BigInt(attemptNumber) << 32n) +
    BigInt(
      Math.abs([...`${withdrawalId}:${salt}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)),
    )
  );
}

interface PersistedPipelineContext {
  readonly withdrawalId: string;
  readonly state: WithdrawalState;
  readonly hotWalletId: string;
  readonly netAmountAtomic: string;
  readonly recipient: string;
  readonly hotWalletAddress: string;
  readonly payoutJettonWallet: string;
  readonly signerKeyReference: string;
  readonly jettonMaster: string;
}

interface PersistedPipelineAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly queryId: string;
  readonly expectedSeqno: string;
  readonly canonicalMessageHash: string;
  readonly broadcastResultState: string;
  readonly dispatchFencingToken: string;
  readonly signedExternalMessageBoc: string | null;
  readonly signedWalletRequestBoc: string | null;
  readonly externalMessageCellHash: string | null;
  readonly normalizedExternalMessageHash: string | null;
  readonly broadcastSubmittedAt: Date | null;
}

function crashAt(input: RunRealTestnetPayoutPipelineInput, point: RealPipelineCrashPoint): void {
  if (input.crashAfter === point) {
    throw new PipelineCrashError(point);
  }
}

async function loadPersistedAttempt(
  db: Pool,
  withdrawalId: string,
): Promise<PersistedPipelineAttempt | null> {
  const result = await db.query<{
    id: string;
    attempt_number: number;
    query_id: string;
    expected_seqno: string;
    canonical_message_hash: string;
    broadcast_result_state: string;
    dispatch_fencing_token: string;
    signed_external_message_boc: string | null;
    signed_wallet_request_boc: string | null;
    external_message_cell_hash: string | null;
    normalized_external_message_hash: string | null;
    broadcast_submitted_at: Date | null;
  }>(
    `SELECT id, attempt_number, query_id::text, expected_seqno::text,
            canonical_message_hash,
            broadcast_result_state::text AS broadcast_result_state,
            dispatch_fencing_token::text AS dispatch_fencing_token,
            signed_external_message_boc, signed_wallet_request_boc,
            external_message_cell_hash, normalized_external_message_hash,
            broadcast_submitted_at
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     ORDER BY attempt_number DESC
     LIMIT 1`,
    [withdrawalId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        attemptNumber: row.attempt_number,
        queryId: row.query_id,
        expectedSeqno: row.expected_seqno,
        canonicalMessageHash: row.canonical_message_hash,
        broadcastResultState: row.broadcast_result_state,
        dispatchFencingToken: row.dispatch_fencing_token,
        signedExternalMessageBoc: row.signed_external_message_boc,
        signedWalletRequestBoc: row.signed_wallet_request_boc,
        externalMessageCellHash: row.external_message_cell_hash,
        normalizedExternalMessageHash: row.normalized_external_message_hash,
        broadcastSubmittedAt: row.broadcast_submitted_at,
      };
}

async function confirmAndSettle(
  db: Pool,
  input: RunRealTestnetPayoutPipelineInput,
  primary: TonChainProvider,
  secondary: TonChainProvider | null,
  testPath: boolean,
  context: PersistedPipelineContext,
  attempt: PersistedPipelineAttempt,
  stagesCompleted: string[],
): Promise<RealTestnetPayoutPipelineResult> {
  const normalizedExternalMessageHash = attempt.normalizedExternalMessageHash;
  if (normalizedExternalMessageHash === null || normalizedExternalMessageHash.trim() === '') {
    return {
      state: 'RECONCILE_REQUIRED',
      attemptId: attempt.id,
      reason: 'missing_normalized_external_message_hash',
      seqno: Number(attempt.expectedSeqno),
      stagesCompleted,
    };
  }

  const expected = {
    hotWallet: context.hotWalletAddress,
    jettonMaster: context.jettonMaster,
    recipient: context.recipient,
    amountAtomic: context.netAmountAtomic,
    queryId: attempt.queryId,
    networkGlobalId: input.phase10.networkGlobalId,
    senderJettonWallet: context.payoutJettonWallet,
  };
  const observeInput = {
    hotWallet: context.hotWalletAddress,
    jettonMaster: context.jettonMaster,
    queryId: attempt.queryId,
    recipient: context.recipient,
    amountAtomic: context.netAmountAtomic,
    senderJettonWallet: context.payoutJettonWallet,
    normalizedExternalMessageHash,
  };
  const primaryEvidence = await primary.observeJettonTransfer(observeInput);
  stagesCompleted.push('watcher_reconciliation');

  let confirmed = false;
  let secondaryEvidence: JettonTransferEvidence | null = null;
  if (primaryEvidence !== null && matchIntendedJettonPayout(primaryEvidence, expected)) {
    if (secondary !== null) {
      secondaryEvidence = await secondary.observeJettonTransfer(observeInput);
      if (
        secondaryEvidence !== null &&
        primarySecondaryEvidenceAgree(primaryEvidence, secondaryEvidence, expected)
      ) {
        confirmed = true;
        stagesCompleted.push('full_tep74_proof_primary_secondary');
      } else {
        stagesCompleted.push('secondary_disagree_or_missing');
      }
    } else if (testPath) {
      confirmed = true;
      secondaryEvidence = primaryEvidence;
      stagesCompleted.push('full_tep74_proof_primary_test_path');
    } else {
      stagesCompleted.push('secondary_required_for_confirm');
    }
  }

  if (!confirmed) {
    await withWithdrawalTransaction(db, async (client) => {
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'RECONCILE_REQUIRED',
      });
      const current = await client.query<{ state: WithdrawalState }>(
        `SELECT state FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
        [context.withdrawalId],
      );
      if (current.rows[0]?.state === 'CONFIRMING') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'CONFIRMING',
          to: 'RECONCILE_REQUIRED',
        });
      }
    });
    return {
      state: 'RECONCILE_REQUIRED',
      attemptId: attempt.id,
      reason: 'awaiting_tep74_confirmation_or_provider_agree',
      seqno: Number(attempt.expectedSeqno),
      stagesCompleted,
    };
  }

  const primaryEvidenceBound = primaryEvidence!;
  const secondaryEvidenceBound = secondaryEvidence;
  if (
    secondaryEvidenceBound === null ||
    !matchIntendedJettonPayout(secondaryEvidenceBound, expected)
  ) {
    await withWithdrawalTransaction(db, async (client) => {
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'RECONCILE_REQUIRED',
      });
    });
    return {
      state: 'RECONCILE_REQUIRED',
      attemptId: attempt.id,
      reason: 'tep74_secondary_missing_at_persist',
      seqno: Number(attempt.expectedSeqno),
      stagesCompleted,
    };
  }

  // Durable INTENDED_PAYOUT_PROVEN in the same txn as CONFIRMED so
  // AFTER_CONFIRMATION_BEFORE_SETTLE crash still leaves proof.
  await withWithdrawalTransaction(db, async (client) => {
    const current = await client.query<{ state: WithdrawalState }>(
      `SELECT state FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
      [context.withdrawalId],
    );
    const state = current.rows[0]?.state;
    const primaryKind =
      primaryEvidenceBound.providerKind ?? input.phase10.primaryProvider.kind ?? undefined;
    const secondaryKind =
      secondaryEvidenceBound.providerKind ?? input.phase10.secondaryProvider.kind ?? undefined;
    const evidenceSummary = {
      ...compactTep74EvidenceSummary({
        withdrawalId: context.withdrawalId,
        attemptId: attempt.id,
        primary: {
          hotWallet: primaryEvidenceBound.hotWallet,
          jettonMaster: primaryEvidenceBound.jettonMaster,
          recipient: primaryEvidenceBound.recipient,
          amountAtomic: primaryEvidenceBound.amountAtomic,
          queryId: primaryEvidenceBound.queryId,
          success: primaryEvidenceBound.success,
          bounced: primaryEvidenceBound.bounced,
          ...(primaryKind !== undefined ? { providerKind: primaryKind } : {}),
          networkGlobalId: primaryEvidenceBound.networkGlobalId ?? input.phase10.networkGlobalId,
          ...(primaryEvidenceBound.senderJettonWallet !== undefined
            ? { senderJettonWallet: primaryEvidenceBound.senderJettonWallet }
            : {}),
          ...(primaryEvidenceBound.proofStage !== undefined
            ? { proofStage: primaryEvidenceBound.proofStage }
            : {}),
          ...(primaryEvidenceBound.transactionHash !== undefined
            ? { transactionHash: primaryEvidenceBound.transactionHash }
            : {}),
          ...(primaryEvidenceBound.hotWalletTxHash !== undefined
            ? { hotWalletTxHash: primaryEvidenceBound.hotWalletTxHash }
            : {}),
          ...(primaryEvidenceBound.jettonWalletTxHash !== undefined
            ? { jettonWalletTxHash: primaryEvidenceBound.jettonWalletTxHash }
            : {}),
        },
        secondaryAgree: true,
        testPath,
      }),
      primaryProofStage: primaryEvidenceBound.proofStage ?? 'COMPLETE',
      secondaryProviderKind: secondaryKind ?? null,
      secondaryTxIdentity:
        secondaryEvidenceBound.transactionHash ??
        secondaryEvidenceBound.hotWalletTxHash ??
        secondaryEvidenceBound.jettonWalletTxHash ??
        null,
      secondaryProofStage: secondaryEvidenceBound.proofStage ?? 'COMPLETE',
      secondarySuccess: secondaryEvidenceBound.success,
      secondaryNonBounce: secondaryEvidenceBound.bounced === false,
    };
    await persistIntendedPayoutProvenEvidence(client, {
      withdrawalId: context.withdrawalId,
      attemptId: attempt.id,
      observedRecipient: primaryEvidenceBound.recipient,
      observedAmountAtomic: primaryEvidenceBound.amountAtomic,
      observedQueryId: primaryEvidenceBound.queryId,
      correlationReference:
        primaryEvidenceBound.transactionHash ?? primaryEvidenceBound.hotWalletTxHash ?? null,
      evidenceSummary,
    });
    if (state === 'CONFIRMING' || state === 'RECONCILE_REQUIRED') {
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: state,
        to: 'CONFIRMED',
      });
    } else if (state !== 'CONFIRMED') {
      throw new WithdrawalDomainError('STATE_CONFLICT', 'Confirmation state is not resumable', {
        details: { state },
      });
    }
  });
  stagesCompleted.push('durable_tep74_intended_payout_proven');
  crashAt(input, 'AFTER_CONFIRMATION_BEFORE_SETTLE');

  await withWithdrawalTransaction(db, async (client) => {
    await settleWithdrawalReservation(client, { withdrawalId: context.withdrawalId });
    const ownerIdentity = hotWalletDispatchOwnerIdentity(context.withdrawalId);
    const fence = await client.query<{ fencing_token: string }>(
      `SELECT fencing_token::text FROM hot_wallet_dispatch_leases
       WHERE hot_wallet_id = $1::uuid AND owner_identity = $2 AND released_at IS NULL`,
      [context.hotWalletId, ownerIdentity],
    );
    if (fence.rows[0] !== undefined) {
      await releaseHotWalletDispatchLease(client, {
        hotWalletId: context.hotWalletId,
        ownerIdentity,
        fencingToken: BigInt(fence.rows[0].fencing_token),
        reason: 'CONFIRMED_SETTLED',
      });
    }
  });
  stagesCompleted.push('idempotent_confirmed_finalization');
  return {
    state: 'CONFIRMED',
    attemptId: attempt.id,
    seqno: Number(attempt.expectedSeqno),
    stagesCompleted,
  };
}

async function releaseLeaseFailedPreBroadcast(
  client: PoolClient,
  input: {
    readonly hotWalletId: string;
    readonly withdrawalId: string;
    readonly fencingToken: bigint;
  },
): Promise<void> {
  await releaseHotWalletDispatchLease(client, {
    hotWalletId: input.hotWalletId,
    ownerIdentity: hotWalletDispatchOwnerIdentity(input.withdrawalId),
    fencingToken: input.fencingToken,
    reason: 'FAILED_PRE_BROADCAST',
  });
}

function signerResultIsValid(
  signed: SignerClientSignResult,
  attempt: PersistedPipelineAttempt,
): boolean {
  return (
    signed.externalMessageBocBase64.trim() !== '' &&
    signed.signedWalletRequestBocBase64.trim() !== '' &&
    signed.externalMessageCellHash.trim() !== '' &&
    signed.normalizedExternalMessageHash.trim() !== '' &&
    signed.signedMessageHash === signed.normalizedExternalMessageHash &&
    signed.canonicalSigningHash === signed.canonicalMessageHash &&
    signed.canonicalMessageHash === attempt.canonicalMessageHash
  );
}

async function loadPersistedContext(
  db: Pool,
  input: RunRealTestnetPayoutPipelineInput,
): Promise<PersistedPipelineContext> {
  const result = await db.query<{
    id: string;
    state: WithdrawalState;
    hot_wallet_id: string | null;
    net_amount_atomic: string;
    recipient: string | null;
    hot_wallet_address: string | null;
    payout_jetton_wallet_address: string | null;
    signer_reference: string | null;
    contract_identity: string | null;
  }>(
    `SELECT w.id, w.state, w.hot_wallet_id, w.net_amount_atomic::text,
            COALESCE(uw.raw_address, uw.friendly_address) AS recipient,
            hw.address AS hot_wallet_address,
            hw.payout_jetton_wallet_address,
            hw.signer_reference,
            a.contract_identity
     FROM withdrawals w
     LEFT JOIN user_wallets uw ON uw.id = w.wallet_id
     LEFT JOIN hot_wallets hw ON hw.id = w.hot_wallet_id
     LEFT JOIN assets a ON a.id = w.asset_id
     WHERE w.id = $1::uuid`,
    [input.withdrawalId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
  }
  const jettonMaster = input.phase10.jettonMasterIdentity ?? row.contract_identity;
  if (
    row.hot_wallet_id === null ||
    row.recipient === null ||
    row.hot_wallet_address === null ||
    row.payout_jetton_wallet_address === null ||
    row.signer_reference === null ||
    jettonMaster === null
  ) {
    throw new WithdrawalDomainError(
      'EXTERNAL_RESOURCE_REQUIRED',
      'Persisted payout context is incomplete',
    );
  }
  return {
    withdrawalId: row.id,
    state: row.state,
    hotWalletId: row.hot_wallet_id,
    netAmountAtomic: row.net_amount_atomic,
    recipient: row.recipient,
    hotWalletAddress: row.hot_wallet_address,
    payoutJettonWallet: row.payout_jetton_wallet_address,
    signerKeyReference: row.signer_reference,
    jettonMaster,
  };
}

async function resumePersistedPipeline(
  db: Pool,
  input: RunRealTestnetPayoutPipelineInput,
  primary: TonChainProvider,
  secondary: TonChainProvider | null,
  signer: RealPayoutSignerPort,
  testPath: boolean,
  stagesCompleted: string[],
  existingAttempt: PersistedPipelineAttempt,
): Promise<RealTestnetPayoutPipelineResult> {
  const context = await loadPersistedContext(db, input);
  let attempt = existingAttempt;
  let state = context.state;

  if (state === 'CONFIRMED') {
    await withWithdrawalTransaction(db, async (client) => {
      await settleWithdrawalReservation(client, { withdrawalId: context.withdrawalId });
    });
    stagesCompleted.push('idempotent_confirmed_finalization');
    return {
      state: 'CONFIRMED',
      attemptId: attempt.id,
      seqno: Number(attempt.expectedSeqno),
      stagesCompleted,
    };
  }

  if (
    attempt.signedExternalMessageBoc === null &&
    attempt.broadcastSubmittedAt === null &&
    state === 'SIGNING'
  ) {
    let signed: SignerClientSignResult;
    try {
      signed = await signer.signWithdrawalAttempt(attempt.id);
    } catch (error) {
      await withWithdrawalTransaction(db, async (client) => {
        await updateAttemptBroadcastState(client, {
          attemptId: attempt.id,
          broadcastResultState: 'FAILED_PRE_BROADCAST',
        });
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'SIGNING',
          to: 'FAILED_PRE_BROADCAST',
        });
        await releaseLeaseFailedPreBroadcast(client, {
          hotWalletId: context.hotWalletId,
          withdrawalId: context.withdrawalId,
          fencingToken: BigInt(attempt.dispatchFencingToken),
        });
      });
      return {
        state: 'FAILED_PRE_BROADCAST',
        attemptId: attempt.id,
        reason: error instanceof Error ? error.message : String(error),
        seqno: Number(attempt.expectedSeqno),
        stagesCompleted,
      };
    }
    stagesCompleted.push('signer_attempt_id_signing');
    crashAt(input, 'AFTER_SIGNED');
    if (!signerResultIsValid(signed, attempt)) {
      await withWithdrawalTransaction(db, async (client) => {
        await updateAttemptBroadcastState(client, {
          attemptId: attempt.id,
          broadcastResultState: 'FAILED_PRE_BROADCAST',
        });
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'SIGNING',
          to: 'FAILED_PRE_BROADCAST',
        });
        await releaseLeaseFailedPreBroadcast(client, {
          hotWalletId: context.hotWalletId,
          withdrawalId: context.withdrawalId,
          fencingToken: BigInt(attempt.dispatchFencingToken),
        });
      });
      return {
        state: 'FAILED_PRE_BROADCAST',
        attemptId: attempt.id,
        reason: 'signer response incomplete or hash mismatch',
        seqno: Number(attempt.expectedSeqno),
        stagesCompleted,
      };
    }
    await withWithdrawalTransaction(db, async (client) => {
      await assertBlindResendForbidden(client, attempt.id);
      await persistPreBroadcastEvidence(client, {
        attemptId: attempt.id,
        signedExternalMessageBoc: signed.externalMessageBocBase64,
        signedWalletRequestBoc: signed.signedWalletRequestBocBase64,
        externalMessageCellHash: signed.externalMessageCellHash,
        normalizedExternalMessageHash: signed.normalizedExternalMessageHash,
      });
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'SIGNING',
        to: 'BROADCASTING',
      });
    });
    stagesCompleted.push('persist_signed_boc_before_send');
    crashAt(input, 'AFTER_BOC_PERSISTED');
    attempt = (await loadPersistedAttempt(db, context.withdrawalId))!;
    state = 'BROADCASTING';
  }

  if (attempt.signedExternalMessageBoc === null && attempt.broadcastSubmittedAt === null) {
    await withWithdrawalTransaction(db, async (client) => {
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'FAILED_PRE_BROADCAST',
      });
      if (state === 'SIGNING') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'SIGNING',
          to: 'FAILED_PRE_BROADCAST',
        });
        await releaseLeaseFailedPreBroadcast(client, {
          hotWalletId: context.hotWalletId,
          withdrawalId: context.withdrawalId,
          fencingToken: BigInt(attempt.dispatchFencingToken),
        });
      } else if (state === 'BROADCASTING') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'BROADCASTING',
          to: 'RECONCILE_REQUIRED',
        });
      } else if (state === 'BROADCASTED') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'BROADCASTED',
          to: 'RECONCILE_REQUIRED',
        });
      } else if (state === 'CONFIRMING') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'CONFIRMING',
          to: 'RECONCILE_REQUIRED',
        });
      }
    });
    return {
      state: state === 'SIGNING' ? 'FAILED_PRE_BROADCAST' : 'RECONCILE_REQUIRED',
      attemptId: attempt.id,
      reason: 'missing_pre_broadcast_evidence',
      seqno: Number(attempt.expectedSeqno),
      stagesCompleted,
    };
  }

  if (attempt.signedExternalMessageBoc !== null && attempt.broadcastSubmittedAt === null) {
    if (state === 'SIGNING') {
      await withWithdrawalTransaction(db, async (client) => {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'SIGNING',
          to: 'BROADCASTING',
        });
      });
      state = 'BROADCASTING';
    }
    const resumeOwner = hotWalletDispatchOwnerIdentity(context.withdrawalId);
    const resumeFence = BigInt(attempt.dispatchFencingToken);
    await withWithdrawalTransaction(db, async (client) => {
      // Same-withdrawal may reacquire if lease expired while still pre-broadcast.
      // Same-owner reclaim keeps fencing_token STABLE (attempt fence is immutable).
      const lease = await acquireHotWalletDispatchLease(client, context.hotWalletId, resumeOwner);
      if (lease.status !== 'ACQUIRED') {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'Hot wallet dispatch lease unavailable', {
          details: { lease },
        });
      }
      if (lease.fencingToken !== resumeFence) {
        throw new WithdrawalDomainError(
          'STATE_CONFLICT',
          'Pre-broadcast lease fence no longer matches immutable attempt fence',
          {
            details: {
              attemptFence: resumeFence.toString(10),
              leaseFence: lease.fencingToken.toString(10),
            },
          },
        );
      }
      await assertHotWalletDispatchFence(client, {
        hotWalletId: context.hotWalletId,
        fencingToken: lease.fencingToken,
        ownerIdentity: resumeOwner,
      });
      await markBroadcastSubmitted(client, {
        attemptId: attempt.id,
        ambiguityClass: null,
        broadcastResultState: 'UNKNOWN',
      });
    });
    crashAt(input, 'AFTER_SUBMIT_INTENT');

    let sendResult: { accepted: boolean; messageHash?: string; providerReference?: string };
    try {
      sendResult = await primary.sendBoc(attempt.signedExternalMessageBoc);
    } catch (error) {
      const classification = classifySubmitError(error);
      await withWithdrawalTransaction(db, async (client) => {
        await markBroadcastSubmitted(client, {
          attemptId: attempt.id,
          ambiguityClass:
            classification.kind === 'UNKNOWN'
              ? classification.ambiguityClass
              : 'UNKNOWN_SUBMIT_OUTCOME',
          broadcastResultState:
            classification.kind === 'FAILED_PRE_BROADCAST' ? 'RECONCILE_REQUIRED' : 'UNKNOWN',
        });
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'BROADCASTING',
          to: 'RECONCILE_REQUIRED',
        });
      });
      return {
        state: 'RECONCILE_REQUIRED',
        attemptId: attempt.id,
        reason:
          classification.kind === 'BROADCASTED'
            ? 'broadcast_outcome_unknown'
            : classification.reason,
        seqno: Number(attempt.expectedSeqno),
        stagesCompleted,
      };
    }
    if (sendResult.accepted !== true) {
      await withWithdrawalTransaction(db, async (client) => {
        await markBroadcastSubmitted(client, {
          attemptId: attempt.id,
          ambiguityClass: 'UNKNOWN_SUBMIT_OUTCOME',
          broadcastResultState: 'RECONCILE_REQUIRED',
          chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
        });
        await updateAttemptBroadcastState(client, {
          attemptId: attempt.id,
          broadcastResultState: 'RECONCILE_REQUIRED',
          chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
        });
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'BROADCASTING',
          to: 'RECONCILE_REQUIRED',
        });
      });
      stagesCompleted.push('provider_sendBoc_accepted_false');
      return {
        state: 'RECONCILE_REQUIRED',
        attemptId: attempt.id,
        reason: 'sendBoc_accepted_false',
        seqno: Number(attempt.expectedSeqno),
        stagesCompleted,
      };
    }
    crashAt(input, 'AFTER_SEND_ACCEPTED_BEFORE_EVIDENCE');
    await withWithdrawalTransaction(db, async (client) => {
      await markBroadcastSubmitted(client, {
        attemptId: attempt.id,
        broadcastResultState: 'BROADCASTED',
        chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'BROADCASTED',
        markBroadcastStarted: true,
        chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
      });
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'BROADCASTING',
        to: 'BROADCASTED',
      });
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'BROADCASTED',
        to: 'CONFIRMING',
      });
    });
    stagesCompleted.push('provider_sendBoc', 'persist_broadcast_evidence');
    crashAt(input, 'AFTER_BROADCAST_EVIDENCE');
    attempt = (await loadPersistedAttempt(db, context.withdrawalId))!;
    state = 'CONFIRMING';
  } else {
    await withWithdrawalTransaction(db, async (client) => {
      if (state === 'SIGNING') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'SIGNING',
          to: 'BROADCASTING',
        });
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'BROADCASTING',
          to: 'RECONCILE_REQUIRED',
        });
        state = 'RECONCILE_REQUIRED';
      } else if (state === 'BROADCASTING') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'BROADCASTING',
          to: 'RECONCILE_REQUIRED',
        });
        state = 'RECONCILE_REQUIRED';
      } else if (state === 'BROADCASTED') {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'BROADCASTED',
          to: 'CONFIRMING',
        });
        state = 'CONFIRMING';
      }
    });
    stagesCompleted.push('resume_without_blind_resend');
  }

  return confirmAndSettle(
    db,
    input,
    primary,
    secondary,
    testPath,
    { ...context, state },
    attempt,
    stagesCompleted,
  );
}

/**
 * Real Testnet payout pipeline (Phase 10 foundation).
 *
 * Stages:
 * approved/queued → pause check → Owner resource gate → fenced lease →
 * authoritative seqno → immutable attempt → signer (attempt-id only) →
 * persist signed BOC before send → provider sendBoc → broadcast evidence →
 * watcher/reconciliation → full TEP-74 proof → idempotent CONFIRMED.
 *
 * NO BLIND RESEND. Does not invent Owner Jetton / keys. Tests use injected fakes.
 */
export async function runRealTestnetPayoutPipeline(
  db: Pool,
  input: RunRealTestnetPayoutPipelineInput,
): Promise<RealTestnetPayoutPipelineResult> {
  const stagesCompleted: string[] = [];

  const paused = await withWithdrawalTransaction(db, async (client) =>
    isPayoutDispatchPaused(client, input.engine.deploymentEnvironment),
  );
  if (paused) {
    return { state: 'PAUSED', attemptId: null, reason: 'PAYOUT_DISPATCH_PAUSE', stagesCompleted };
  }
  stagesCompleted.push('pause_check');

  const testPath = input.allowTestExecutionPath === true || input.skipAssertReady === true;

  if (!input.skipAssertReady) {
    if (input.phase10.realChainEnabled && input.phase10.jettonMasterIdentity === null) {
      const missing = listPhase10MissingResources(input.phase10);
      throw new WithdrawalDomainError(
        'EXTERNAL_RESOURCE_REQUIRED',
        `PHASE10_EXTERNAL_RESOURCE_REQUIRED: ${missing.join(', ')}`,
        {
          details: {
            code: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
            missingResources: missing,
          },
        },
      );
    }
    try {
      assertPhase10Ready(input.phase10);
    } catch (error) {
      if (error instanceof WithdrawalDomainError && error.code === 'EXTERNAL_RESOURCE_REQUIRED') {
        const missing = (error.details?.missingResources as string[] | undefined) ?? [
          error.publicMessage,
        ];
        return {
          state: 'BLOCKED',
          attemptId: null,
          reason: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
          missingResources: missing,
          stagesCompleted,
        };
      }
      throw error;
    }
  }
  stagesCompleted.push('owner_resource_gate');

  const primary =
    input.chainProvider ??
    createProviderFromConfig(
      input.phase10.primaryProvider.kind,
      input.phase10.primaryProvider.url,
      input.phase10.primaryProvider.apiKey,
    );
  if (primary === null) {
    return {
      state: 'BLOCKED',
      attemptId: null,
      reason: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
      missingResources: ['TON_PRIMARY_PROVIDER_URL / TON_PRIMARY_PROVIDER_KIND'],
      stagesCompleted,
    };
  }

  const secondary =
    input.secondaryChainProvider !== undefined
      ? input.secondaryChainProvider
      : createProviderFromConfig(
          input.phase10.secondaryProvider.kind,
          input.phase10.secondaryProvider.url,
          input.phase10.secondaryProvider.apiKey,
        );

  if (!(primary instanceof FakeTonChainProvider) && !testPath && !input.phase10.realChainEnabled) {
    return {
      state: 'BLOCKED',
      attemptId: null,
      reason: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
      missingResources: ['WITHDRAWAL_REAL_CHAIN_ENABLED=true'],
      stagesCompleted,
    };
  }

  const signer: RealPayoutSignerPort =
    input.signer ??
    new SignerHttpClient({
      baseUrl: input.phase10.signerBaseUrl,
      serviceToken: input.phase10.signerServiceToken,
    });

  const persistedState = await db.query<{ state: WithdrawalState }>(
    `SELECT state FROM withdrawals WHERE id = $1::uuid`,
    [input.withdrawalId],
  );
  const initialState = persistedState.rows[0]?.state;
  if (initialState === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
  }
  const existingAttempt = await loadPersistedAttempt(db, input.withdrawalId);
  if (initialState === 'CONFIRMED') {
    await withWithdrawalTransaction(db, async (client) => {
      await settleWithdrawalReservation(client, { withdrawalId: input.withdrawalId });
    });
    stagesCompleted.push('idempotent_confirmed_finalization');
    return {
      state: 'CONFIRMED',
      attemptId: existingAttempt?.id ?? null,
      ...(existingAttempt === null ? {} : { seqno: Number(existingAttempt.expectedSeqno) }),
      stagesCompleted,
    };
  }
  if (
    existingAttempt !== null &&
    (initialState === 'SIGNING' ||
      initialState === 'BROADCASTING' ||
      initialState === 'BROADCASTED' ||
      initialState === 'CONFIRMING' ||
      initialState === 'RECONCILE_REQUIRED')
  ) {
    return resumePersistedPipeline(
      db,
      input,
      primary,
      secondary,
      signer,
      testPath,
      stagesCompleted,
      existingAttempt,
    );
  }
  if (
    existingAttempt === null &&
    (initialState === 'BROADCASTING' ||
      initialState === 'BROADCASTED' ||
      initialState === 'CONFIRMING' ||
      initialState === 'RECONCILE_REQUIRED')
  ) {
    await withWithdrawalTransaction(db, async (client) => {
      if (initialState !== 'RECONCILE_REQUIRED') {
        await transitionWithdrawal(client, {
          id: input.withdrawalId,
          from: initialState,
          to: 'RECONCILE_REQUIRED',
        });
      }
    });
    return {
      state: 'RECONCILE_REQUIRED',
      attemptId: null,
      reason: 'missing_persisted_attempt',
      stagesCompleted,
    };
  }

  // Stuck SIGNING with zero attempts: only auto-continue when this withdrawal
  // still holds a live (unexpired, unreleased) dispatch lease. Stale/expired
  // or missing leases are recovery-required (no auto release / redispatch).
  if (existingAttempt === null && initialState === 'SIGNING') {
    const leaseRow = await db.query<{
      owner_identity: string | null;
      expires_at: Date | null;
      released_at: Date | null;
      fencing_token: string | null;
    }>(
      `SELECT l.owner_identity, l.expires_at, l.released_at, l.fencing_token::text
       FROM withdrawals w
       LEFT JOIN hot_wallet_dispatch_leases l
         ON l.hot_wallet_id = w.hot_wallet_id
        AND l.owner_identity = ('withdrawal:' || w.id::text)
       WHERE w.id = $1::uuid`,
      [input.withdrawalId],
    );
    const lease = leaseRow.rows[0];
    const owner = hotWalletDispatchOwnerIdentity(input.withdrawalId);
    const liveLease =
      lease !== undefined &&
      lease.owner_identity === owner &&
      lease.released_at === null &&
      lease.expires_at !== null &&
      lease.expires_at.getTime() > Date.now() &&
      lease.fencing_token !== null;
    if (!liveLease) {
      return {
        state: 'BLOCKED',
        attemptId: null,
        reason: 'signing_zero_attempts_recovery_required',
        stagesCompleted,
      };
    }

    // In-process crash recovery: live lease held — re-admit seqno then create attempt.
    const context = await loadPersistedContext(db, input);
    if (secondary === null) {
      return {
        state: 'BLOCKED',
        attemptId: null,
        reason: 'SECONDARY_PROVIDER_REQUIRED: dual-provider seqno admission required',
        stagesCompleted,
      };
    }
    const identity = await signer.getSigningIdentity();
    if (!identity.signingReady) {
      return {
        state: 'BLOCKED',
        attemptId: null,
        reason: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED: signer locked / not ready',
        missingResources: ['signer encrypted bundle unlock'],
        stagesCompleted,
      };
    }
    const publicKey = Buffer.from(identity.publicKeyHex, 'hex');
    if (publicKey.length !== 32) {
      throw new WithdrawalDomainError('VALIDATION', 'Signer public key must be 32 bytes');
    }
    const admission = await admitWalletSeqno({
      networkGlobalId: input.phase10.networkGlobalId,
      hotWalletAddress: context.hotWalletAddress,
      publicKeyHex: identity.publicKeyHex,
      signerKeyReference: identity.publicKeyFingerprint,
      approvedSignerKeyReference: context.signerKeyReference,
      primary,
      secondary,
    });
    if (!admission.ok) {
      await withWithdrawalTransaction(db, async (client) => {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'SIGNING',
          to: 'FAILED_PRE_BROADCAST',
        });
        await releaseLeaseFailedPreBroadcast(client, {
          hotWalletId: context.hotWalletId,
          withdrawalId: context.withdrawalId,
          fencingToken: BigInt(lease.fencing_token!),
        });
      });
      return {
        state: 'FAILED_PRE_BROADCAST',
        attemptId: null,
        reason: `WALLET_SEQNO_ADMISSION_BLOCKED:${admission.code}:${admission.message}`,
        stagesCompleted,
      };
    }
    stagesCompleted.push('authoritative_wallet_seqno');
    stagesCompleted.push('fenced_dispatcher_lease');

    const priorAttempts = await db.query<{ attempt_number: number }>(
      `SELECT attempt_number FROM withdrawal_attempts
       WHERE withdrawal_id = $1::uuid
       ORDER BY attempt_number DESC LIMIT 1`,
      [context.withdrawalId],
    );
    const nextAttemptNumber = (priorAttempts.rows[0]?.attempt_number ?? 0) + 1;
    const queryId = deriveQueryId(context.withdrawalId, nextAttemptNumber, context.recipient);
    const validUntil = new Date(Date.now() + 300_000);
    const validUntilUnix = Math.floor(validUntil.getTime() / 1000);
    const intent: RealPayoutCanonicalIntent = {
      publicKey,
      networkGlobalId: input.phase10.networkGlobalId,
      workchain: 0,
      subwalletNumber: 0,
      seqno: admission.seqno,
      validUntil: validUntilUnix,
      queryId,
      netAmountAtomic: BigInt(context.netAmountAtomic),
      recipientAddress: context.recipient,
      hotWalletAddress: context.hotWalletAddress,
      payoutJettonWalletAddress: context.payoutJettonWallet,
      jettonMasterIdentity: context.jettonMaster,
    };
    const canonicalMessageHashHex = await input.buildCanonicalMessageHash(intent);
    const fencingToken = BigInt(lease.fencing_token!);
    let attempt;
    try {
      attempt = await withWithdrawalTransaction(db, async (client) => {
        return createWithdrawalAttempt(client, {
          withdrawalId: context.withdrawalId,
          hotWalletId: context.hotWalletId,
          fencingToken,
          leaseOwnerIdentity: owner,
          signerKeyReference: context.signerKeyReference,
          expectedSeqno: BigInt(admission.seqno),
          queryId,
          canonicalMessageHash: canonicalMessageHashHex,
          validUntil,
          scenarioHashInputs: { recipient: context.recipient, path: 'phase10-real' },
        });
      });
    } catch (error) {
      await withWithdrawalTransaction(db, async (client) => {
        await transitionWithdrawal(client, {
          id: context.withdrawalId,
          from: 'SIGNING',
          to: 'FAILED_PRE_BROADCAST',
        });
        await releaseLeaseFailedPreBroadcast(client, {
          hotWalletId: context.hotWalletId,
          withdrawalId: context.withdrawalId,
          fencingToken,
        });
      });
      return {
        state: 'FAILED_PRE_BROADCAST',
        attemptId: null,
        reason: error instanceof Error ? error.message : String(error),
        seqno: admission.seqno,
        stagesCompleted,
      };
    }
    stagesCompleted.push('immutable_payout_attempt');
    const persistedAttempt = await loadPersistedAttempt(db, context.withdrawalId);
    if (persistedAttempt === null) {
      return {
        state: 'RECONCILE_REQUIRED',
        attemptId: attempt.id,
        reason: 'missing_persisted_attempt_after_create',
        seqno: admission.seqno,
        stagesCompleted,
      };
    }
    return resumePersistedPipeline(
      db,
      input,
      primary,
      secondary,
      signer,
      testPath,
      stagesCompleted,
      persistedAttempt,
    );
  }

  if (secondary === null) {
    return {
      state: 'BLOCKED',
      attemptId: null,
      reason: 'SECONDARY_PROVIDER_REQUIRED: dual-provider seqno admission required',
      stagesCompleted,
    };
  }

  // --- Load withdrawal context WITHOUT entering SIGNING or acquiring lease ---
  const loaded = await withWithdrawalTransaction(db, async (client) => {
    const locked = await client.query<{
      id: string;
      state: WithdrawalState;
      hot_wallet_id: string | null;
      wallet_id: string;
      net_amount_atomic: string;
      asset_id: string;
    }>(
      `SELECT w.id, w.state, w.hot_wallet_id, w.wallet_id, w.net_amount_atomic::text, w.asset_id
       FROM withdrawals w
       WHERE w.id = $1::uuid
       FOR UPDATE`,
      [input.withdrawalId],
    );
    const w = locked.rows[0];
    if (w === undefined) {
      throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found');
    }
    if (w.hot_wallet_id === null) {
      throw new WithdrawalDomainError('CONFIG', 'Hot wallet missing on withdrawal');
    }

    let state = w.state;
    if (state === 'APPROVED') {
      await transitionWithdrawal(client, { id: w.id, from: 'APPROVED', to: 'QUEUED' });
      state = 'QUEUED';
    }
    if (state === 'FAILED_PRE_BROADCAST') {
      await transitionWithdrawal(client, {
        id: w.id,
        from: 'FAILED_PRE_BROADCAST',
        to: 'QUEUED',
      });
      state = 'QUEUED';
    }
    if (state !== 'QUEUED') {
      throw new WithdrawalDomainError('STATE_CONFLICT', 'Pipeline expects APPROVED/QUEUED', {
        details: { state },
      });
    }

    const wallet = await client.query<{ raw_address: string; friendly_address: string | null }>(
      `SELECT raw_address, friendly_address FROM user_wallets WHERE id = $1::uuid`,
      [w.wallet_id],
    );
    const recipient = wallet.rows[0]?.raw_address ?? wallet.rows[0]?.friendly_address ?? '';
    if (recipient === '') {
      throw new WithdrawalDomainError('WALLET_INELIGIBLE', 'Recipient wallet missing');
    }

    const hot = await client.query<{
      address: string;
      friendly_address: string | null;
      signer_reference: string;
      payout_jetton_wallet_address: string | null;
    }>(
      `SELECT address, friendly_address, signer_reference, payout_jetton_wallet_address
       FROM hot_wallets WHERE id = $1::uuid`,
      [w.hot_wallet_id],
    );
    const hotRow = hot.rows[0];
    if (hotRow === undefined) {
      throw new WithdrawalDomainError('CONFIG', 'Hot wallet row missing');
    }
    if (
      hotRow.payout_jetton_wallet_address === null ||
      hotRow.payout_jetton_wallet_address.trim() === ''
    ) {
      throw new WithdrawalDomainError(
        'EXTERNAL_RESOURCE_REQUIRED',
        'PHASE10_EXTERNAL_RESOURCE_REQUIRED: hot_wallets.payout_jetton_wallet_address',
        {
          details: {
            missingResources: ['payout Jetton wallet identity on hot_wallets'],
          },
        },
      );
    }

    const jettonMaster =
      input.phase10.jettonMasterIdentity ??
      (
        await client.query<{ contract_identity: string | null }>(
          `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
          [w.asset_id],
        )
      ).rows[0]?.contract_identity ??
      null;
    if (jettonMaster === null || jettonMaster.trim() === '') {
      throw new WithdrawalDomainError(
        'EXTERNAL_RESOURCE_REQUIRED',
        'PHASE10_EXTERNAL_RESOURCE_REQUIRED: TON_TESTNET_JETTON_MASTER',
        {
          details: {
            missingResources: ['TON_TESTNET_JETTON_MASTER (Owner-approved Testnet Jetton master)'],
          },
        },
      );
    }

    return {
      withdrawalId: w.id,
      hotWalletId: w.hot_wallet_id,
      netAmountAtomic: w.net_amount_atomic,
      recipient,
      hotWalletAddress: hotRow.address,
      payoutJettonWallet: hotRow.payout_jetton_wallet_address,
      signerKeyReference: hotRow.signer_reference,
      jettonMaster,
    };
  });
  stagesCompleted.push('approved_withdrawal_loaded');

  const identity = await signer.getSigningIdentity();
  if (!identity.signingReady) {
    return {
      state: 'BLOCKED',
      attemptId: null,
      reason: 'PHASE10_EXTERNAL_RESOURCE_REQUIRED: signer locked / not ready',
      missingResources: ['signer encrypted bundle unlock'],
      stagesCompleted,
    };
  }
  const publicKey = Buffer.from(identity.publicKeyHex, 'hex');
  if (publicKey.length !== 32) {
    throw new WithdrawalDomainError('VALIDATION', 'Signer public key must be 32 bytes');
  }

  // --- Account-state / seqno admission BEFORE SIGNING and lease ---
  const initialAdmission = await admitWalletSeqno({
    networkGlobalId: input.phase10.networkGlobalId,
    hotWalletAddress: loaded.hotWalletAddress,
    publicKeyHex: identity.publicKeyHex,
    signerKeyReference: identity.publicKeyFingerprint,
    approvedSignerKeyReference: loaded.signerKeyReference,
    primary,
    secondary,
  });
  if (!initialAdmission.ok) {
    stagesCompleted.push('wallet_seqno_admission_blocked');
    return {
      state: 'BLOCKED',
      attemptId: null,
      reason: `WALLET_SEQNO_ADMISSION_BLOCKED:${initialAdmission.code}:${initialAdmission.message}`,
      stagesCompleted,
    };
  }
  stagesCompleted.push('authoritative_wallet_seqno');

  // --- Enter SIGNING + acquire dispatch lease (only after admission) ---
  let context: {
    readonly withdrawalId: string;
    readonly hotWalletId: string;
    readonly netAmountAtomic: string;
    readonly recipient: string;
    readonly hotWalletAddress: string;
    readonly payoutJettonWallet: string;
    readonly signerKeyReference: string;
    readonly jettonMaster: string;
    readonly fencingToken: bigint;
    readonly ownerIdentity: string;
  };
  try {
    context = await withWithdrawalTransaction(db, async (client) => {
      const locked = await client.query<{ state: WithdrawalState }>(
        `SELECT state FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
        [loaded.withdrawalId],
      );
      const state = locked.rows[0]?.state;
      if (state !== 'QUEUED') {
        throw new WithdrawalDomainError('STATE_CONFLICT', 'Pipeline expects QUEUED before SIGNING', {
          details: { state },
        });
      }
      await transitionWithdrawal(client, {
        id: loaded.withdrawalId,
        from: 'QUEUED',
        to: 'SIGNING',
      });
      const ownerIdentity = hotWalletDispatchOwnerIdentity(loaded.withdrawalId);
      const lease = await acquireHotWalletDispatchLease(client, loaded.hotWalletId, ownerIdentity);
      if (lease.status !== 'ACQUIRED') {
        await transitionWithdrawal(client, {
          id: loaded.withdrawalId,
          from: 'SIGNING',
          to: 'FAILED_PRE_BROADCAST',
        });
        throw new WithdrawalDomainError('STATE_CONFLICT', 'Hot wallet dispatch lease unavailable', {
          details: { lease },
        });
      }
      return {
        ...loaded,
        fencingToken: lease.fencingToken,
        ownerIdentity,
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Hot wallet dispatch lease unavailable')) {
      return {
        state: 'FAILED_PRE_BROADCAST',
        attemptId: null,
        reason: message,
        seqno: initialAdmission.seqno,
        stagesCompleted,
      };
    }
    throw error;
  }
  stagesCompleted.push('fenced_dispatcher_lease');
  crashAt(input, 'AFTER_ENTER_SIGNING');

  // Re-validate admission before immutable attempt (state may change between reads).
  const readmission = await admitWalletSeqno({
    networkGlobalId: input.phase10.networkGlobalId,
    hotWalletAddress: context.hotWalletAddress,
    publicKeyHex: identity.publicKeyHex,
    signerKeyReference: identity.publicKeyFingerprint,
    approvedSignerKeyReference: context.signerKeyReference,
    primary,
    secondary,
  });
  if (!readmission.ok || readmission.seqno !== initialAdmission.seqno) {
    await withWithdrawalTransaction(db, async (client) => {
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'SIGNING',
        to: 'FAILED_PRE_BROADCAST',
      });
      await releaseLeaseFailedPreBroadcast(client, {
        hotWalletId: context.hotWalletId,
        withdrawalId: context.withdrawalId,
        fencingToken: context.fencingToken,
      });
    });
    return {
      state: 'FAILED_PRE_BROADCAST',
      attemptId: null,
      reason: !readmission.ok
        ? `WALLET_SEQNO_READMISSION_BLOCKED:${readmission.code}:${readmission.message}`
        : `WALLET_SEQNO_CHANGED:initial=${initialAdmission.seqno} current=${readmission.seqno}`,
      seqno: initialAdmission.seqno,
      stagesCompleted,
    };
  }
  const seqno = readmission.seqno;

  const priorAttempts = await db.query<{ attempt_number: number }>(
    `SELECT attempt_number FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     ORDER BY attempt_number DESC LIMIT 1`,
    [context.withdrawalId],
  );
  const nextAttemptNumber = (priorAttempts.rows[0]?.attempt_number ?? 0) + 1;
  const queryId = deriveQueryId(context.withdrawalId, nextAttemptNumber, context.recipient);
  const validUntil = new Date(Date.now() + 300_000);
  const validUntilUnix = Math.floor(validUntil.getTime() / 1000);

  const intent: RealPayoutCanonicalIntent = {
    publicKey,
    networkGlobalId: input.phase10.networkGlobalId,
    workchain: 0,
    subwalletNumber: 0,
    seqno,
    validUntil: validUntilUnix,
    queryId,
    netAmountAtomic: BigInt(context.netAmountAtomic),
    recipientAddress: context.recipient,
    hotWalletAddress: context.hotWalletAddress,
    payoutJettonWalletAddress: context.payoutJettonWallet,
    jettonMasterIdentity: context.jettonMaster,
  };
  const canonicalMessageHashHex = await input.buildCanonicalMessageHash(intent);

  let attempt;
  try {
    attempt = await withWithdrawalTransaction(db, async (client) => {
      return createWithdrawalAttempt(client, {
        withdrawalId: context.withdrawalId,
        hotWalletId: context.hotWalletId,
        fencingToken: context.fencingToken,
        leaseOwnerIdentity: context.ownerIdentity,
        signerKeyReference: context.signerKeyReference,
        expectedSeqno: BigInt(seqno),
        queryId,
        canonicalMessageHash: canonicalMessageHashHex,
        validUntil,
        scenarioHashInputs: { recipient: context.recipient, path: 'phase10-real' },
      });
    });
  } catch (error) {
    await withWithdrawalTransaction(db, async (client) => {
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'SIGNING',
        to: 'FAILED_PRE_BROADCAST',
      });
      await releaseLeaseFailedPreBroadcast(client, {
        hotWalletId: context.hotWalletId,
        withdrawalId: context.withdrawalId,
        fencingToken: context.fencingToken,
      });
    });
    return {
      state: 'FAILED_PRE_BROADCAST',
      attemptId: null,
      reason: error instanceof Error ? error.message : String(error),
      seqno,
      stagesCompleted,
    };
  }
  stagesCompleted.push('immutable_payout_attempt');
  crashAt(input, 'AFTER_ATTEMPT_CREATED');

  // --- Sign (attempt-id only) ---
  let signed: SignerClientSignResult;
  try {
    signed = await signer.signWithdrawalAttempt(attempt.id);
  } catch (error) {
    await withWithdrawalTransaction(db, async (client) => {
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'FAILED_PRE_BROADCAST',
      });
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'SIGNING',
        to: 'FAILED_PRE_BROADCAST',
      });
      await releaseLeaseFailedPreBroadcast(client, {
        hotWalletId: context.hotWalletId,
        withdrawalId: context.withdrawalId,
        fencingToken: context.fencingToken,
      });
    });
    return {
      state: 'FAILED_PRE_BROADCAST',
      attemptId: attempt.id,
      reason: error instanceof Error ? error.message : String(error),
      seqno,
      stagesCompleted,
    };
  }
  stagesCompleted.push('signer_attempt_id_signing');
  crashAt(input, 'AFTER_SIGNED');

  if (
    signed.externalMessageBocBase64.trim() === '' ||
    signed.signedWalletRequestBocBase64.trim() === '' ||
    signed.externalMessageCellHash.trim() === '' ||
    signed.normalizedExternalMessageHash.trim() === '' ||
    signed.signedMessageHash !== signed.normalizedExternalMessageHash ||
    signed.canonicalSigningHash !== signed.canonicalMessageHash ||
    signed.canonicalMessageHash !== attempt.canonicalMessageHash
  ) {
    await withWithdrawalTransaction(db, async (client) => {
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'FAILED_PRE_BROADCAST',
      });
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'SIGNING',
        to: 'FAILED_PRE_BROADCAST',
      });
      await releaseLeaseFailedPreBroadcast(client, {
        hotWalletId: context.hotWalletId,
        withdrawalId: context.withdrawalId,
        fencingToken: context.fencingToken,
      });
    });
    return {
      state: 'FAILED_PRE_BROADCAST',
      attemptId: attempt.id,
      reason: 'signer response incomplete or hash mismatch',
      seqno,
      stagesCompleted,
    };
  }

  const ownerIdentity = context.ownerIdentity;

  // --- Persist BOC BEFORE external send (NO BLIND RESEND foundation) ---
  await withWithdrawalTransaction(db, async (client) => {
    await assertHotWalletDispatchFence(client, {
      hotWalletId: context.hotWalletId,
      fencingToken: context.fencingToken,
      ownerIdentity,
    });
    await assertBlindResendForbidden(client, attempt.id);
    await persistPreBroadcastEvidence(client, {
      attemptId: attempt.id,
      signedExternalMessageBoc: signed.externalMessageBocBase64,
      signedWalletRequestBoc: signed.signedWalletRequestBocBase64,
      externalMessageCellHash: signed.externalMessageCellHash,
      normalizedExternalMessageHash: signed.normalizedExternalMessageHash,
    });
    await transitionWithdrawal(client, {
      id: context.withdrawalId,
      from: 'SIGNING',
      to: 'BROADCASTING',
    });
  });
  stagesCompleted.push('persist_signed_boc_before_send');
  crashAt(input, 'AFTER_BOC_PERSISTED');

  // Mark submit intent immediately before sendBoc so crash/timeout cannot look like
  // FAILED_PRE_BROADCAST (ambiguous → reconcile; never blind resend).
  await withWithdrawalTransaction(db, async (client) => {
    await assertHotWalletDispatchFence(client, {
      hotWalletId: context.hotWalletId,
      fencingToken: context.fencingToken,
      ownerIdentity,
    });
    await markBroadcastSubmitted(client, {
      attemptId: attempt.id,
      ambiguityClass: null,
      broadcastResultState: 'UNKNOWN',
    });
  });
  crashAt(input, 'AFTER_SUBMIT_INTENT');

  let sendResult: { accepted: boolean; messageHash?: string; providerReference?: string };
  try {
    sendResult = await primary.sendBoc(signed.externalMessageBocBase64);
  } catch (error) {
    const classification = classifySubmitError(error);
    await withWithdrawalTransaction(db, async (client) => {
      if (classification.kind === 'FAILED_PRE_BROADCAST') {
        await markBroadcastSubmitted(client, {
          attemptId: attempt.id,
          ambiguityClass: 'UNKNOWN_SUBMIT_OUTCOME',
          broadcastResultState: 'RECONCILE_REQUIRED',
        });
      } else if (classification.kind === 'UNKNOWN') {
        await markBroadcastSubmitted(client, {
          attemptId: attempt.id,
          ambiguityClass: classification.ambiguityClass,
          broadcastResultState: 'UNKNOWN',
        });
      } else {
        await markBroadcastSubmitted(client, {
          attemptId: attempt.id,
          ambiguityClass: 'UNKNOWN_SUBMIT_OUTCOME',
          broadcastResultState: 'UNKNOWN',
        });
      }
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'BROADCASTING',
        to: 'RECONCILE_REQUIRED',
      });
    });
    stagesCompleted.push('provider_sendBoc_ambiguous');
    const reason =
      classification.kind === 'UNKNOWN' || classification.kind === 'FAILED_PRE_BROADCAST'
        ? classification.reason
        : 'broadcast_outcome_unknown';
    return {
      state: 'RECONCILE_REQUIRED',
      attemptId: attempt.id,
      reason,
      seqno,
      stagesCompleted,
    };
  }

  if (sendResult.accepted !== true) {
    await withWithdrawalTransaction(db, async (client) => {
      await markBroadcastSubmitted(client, {
        attemptId: attempt.id,
        ambiguityClass: 'UNKNOWN_SUBMIT_OUTCOME',
        broadcastResultState: 'RECONCILE_REQUIRED',
        chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
      });
      await updateAttemptBroadcastState(client, {
        attemptId: attempt.id,
        broadcastResultState: 'RECONCILE_REQUIRED',
        chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
      });
      await transitionWithdrawal(client, {
        id: context.withdrawalId,
        from: 'BROADCASTING',
        to: 'RECONCILE_REQUIRED',
      });
    });
    stagesCompleted.push('provider_sendBoc_accepted_false');
    return {
      state: 'RECONCILE_REQUIRED',
      attemptId: attempt.id,
      reason: 'sendBoc_accepted_false',
      seqno,
      stagesCompleted,
    };
  }

  crashAt(input, 'AFTER_SEND_ACCEPTED_BEFORE_EVIDENCE');

  await withWithdrawalTransaction(db, async (client) => {
    await markBroadcastSubmitted(client, {
      attemptId: attempt.id,
      broadcastResultState: 'BROADCASTED',
      chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
    });
    await updateAttemptBroadcastState(client, {
      attemptId: attempt.id,
      broadcastResultState: 'BROADCASTED',
      markBroadcastStarted: true,
      chainReference: sendResult.providerReference ?? sendResult.messageHash ?? null,
    });
    await transitionWithdrawal(client, {
      id: context.withdrawalId,
      from: 'BROADCASTING',
      to: 'BROADCASTED',
    });
    await transitionWithdrawal(client, {
      id: context.withdrawalId,
      from: 'BROADCASTED',
      to: 'CONFIRMING',
    });
  });
  stagesCompleted.push('provider_sendBoc');
  stagesCompleted.push('persist_broadcast_evidence');
  crashAt(input, 'AFTER_BROADCAST_EVIDENCE');

  const persistedAttempt = await loadPersistedAttempt(db, context.withdrawalId);
  if (persistedAttempt === null) {
    throw new WithdrawalDomainError('INTERNAL', 'Persisted payout attempt missing');
  }
  return confirmAndSettle(
    db,
    input,
    primary,
    secondary,
    testPath,
    {
      withdrawalId: context.withdrawalId,
      state: 'CONFIRMING',
      hotWalletId: context.hotWalletId,
      netAmountAtomic: context.netAmountAtomic,
      recipient: context.recipient,
      hotWalletAddress: context.hotWalletAddress,
      payoutJettonWallet: context.payoutJettonWallet,
      signerKeyReference: context.signerKeyReference,
      jettonMaster: context.jettonMaster,
    },
    persistedAttempt,
    stagesCompleted,
  );
}
