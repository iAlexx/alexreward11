import type { Pool } from 'pg';

import {
  createTonChainProvider,
  FakeTonChainProvider,
  type TonChainProvider,
  type TonProviderKind,
} from '@alex-rewards/ton';

import {
  acquireTestDispatchLease,
  createWithdrawalAttempt,
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
import { settleWithdrawalReservation } from './settlement.js';
import {
  SignerHttpClient,
  type SignerClientSignResult,
  type SignerSigningIdentity,
} from './signer-client.js';
import type { WithdrawalState } from './state-machine.js';
import { transitionWithdrawal } from './transitions.js';

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
    signed_external_message_boc: string | null;
    signed_wallet_request_boc: string | null;
    external_message_cell_hash: string | null;
    normalized_external_message_hash: string | null;
    broadcast_submitted_at: Date | null;
  }>(
    `SELECT id, attempt_number, query_id::text, expected_seqno::text,
            canonical_message_hash,
            broadcast_result_state::text AS broadcast_result_state,
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
  if (primaryEvidence !== null && matchIntendedJettonPayout(primaryEvidence, expected)) {
    if (secondary !== null) {
      const secondaryEvidence = await secondary.observeJettonTransfer(observeInput);
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

  await withWithdrawalTransaction(db, async (client) => {
    const current = await client.query<{ state: WithdrawalState }>(
      `SELECT state FROM withdrawals WHERE id = $1::uuid FOR UPDATE`,
      [context.withdrawalId],
    );
    const state = current.rows[0]?.state;
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
  crashAt(input, 'AFTER_CONFIRMATION_BEFORE_SETTLE');

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
    await withWithdrawalTransaction(db, async (client) => {
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

  // --- Load withdrawal + identities (transaction 1) ---
  const context = await withWithdrawalTransaction(db, async (client) => {
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
    let enteredSigning = false;
    if (state !== 'QUEUED' && state !== 'SIGNING') {
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

    if (state === 'QUEUED') {
      await transitionWithdrawal(client, { id: w.id, from: 'QUEUED', to: 'SIGNING' });
      enteredSigning = true;
    }

    const lease = await acquireTestDispatchLease(
      client,
      w.hot_wallet_id,
      `phase10-real-pipeline:${w.id}`,
    );
    stagesCompleted.push('fenced_dispatcher_lease');

    return {
      withdrawalId: w.id,
      hotWalletId: w.hot_wallet_id,
      netAmountAtomic: w.net_amount_atomic,
      recipient,
      hotWalletAddress: hotRow.address,
      payoutJettonWallet: hotRow.payout_jetton_wallet_address,
      signerKeyReference: hotRow.signer_reference,
      jettonMaster,
      fencingToken: lease.fencingToken,
      enteredSigning,
    };
  });
  stagesCompleted.push('approved_withdrawal_loaded');
  if (context.enteredSigning) {
    crashAt(input, 'AFTER_ENTER_SIGNING');
  }

  // --- Authoritative seqno (outside DB lock; chain read) ---
  const seqno = await primary.getSeqno(context.hotWalletAddress);
  stagesCompleted.push('authoritative_wallet_seqno');

  const identity = await signer.getSigningIdentity();
  if (!identity.signingReady) {
    throw new WithdrawalDomainError(
      'EXTERNAL_RESOURCE_REQUIRED',
      'PHASE10_EXTERNAL_RESOURCE_REQUIRED: signer locked / not ready',
      {
        details: {
          missingResources: ['signer encrypted bundle unlock'],
        },
      },
    );
  }
  const publicKey = Buffer.from(identity.publicKeyHex, 'hex');
  if (publicKey.length !== 32) {
    throw new WithdrawalDomainError('VALIDATION', 'Signer public key must be 32 bytes');
  }

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

  const attempt = await withWithdrawalTransaction(db, async (client) => {
    return createWithdrawalAttempt(client, {
      withdrawalId: context.withdrawalId,
      hotWalletId: context.hotWalletId,
      fencingToken: context.fencingToken,
      signerKeyReference: context.signerKeyReference,
      expectedSeqno: BigInt(seqno),
      queryId,
      canonicalMessageHash: canonicalMessageHashHex,
      validUntil,
      scenarioHashInputs: { recipient: context.recipient, path: 'phase10-real' },
    });
  });
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
    });
    return {
      state: 'FAILED_PRE_BROADCAST',
      attemptId: attempt.id,
      reason: 'signer response incomplete or hash mismatch',
      seqno,
      stagesCompleted,
    };
  }

  // --- Persist BOC BEFORE external send (NO BLIND RESEND foundation) ---
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

  // Mark submit intent immediately before sendBoc so crash/timeout cannot look like
  // FAILED_PRE_BROADCAST (ambiguous → reconcile; never blind resend).
  await withWithdrawalTransaction(db, async (client) => {
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
        // Should be rare after markBroadcastSubmitted; still fail closed to reconcile.
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
