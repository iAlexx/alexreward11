/**
 * Phase 10 controlled campaign planner + file-based evidence coordinator.
 * Never creates withdrawals. Never flips env flags. No financial mutation.
 * No secrets / BOC bodies in evidence.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { isPool } from './db.js';
import { checkPhase10PayoutInvariants } from './phase10-payout-invariants.js';

export type Phase10ScenarioClassification = 'LOCAL_DETERMINISTIC' | 'REQUIRES_REAL_TESTNET';

export type Phase10CampaignMode = 'dry-run' | 'real';

export const PHASE10_CAMPAIGN_MIN_ACCEPTANCE_PAYOUTS = 100 as const;

export interface Phase10FailureScenario {
  readonly id: string;
  readonly name: string;
  readonly classification: Phase10ScenarioClassification;
  readonly description: string;
}

/** Safe evidence hashes only — never BOC, never secrets. */
export interface Phase10CampaignSafeHashes {
  readonly canonicalMessageHash: string | null;
  readonly signedMessageHash: string | null;
  readonly chainReference: string | null;
  readonly intentHash: string | null;
}

/** Safe evidence fields only — no secrets, no BOC bodies, no API keys. */
export interface Phase10CampaignEvidenceRecord {
  readonly campaignId: string;
  readonly ordinal: number;
  readonly withdrawalId: string | null;
  readonly publicId: string | null;
  readonly userId: string | null;
  readonly quoteId: string | null;
  readonly grossAmountAtomic: string | null;
  readonly netAmountAtomic: string | null;
  readonly feeAmountAtomic: string | null;
  readonly attemptId: string | null;
  readonly attemptNumber: number | null;
  readonly workflowId: string | null;
  readonly queryId: string | null;
  readonly hashes: Phase10CampaignSafeHashes;
  readonly providerProofIds: readonly string[];
  readonly primaryProviderProofIdentity: string | null;
  readonly secondaryProviderProofIdentity: string | null;
  readonly chainTxId: string | null;
  readonly recipient: string | null;
  readonly jettonMaster: string | null;
  readonly finalState: string | null;
  readonly settlementLedgerTxId: string | null;
  readonly invariantResult: string | null;
  readonly duplicateEconomicTransferResult: string | null;
  readonly scenarioId: string;
  readonly timing: {
    readonly requestedAt: string | null;
    readonly approvedAt: string | null;
    readonly broadcastedAt: string | null;
    readonly confirmedAt: string | null;
    readonly settledAt: string | null;
  };
  readonly broadcastResultState: string | null;
  readonly ambiguityClass: string | null;
  readonly confirmed: boolean;
  readonly settled: boolean;
  readonly notes: string | null;
  readonly recordedAt: string;
  /** Legacy aliases */
  readonly withdrawalPublicId?: string | null;
  readonly state?: string | null;
}

export interface Phase10CampaignRealModeGates {
  readonly ownerApprovedRealTestnet: boolean;
  readonly realChainEnabledExplicit: boolean;
  readonly fakeChainDisabledExplicit: boolean;
  readonly controlledUserAllowlisted: boolean;
  readonly fundingComplete: boolean;
  readonly pauseAcknowledged: boolean;
}

export interface Phase10CampaignPlanItem {
  readonly scenarioId: string;
  readonly name: string;
  readonly classification: Phase10ScenarioClassification;
  readonly intendedAction: 'simulate_local' | 'require_real_testnet' | 'skip_until_real_gates';
  readonly description: string;
}

export interface Phase10CampaignPlan {
  readonly mode: Phase10CampaignMode;
  readonly accepted: boolean;
  readonly refusalReason: string | null;
  readonly intendedMatrix: readonly Phase10CampaignPlanItem[];
  readonly localDeterministicCount: number;
  readonly requiresRealTestnetCount: number;
  readonly createsWithdrawals: false;
  readonly flipsEnv: false;
}

export interface Phase10CampaignManifest {
  readonly schemaVersion: 1;
  readonly campaignId: string;
  readonly networkCode: 'TON_TESTNET';
  readonly assetSymbol: 'USDT';
  readonly controlledUserId: string | null;
  readonly plannedCount: number;
  readonly plannedPayoutCount: number;
  readonly acceptanceCampaign: boolean;
  readonly amountPolicy: {
    readonly grossAtomic: string | null;
    readonly netAtomic: string | null;
    readonly feeAtomic: string | null;
    readonly note: string | null;
  };
  readonly mode: Phase10CampaignMode;
  readonly status:
    | 'INITIALIZED'
    | 'WITHDRAWALS_ATTACHED'
    | 'EVIDENCE_REFRESHED'
    | 'AWAITING_OWNER_APPROVAL'
    | 'COMPLETED'
    | 'ABORTED';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly gates: Phase10CampaignRealModeGates | null;
  readonly realExecutionGates: Phase10CampaignRealExecutionGates | null;
  readonly realModeCheckpoint: string | null;
  readonly baselineIsolatedHistoricalAttemptIds: readonly string[];
  readonly withdrawalIds: readonly string[];
  readonly plan: Phase10CampaignPlan;
  readonly evidence: readonly Phase10CampaignEvidenceRecord[];
  readonly createsWithdrawals: false;
  readonly flipsEnv: false;
  readonly mutatesFinancialState: false;
  readonly unlocksSigner: false;
}

/** Explicit real-mode execution gates — never inferred / auto-satisfied. */
export interface Phase10CampaignRealExecutionGates {
  readonly campaignIdProvided: boolean;
  readonly maxCountProvided: boolean;
  readonly controlledUserProvided: boolean;
  readonly networkIsTonTestnet: boolean;
  readonly realChainEnabledTrue: boolean;
  readonly fakeChainEnabledFalse: boolean;
  readonly readinessPass: boolean;
  readonly signerUnlockedExternally: boolean;
  readonly confirmationPhraseMatches: boolean;
}

export const PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE =
  'OWNER_APPROVES_PHASE10_REAL_TESTNET_CAMPAIGN' as const;

export function allRealExecutionGatesTrue(gates: Phase10CampaignRealExecutionGates): boolean {
  return (
    gates.campaignIdProvided === true &&
    gates.maxCountProvided === true &&
    gates.controlledUserProvided === true &&
    gates.networkIsTonTestnet === true &&
    gates.realChainEnabledTrue === true &&
    gates.fakeChainEnabledFalse === true &&
    gates.readinessPass === true &&
    gates.signerUnlockedExternally === true &&
    gates.confirmationPhraseMatches === true
  );
}

export const PHASE10_FAILURE_SCENARIO_CATALOGUE: readonly Phase10FailureScenario[] = [
  {
    id: 'P10-LOCAL-CONFIRMED_SUCCESS',
    name: 'Confirmed success (fake)',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Fake chain CONFIRMED_SUCCESS path with settlement',
  },
  {
    id: 'P10-LOCAL-DEFINITE_PRE_BROADCAST_FAILURE',
    name: 'Definite pre-broadcast failure',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'FAILED_PRE_BROADCAST without mayHaveBroadcast',
  },
  {
    id: 'P10-LOCAL-BROADCAST_RESULT_UNKNOWN',
    name: 'Broadcast result UNKNOWN',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Ambiguous submit → RECONCILE_REQUIRED; no blind resend',
  },
  {
    id: 'P10-LOCAL-UNKNOWN_THEN_CONFIRMED',
    name: 'UNKNOWN then confirmed on reconciliation',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Reconcile proves intended payout after UNKNOWN',
  },
  {
    id: 'P10-LOCAL-UNKNOWN_THEN_NONPAYMENT',
    name: 'UNKNOWN then definitive nonpayment',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Reconcile proves nonpayment; release path only after definitive evidence',
  },
  {
    id: 'P10-LOCAL-CRASH_BEFORE_BROADCAST',
    name: 'Crash before possible broadcast',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Crash injection before sendBoc; safe retry',
  },
  {
    id: 'P10-LOCAL-CRASH_AFTER_BROADCAST',
    name: 'Crash after possible broadcast',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Crash after submit intent; must not blind-resend',
  },
  {
    id: 'P10-LOCAL-LEASE_FENCING',
    name: 'Stale dispatch lease fencing',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Competing fencing tokens cannot create attempts',
  },
  {
    id: 'P10-LOCAL-APPROVED_OUTBOX_LEASE',
    name: 'Approved outbox SKIP LOCKED concurrency',
    classification: 'LOCAL_DETERMINISTIC',
    description: 'Concurrent workers serialize via FOR UPDATE SKIP LOCKED',
  },
  {
    id: 'P10-REAL-TEP74_DUAL_PROVIDER',
    name: 'TEP-74 dual provider confirm',
    classification: 'REQUIRES_REAL_TESTNET',
    description: 'Primary+secondary agree on Jetton transfer evidence',
  },
  {
    id: 'P10-REAL-PROVIDER_DISAGREE',
    name: 'Provider disagreement',
    classification: 'REQUIRES_REAL_TESTNET',
    description: 'Primary/secondary disagree → reconcile, never confirm',
  },
  {
    id: 'P10-REAL-RPC_TIMEOUT_UNKNOWN',
    name: 'RPC timeout → UNKNOWN',
    classification: 'REQUIRES_REAL_TESTNET',
    description: 'sendBoc timeout classifies UNKNOWN; no blind resend',
  },
  {
    id: 'P10-REAL-SIGNER_LOCKED',
    name: 'Signer locked mid-window',
    classification: 'REQUIRES_REAL_TESTNET',
    description: 'Locked signer fails closed before broadcast',
  },
  {
    id: 'P10-REAL-HOT_WALLET_BALANCE',
    name: 'Hot wallet balance observation',
    classification: 'REQUIRES_REAL_TESTNET',
    description: 'Injected/provider balance observe around controlled payout',
  },
  {
    id: 'P10-REAL-PAUSE_RESUME',
    name: 'PAYOUT_DISPATCH_PAUSE gate',
    classification: 'REQUIRES_REAL_TESTNET',
    description: 'Paused dispatch returns PAUSED; resume only after Owner',
  },
] as const;

function allGatesTrue(gates: Phase10CampaignRealModeGates): boolean {
  return (
    gates.ownerApprovedRealTestnet === true &&
    gates.realChainEnabledExplicit === true &&
    gates.fakeChainDisabledExplicit === true &&
    gates.controlledUserAllowlisted === true &&
    gates.fundingComplete === true &&
    gates.pauseAcknowledged === true
  );
}

export interface PlanPhase10CampaignInput {
  readonly mode?: Phase10CampaignMode;
  readonly gates?: Phase10CampaignRealModeGates;
  readonly scenarioIds?: readonly string[];
}

export function planPhase10Campaign(input: PlanPhase10CampaignInput = {}): Phase10CampaignPlan {
  const mode: Phase10CampaignMode = input.mode === 'real' ? 'real' : 'dry-run';
  const catalogue =
    input.scenarioIds !== undefined && input.scenarioIds.length > 0
      ? PHASE10_FAILURE_SCENARIO_CATALOGUE.filter((s) => input.scenarioIds!.includes(s.id))
      : PHASE10_FAILURE_SCENARIO_CATALOGUE;

  if (mode === 'real') {
    const gates = input.gates;
    if (gates === undefined || !allGatesTrue(gates)) {
      return {
        mode,
        accepted: false,
        refusalReason:
          'real mode refused: all Phase10CampaignRealModeGates must be explicitly true (env not flipped)',
        intendedMatrix: catalogue.map((s) => ({
          scenarioId: s.id,
          name: s.name,
          classification: s.classification,
          intendedAction: 'skip_until_real_gates',
          description: s.description,
        })),
        localDeterministicCount: catalogue.filter((s) => s.classification === 'LOCAL_DETERMINISTIC')
          .length,
        requiresRealTestnetCount: catalogue.filter((s) => s.classification === 'REQUIRES_REAL_TESTNET')
          .length,
        createsWithdrawals: false,
        flipsEnv: false,
      };
    }
  }

  const intendedMatrix: Phase10CampaignPlanItem[] = catalogue.map((s) => ({
    scenarioId: s.id,
    name: s.name,
    classification: s.classification,
    intendedAction:
      s.classification === 'LOCAL_DETERMINISTIC' ? 'simulate_local' : 'require_real_testnet',
    description: s.description,
  }));

  return {
    mode,
    accepted: true,
    refusalReason: null,
    intendedMatrix,
    localDeterministicCount: intendedMatrix.filter((i) => i.classification === 'LOCAL_DETERMINISTIC')
      .length,
    requiresRealTestnetCount: intendedMatrix.filter(
      (i) => i.classification === 'REQUIRES_REAL_TESTNET',
    ).length,
    createsWithdrawals: false,
    flipsEnv: false,
  };
}

export interface InitPhase10CampaignManifestInput {
  readonly campaignId?: string;
  readonly plannedCount: number;
  /** Acceptance campaigns require plannedCount >= 100. Default true. */
  readonly acceptanceCampaign?: boolean;
  readonly mode?: Phase10CampaignMode;
  readonly gates?: Phase10CampaignRealModeGates;
  readonly scenarioIds?: readonly string[];
  readonly controlledUserId?: string | null;
  readonly amountPolicy?: {
    readonly grossAtomic?: string | null;
    readonly netAtomic?: string | null;
    readonly feeAtomic?: string | null;
    readonly note?: string | null;
  };
  readonly baselineIsolatedHistoricalAttemptIds?: readonly string[];
  /** Explicit real execution gates — never auto-filled from process.env. */
  readonly realExecutionGates?: Phase10CampaignRealExecutionGates;
  readonly confirmationPhrase?: string;
}

async function writeManifest(path: string, manifest: Phase10CampaignManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function assertManifestShape(value: unknown): Phase10CampaignManifest {
  if (typeof value !== 'object' || value === null) {
    throw new Error('campaign manifest: invalid JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw new Error('campaign manifest: unsupported schemaVersion');
  }
  if (typeof record.campaignId !== 'string' || record.campaignId.trim() === '') {
    throw new Error('campaign manifest: campaignId required');
  }
  if (!Array.isArray(record.evidence)) {
    throw new Error('campaign manifest: evidence[] required');
  }
  const plannedCount =
    typeof record.plannedCount === 'number'
      ? record.plannedCount
      : typeof record.plannedPayoutCount === 'number'
        ? record.plannedPayoutCount
        : 0;
  const amount =
    record.amountPolicy !== null && typeof record.amountPolicy === 'object'
      ? (record.amountPolicy as Record<string, unknown>)
      : {};
  const normalized: Phase10CampaignManifest = {
    ...(value as Phase10CampaignManifest),
    networkCode: 'TON_TESTNET',
    assetSymbol: 'USDT',
    controlledUserId:
      typeof record.controlledUserId === 'string' ? record.controlledUserId : null,
    plannedCount,
    plannedPayoutCount: plannedCount,
    amountPolicy: {
      grossAtomic: typeof amount.grossAtomic === 'string' ? amount.grossAtomic : null,
      netAtomic: typeof amount.netAtomic === 'string' ? amount.netAtomic : null,
      feeAtomic: typeof amount.feeAtomic === 'string' ? amount.feeAtomic : null,
      note: typeof amount.note === 'string' ? amount.note : null,
    },
    status:
      typeof record.status === 'string'
        ? (record.status as Phase10CampaignManifest['status'])
        : 'INITIALIZED',
    realExecutionGates:
      (record.realExecutionGates as Phase10CampaignRealExecutionGates | null | undefined) ?? null,
    realModeCheckpoint:
      typeof record.realModeCheckpoint === 'string' ? record.realModeCheckpoint : null,
    baselineIsolatedHistoricalAttemptIds: Array.isArray(record.baselineIsolatedHistoricalAttemptIds)
      ? record.baselineIsolatedHistoricalAttemptIds.filter(
          (x): x is string => typeof x === 'string',
        )
      : [],
    withdrawalIds: Array.isArray(record.withdrawalIds)
      ? record.withdrawalIds.filter((x): x is string => typeof x === 'string')
      : [],
    unlocksSigner: false,
  };
  return normalized;
}

/**
 * Initialize a file-based campaign manifest. Does not create withdrawals or flip env.
 * Acceptance campaigns require plannedCount >= 100.
 */
export async function initCampaignManifest(
  path: string,
  input: InitPhase10CampaignManifestInput,
): Promise<Phase10CampaignManifest> {
  const acceptanceCampaign = input.acceptanceCampaign !== false;
  if (acceptanceCampaign && input.plannedCount < PHASE10_CAMPAIGN_MIN_ACCEPTANCE_PAYOUTS) {
    throw new Error(
      `acceptance campaign plannedCount must be >= ${PHASE10_CAMPAIGN_MIN_ACCEPTANCE_PAYOUTS} (got ${input.plannedCount})`,
    );
  }
  if (!Number.isInteger(input.plannedCount) || input.plannedCount < 1) {
    throw new Error(`plannedCount must be a positive integer (got ${input.plannedCount})`);
  }

  const mode: Phase10CampaignMode = input.mode === 'real' ? 'real' : 'dry-run';
  const plan = planPhase10Campaign({
    mode,
    ...(input.gates !== undefined ? { gates: input.gates } : {}),
    ...(input.scenarioIds !== undefined ? { scenarioIds: input.scenarioIds } : {}),
  });
  if (mode === 'real' && !plan.accepted) {
    throw new Error(plan.refusalReason ?? 'real mode refused');
  }

  const campaignId = input.campaignId?.trim() || randomUUID();
  const controlledUserId = input.controlledUserId?.trim() || null;
  const phraseOk = input.confirmationPhrase === PHASE10_REAL_CAMPAIGN_CONFIRMATION_PHRASE;
  const realExecutionGates: Phase10CampaignRealExecutionGates | null =
    mode === 'real'
      ? {
          campaignIdProvided: campaignId.length > 0,
          maxCountProvided: Number.isInteger(input.plannedCount) && input.plannedCount >= 1,
          controlledUserProvided: controlledUserId !== null && controlledUserId.length > 0,
          networkIsTonTestnet: true,
          realChainEnabledTrue: input.realExecutionGates?.realChainEnabledTrue === true,
          fakeChainEnabledFalse: input.realExecutionGates?.fakeChainEnabledFalse === true,
          readinessPass: input.realExecutionGates?.readinessPass === true,
          signerUnlockedExternally: input.realExecutionGates?.signerUnlockedExternally === true,
          confirmationPhraseMatches: phraseOk,
        }
      : null;

  let status: Phase10CampaignManifest['status'] = 'INITIALIZED';
  let realModeCheckpoint: string | null = null;
  if (mode === 'real' && (realExecutionGates === null || !allRealExecutionGatesTrue(realExecutionGates))) {
    status = 'AWAITING_OWNER_APPROVAL';
    realModeCheckpoint = 'OWNER_APPROVAL_REQUIRED';
  }

  const now = new Date().toISOString();
  const manifest: Phase10CampaignManifest = {
    schemaVersion: 1,
    campaignId,
    networkCode: 'TON_TESTNET',
    assetSymbol: 'USDT',
    controlledUserId,
    plannedCount: input.plannedCount,
    plannedPayoutCount: input.plannedCount,
    acceptanceCampaign,
    amountPolicy: {
      grossAtomic: input.amountPolicy?.grossAtomic ?? null,
      netAtomic: input.amountPolicy?.netAtomic ?? null,
      feeAtomic: input.amountPolicy?.feeAtomic ?? null,
      note: input.amountPolicy?.note ?? null,
    },
    mode,
    status,
    createdAt: now,
    updatedAt: now,
    gates: input.gates ?? null,
    realExecutionGates,
    realModeCheckpoint,
    baselineIsolatedHistoricalAttemptIds: [
      ...(input.baselineIsolatedHistoricalAttemptIds ?? []),
    ],
    withdrawalIds: [],
    plan,
    evidence: [],
    createsWithdrawals: false,
    flipsEnv: false,
    mutatesFinancialState: false,
    unlocksSigner: false,
  };
  await writeManifest(path, manifest);
  return manifest;
}

/** Load an existing campaign manifest (resume by path). */
export async function resumeCampaign(path: string): Promise<Phase10CampaignManifest> {
  const raw = await readFile(path, 'utf8');
  return assertManifestShape(JSON.parse(raw) as unknown);
}

export type AttachPhase10CampaignWithdrawalInput = {
  readonly scenarioId: string;
  readonly withdrawalId?: string | null;
  readonly publicId?: string | null;
  readonly withdrawalPublicId?: string | null;
  readonly userId?: string | null;
  readonly quoteId?: string | null;
  readonly grossAmountAtomic?: string | null;
  readonly netAmountAtomic?: string | null;
  readonly feeAmountAtomic?: string | null;
  readonly attemptId?: string | null;
  readonly attemptNumber?: number | null;
  readonly workflowId?: string | null;
  readonly queryId?: string | null;
  readonly hashes?: Partial<Phase10CampaignSafeHashes> | null;
  readonly providerProofIds?: readonly string[] | null;
  readonly primaryProviderProofIdentity?: string | null;
  readonly secondaryProviderProofIdentity?: string | null;
  readonly chainTxId?: string | null;
  readonly recipient?: string | null;
  readonly jettonMaster?: string | null;
  readonly finalState?: string | null;
  readonly state?: string | null;
  readonly broadcastResultState?: string | null;
  readonly ambiguityClass?: string | null;
  readonly settlementLedgerTxId?: string | null;
  readonly invariantResult?: Phase10CampaignEvidenceRecord['invariantResult'];
  readonly duplicateEconomicTransferResult?: Phase10CampaignEvidenceRecord['duplicateEconomicTransferResult'];
  readonly timing?: Partial<Phase10CampaignEvidenceRecord['timing']> | null;
  readonly confirmed?: boolean;
  readonly settled?: boolean;
  readonly notes?: string | null;
  readonly ordinal?: number;
  readonly recordedAt?: string;
};

function emptyHashes(): Phase10CampaignSafeHashes {
  return {
    canonicalMessageHash: null,
    signedMessageHash: null,
    chainReference: null,
    intentHash: null,
  };
}

function emptyTiming(): Phase10CampaignEvidenceRecord['timing'] {
  return {
    requestedAt: null,
    approvedAt: null,
    broadcastedAt: null,
    confirmedAt: null,
    settledAt: null,
  };
}

function normalizeEvidenceRecord(
  campaignId: string,
  ordinal: number,
  input: AttachPhase10CampaignWithdrawalInput,
): Phase10CampaignEvidenceRecord {
  const publicId = input.publicId ?? input.withdrawalPublicId ?? null;
  const finalState = input.finalState ?? input.state ?? null;
  const hashes: Phase10CampaignSafeHashes = {
    ...emptyHashes(),
    ...(input.hashes ?? {}),
  };
  const timing = {
    ...emptyTiming(),
    ...(input.timing ?? {}),
  };
  return {
    campaignId,
    ordinal,
    withdrawalId: input.withdrawalId ?? null,
    publicId,
    withdrawalPublicId: publicId,
    userId: input.userId ?? null,
    quoteId: input.quoteId ?? null,
    grossAmountAtomic: input.grossAmountAtomic ?? null,
    netAmountAtomic: input.netAmountAtomic ?? null,
    feeAmountAtomic: input.feeAmountAtomic ?? null,
    attemptId: input.attemptId ?? null,
    attemptNumber: input.attemptNumber ?? null,
    workflowId: input.workflowId ?? null,
    queryId: input.queryId ?? null,
    hashes,
    providerProofIds: [...(input.providerProofIds ?? [])],
    primaryProviderProofIdentity: input.primaryProviderProofIdentity ?? null,
    secondaryProviderProofIdentity: input.secondaryProviderProofIdentity ?? null,
    chainTxId: input.chainTxId ?? null,
    recipient: input.recipient ?? null,
    jettonMaster: input.jettonMaster ?? null,
    finalState,
    state: finalState,
    broadcastResultState: input.broadcastResultState ?? null,
    ambiguityClass: input.ambiguityClass ?? null,
    settlementLedgerTxId: input.settlementLedgerTxId ?? null,
    invariantResult: input.invariantResult ?? null,
    duplicateEconomicTransferResult: input.duplicateEconomicTransferResult ?? null,
    scenarioId: input.scenarioId,
    timing,
    confirmed: input.confirmed === true || finalState === 'CONFIRMED',
    settled: input.settled === true || (input.settlementLedgerTxId ?? null) !== null,
    notes: input.notes ?? null,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
}

/**
 * Attach a withdrawal evidence record to the campaign file. No DB / financial mutation.
 */
export async function attachWithdrawal(
  path: string,
  record: AttachPhase10CampaignWithdrawalInput | { readonly withdrawalId: string } | string,
): Promise<Phase10CampaignManifest> {
  const manifest = await resumeCampaign(path);
  const partial: AttachPhase10CampaignWithdrawalInput =
    typeof record === 'string'
      ? { scenarioId: 'ATTACHED', withdrawalId: record }
      : 'scenarioId' in record && typeof record.scenarioId === 'string'
        ? record
        : {
            scenarioId: 'ATTACHED',
            withdrawalId: (record as { readonly withdrawalId: string }).withdrawalId,
          };

  const ordinal = partial.ordinal ?? manifest.evidence.length + 1;
  const next = normalizeEvidenceRecord(manifest.campaignId, ordinal, partial);
  const evidence = [...manifest.evidence];
  const existingIdx = evidence.findIndex(
    (e) =>
      (next.withdrawalId !== null && e.withdrawalId === next.withdrawalId) ||
      (e.ordinal === next.ordinal && e.scenarioId === next.scenarioId),
  );
  if (existingIdx >= 0) {
    evidence[existingIdx] = next;
  } else {
    evidence.push(next);
  }
  const updated: Phase10CampaignManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    status: 'WITHDRAWALS_ATTACHED',
    withdrawalIds: [
      ...new Set([
        ...manifest.withdrawalIds,
        ...(next.withdrawalId !== null ? [next.withdrawalId] : []),
      ]),
    ],
    evidence,
  };
  await writeManifest(path, updated);
  return updated;
}

async function withClient<T>(db: Pool | PoolClient, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isPool(db)) return fn(db);
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

function extractProofIdentities(summary: unknown): {
  primary: string | null;
  secondary: string | null;
  chainTxHash: string | null;
} {
  if (summary === null || typeof summary !== 'object') {
    return { primary: null, secondary: null, chainTxHash: null };
  }
  const o = summary as Record<string, unknown>;
  const primary =
    (typeof o.primaryTransactionHash === 'string' && o.primaryTransactionHash) ||
    (typeof o.primaryProofIdentity === 'string' && o.primaryProofIdentity) ||
    null;
  const secondary =
    (typeof o.secondaryTransactionHash === 'string' && o.secondaryTransactionHash) ||
    (typeof o.secondaryProofIdentity === 'string' && o.secondaryProofIdentity) ||
    null;
  const chainTxHash =
    (typeof o.transactionHash === 'string' && o.transactionHash) ||
    (typeof o.hotWalletTxHash === 'string' && o.hotWalletTxHash) ||
    primary;
  return { primary, secondary, chainTxHash };
}

async function loadEvidenceFromDb(
  client: PoolClient,
  campaignId: string,
  ordinal: number,
  scenarioId: string,
  withdrawalId: string,
  options: { readonly requireLiveAcceptanceProof?: boolean } = {},
): Promise<Phase10CampaignEvidenceRecord> {
  const w = await client.query<{
    id: string;
    public_id: string;
    user_id: string;
    withdrawal_quote_id: string;
    requested_amount_atomic: string;
    fee_amount_atomic: string;
    net_amount_atomic: string;
    state: string;
    workflow_id: string | null;
    settlement_ledger_tx_id: string | null;
    requested_at: Date | null;
    approved_at: Date | null;
    broadcasted_at: Date | null;
    confirmed_at: Date | null;
  }>(
    `SELECT id, public_id, user_id, withdrawal_quote_id,
            requested_amount_atomic::text AS requested_amount_atomic,
            fee_amount_atomic::text AS fee_amount_atomic,
            net_amount_atomic::text AS net_amount_atomic,
            state::text AS state, workflow_id, settlement_ledger_tx_id,
            requested_at, approved_at, broadcasted_at, confirmed_at
     FROM withdrawals WHERE id = $1::uuid`,
    [withdrawalId],
  );
  const row = w.rows[0];
  if (row === undefined) {
    return normalizeEvidenceRecord(campaignId, ordinal, {
      scenarioId,
      withdrawalId,
      invariantResult: 'UNKNOWN',
      duplicateEconomicTransferResult: 'UNKNOWN',
      notes: 'withdrawal not found during rescan',
    });
  }

  const attempt = await client.query<{
    id: string;
    attempt_number: number;
    query_id: string;
    canonical_message_hash: string;
    signed_message_hash: string | null;
    chain_reference: string | null;
    broadcast_result_state: string;
    broadcast_ambiguity_class: string | null;
    settled_at: Date | null;
  }>(
    `SELECT id, attempt_number, query_id::text AS query_id,
            canonical_message_hash, signed_message_hash, chain_reference,
            broadcast_result_state::text AS broadcast_result_state,
            broadcast_ambiguity_class, settled_at
     FROM withdrawal_attempts
     WHERE withdrawal_id = $1::uuid
     ORDER BY attempt_number DESC
     LIMIT 1`,
    [withdrawalId],
  );
  const a = attempt.rows[0];

  const wallet = await client.query<{
    friendly_address: string | null;
    raw_address: string | null;
  }>(
    `SELECT uw.friendly_address, uw.raw_address
     FROM withdrawals w
     JOIN user_wallets uw ON uw.id = w.wallet_id
     WHERE w.id = $1::uuid`,
    [withdrawalId],
  );

  const chainTx =
    a === undefined
      ? { rows: [] as Array<{ chain_tx_reference: string; jetton_master_address: string | null }> }
      : await client.query<{
          chain_tx_reference: string;
          jetton_master_address: string | null;
        }>(
          `SELECT chain_tx_reference, jetton_master_address
           FROM blockchain_transactions
           WHERE withdrawal_attempt_id = $1::uuid
           ORDER BY first_seen_at DESC
           LIMIT 1`,
          [a.id],
        );

  const proofs = await client.query<{
    id: string;
    resolution: string;
    evidence_summary: unknown;
    correlation_reference: string | null;
  }>(
    `SELECT id, resolution::text AS resolution, evidence_summary, correlation_reference
     FROM withdrawal_payout_reconciliations
     WHERE withdrawal_id = $1::uuid
     ORDER BY resolved_at DESC NULLS LAST, id DESC
     LIMIT 20`,
    [withdrawalId],
  );

  const intended = proofs.rows.find((p) => p.resolution === 'INTENDED_PAYOUT_PROVEN');
  const identities = extractProofIdentities(intended?.evidence_summary);

  let invariantResult: Phase10CampaignEvidenceRecord['invariantResult'];
  let duplicateEconomicTransferResult: Phase10CampaignEvidenceRecord['duplicateEconomicTransferResult'];
  try {
    const invariants = await checkPhase10PayoutInvariants(client, withdrawalId, {
      requireLiveAcceptanceProof: options.requireLiveAcceptanceProof === true,
    });
    invariantResult = invariants.ok ? 'PASS' : 'FAIL';
    duplicateEconomicTransferResult =
      invariants.duplicateEconomicPayoutCount > 0
        ? `DUPLICATE_COUNT=${invariants.duplicateEconomicPayoutCount}`
        : 'NONE';
  } catch {
    invariantResult = 'UNKNOWN';
    duplicateEconomicTransferResult = 'UNKNOWN';
  }

  const finalState = row.state;
  const intentHash = a?.canonical_message_hash ?? null;
  return normalizeEvidenceRecord(campaignId, ordinal, {
    scenarioId,
    withdrawalId: row.id,
    publicId: row.public_id,
    userId: row.user_id,
    quoteId: row.withdrawal_quote_id,
    grossAmountAtomic: row.requested_amount_atomic,
    netAmountAtomic: row.net_amount_atomic,
    feeAmountAtomic: row.fee_amount_atomic,
    attemptId: a?.id ?? null,
    attemptNumber: a?.attempt_number ?? null,
    workflowId: row.workflow_id,
    queryId: a?.query_id ?? null,
    hashes: {
      canonicalMessageHash: a?.canonical_message_hash ?? null,
      signedMessageHash: a?.signed_message_hash ?? null,
      chainReference: a?.chain_reference ?? null,
      intentHash,
    },
    providerProofIds: proofs.rows.map((p) => p.id),
    primaryProviderProofIdentity: identities.primary,
    secondaryProviderProofIdentity: identities.secondary,
    chainTxId:
      chainTx.rows[0]?.chain_tx_reference ??
      identities.chainTxHash ??
      intended?.correlation_reference ??
      null,
    recipient: wallet.rows[0]?.friendly_address ?? wallet.rows[0]?.raw_address ?? null,
    jettonMaster: chainTx.rows[0]?.jetton_master_address ?? null,
    finalState,
    broadcastResultState: a?.broadcast_result_state ?? null,
    ambiguityClass: a?.broadcast_ambiguity_class ?? null,
    settlementLedgerTxId: row.settlement_ledger_tx_id,
    invariantResult,
    duplicateEconomicTransferResult,
    timing: {
      requestedAt: row.requested_at?.toISOString() ?? null,
      approvedAt: row.approved_at?.toISOString() ?? null,
      broadcastedAt: row.broadcasted_at?.toISOString() ?? null,
      confirmedAt: row.confirmed_at?.toISOString() ?? null,
      settledAt: a?.settled_at?.toISOString() ?? null,
    },
    confirmed: finalState === 'CONFIRMED',
    settled: row.settlement_ledger_tx_id !== null,
    notes: null,
  });
}

/**
 * Refresh attached withdrawal evidence from DB (read-only). Never mutates financial state.
 */
export async function rescanCampaignEvidence(
  path: string,
  db: Pool | PoolClient,
): Promise<Phase10CampaignManifest> {
  const manifest = await resumeCampaign(path);
  const requireLiveAcceptanceProof =
    manifest.acceptanceCampaign === true && manifest.mode === 'real';
  const refreshed = await withClient(db, async (client) => {
    const next: Phase10CampaignEvidenceRecord[] = [];
    for (const record of manifest.evidence) {
      if (record.withdrawalId === null || record.withdrawalId.trim() === '') {
        next.push(record);
        continue;
      }
      next.push(
        await loadEvidenceFromDb(
          client,
          manifest.campaignId,
          record.ordinal,
          record.scenarioId,
          record.withdrawalId,
          { requireLiveAcceptanceProof },
        ),
      );
    }
    return next;
  });

  const updated: Phase10CampaignManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    status: 'EVIDENCE_REFRESHED',
    evidence: refreshed,
  };
  await writeManifest(path, updated);
  return updated;
}

/** Aliases / Owner-requested coordinator surface. */
export async function initializeCampaign(input: {
  readonly campaignDirOrManifestPath: string;
  readonly controlledUserId: string;
  readonly plannedPayoutCount: number;
  readonly amountPolicy?: InitPhase10CampaignManifestInput['amountPolicy'];
  readonly baselineIsolatedHistoricalAttemptIds?: readonly string[];
  readonly mode?: Phase10CampaignMode;
  readonly realExecutionGates?: Phase10CampaignRealExecutionGates;
  readonly confirmationPhrase?: string;
  readonly campaignId?: string;
  readonly acceptanceCampaign?: boolean;
}): Promise<{
  readonly accepted: boolean;
  readonly refusalReason: string | null;
  readonly manifest: Phase10CampaignManifest;
  readonly createsWithdrawals: false;
  readonly flipsEnv: false;
  readonly unlocksSigner: false;
  readonly mutatesFinancialDb: false;
}> {
  const manifest = await initCampaignManifest(input.campaignDirOrManifestPath, {
    plannedCount: input.plannedPayoutCount,
    controlledUserId: input.controlledUserId,
    ...(input.campaignId !== undefined ? { campaignId: input.campaignId } : {}),
    ...(input.amountPolicy !== undefined ? { amountPolicy: input.amountPolicy } : {}),
    ...(input.baselineIsolatedHistoricalAttemptIds !== undefined
      ? { baselineIsolatedHistoricalAttemptIds: input.baselineIsolatedHistoricalAttemptIds }
      : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.realExecutionGates !== undefined
      ? { realExecutionGates: input.realExecutionGates }
      : {}),
    ...(input.confirmationPhrase !== undefined
      ? { confirmationPhrase: input.confirmationPhrase }
      : {}),
    ...(input.acceptanceCampaign !== undefined
      ? { acceptanceCampaign: input.acceptanceCampaign }
      : {}),
  });
  const awaiting = manifest.status === 'AWAITING_OWNER_APPROVAL';
  return {
    accepted: !awaiting,
    refusalReason: awaiting
      ? 'real mode stopped at Owner-approval checkpoint (gates/confirmation phrase not all true)'
      : null,
    manifest,
    createsWithdrawals: false,
    flipsEnv: false,
    unlocksSigner: false,
    mutatesFinancialDb: false,
  };
}

export async function attachWithdrawalIds(
  path: string,
  withdrawalIds: readonly string[],
): Promise<Phase10CampaignManifest> {
  await resumeCampaign(path);
  for (const id of withdrawalIds) {
    if (id.trim() === '') continue;
    await attachWithdrawal(path, id);
  }
  return resumeCampaign(path);
}

export async function refreshEvidence(
  path: string,
  db: Pool | PoolClient,
): Promise<Phase10CampaignManifest> {
  return rescanCampaignEvidence(path, db);
}

export const rescanWithdrawalsFromDb = rescanCampaignEvidence;

export async function writeEvidenceFile(
  path: string,
  evidence: readonly Phase10CampaignEvidenceRecord[],
): Promise<Phase10CampaignManifest> {
  const manifest = await resumeCampaign(path);
  const updated: Phase10CampaignManifest = {
    ...manifest,
    updatedAt: new Date().toISOString(),
    evidence: [...evidence],
    withdrawalIds: [
      ...new Set(
        evidence
          .map((e) => e.withdrawalId)
          .filter((id): id is string => typeof id === 'string' && id.trim() !== ''),
      ),
    ],
  };
  await writeManifest(path, updated);
  return updated;
}

function campaignCompletionSatisfied(manifest: Phase10CampaignManifest): boolean {
  if (manifest.acceptanceCampaign !== true) return false;
  if (manifest.mode !== 'real') return false;
  if (manifest.networkCode !== 'TON_TESTNET') return false;
  if (manifest.assetSymbol !== 'USDT') return false;
  if (manifest.controlledUserId === null || manifest.controlledUserId.trim() === '') return false;
  if (manifest.plannedCount < PHASE10_CAMPAIGN_MIN_ACCEPTANCE_PAYOUTS) return false;

  const distinctWithdrawalIds = [
    ...new Set(
      manifest.withdrawalIds.filter((id) => typeof id === 'string' && id.trim() !== ''),
    ),
  ];
  if (distinctWithdrawalIds.length < PHASE10_CAMPAIGN_MIN_ACCEPTANCE_PAYOUTS) return false;

  const confirmedInCampaign = manifest.evidence.filter(
    (e) =>
      e.campaignId === manifest.campaignId &&
      typeof e.withdrawalId === 'string' &&
      distinctWithdrawalIds.includes(e.withdrawalId) &&
      e.confirmed === true &&
      e.finalState === 'CONFIRMED' &&
      e.invariantResult === 'PASS',
  );
  const confirmedDistinct = new Set(
    confirmedInCampaign
      .map((e) => e.withdrawalId)
      .filter((id): id is string => typeof id === 'string'),
  );
  return confirmedDistinct.size >= PHASE10_CAMPAIGN_MIN_ACCEPTANCE_PAYOUTS;
}

export async function generateFinalCampaignEvidence(
  path: string,
  db: Pool | PoolClient,
): Promise<Phase10CampaignManifest> {
  const refreshed = await rescanCampaignEvidence(path, db);
  const complete = campaignCompletionSatisfied(refreshed);
  const updated: Phase10CampaignManifest = {
    ...refreshed,
    status: complete
      ? 'COMPLETED'
      : refreshed.status === 'COMPLETED'
        ? 'EVIDENCE_REFRESHED'
        : refreshed.status === 'INITIALIZED'
          ? 'INITIALIZED'
          : refreshed.withdrawalIds.length > 0
            ? 'EVIDENCE_REFRESHED'
            : refreshed.status,
    updatedAt: new Date().toISOString(),
  };
  await writeManifest(path, updated);
  return updated;
}

/**
 * Resume by scanning sibling dirs under rootDir for manifest.json with matching campaignId.
 */
export async function resumeCampaignById(
  rootDir: string,
  campaignId: string,
): Promise<{ readonly manifestPath: string; readonly manifest: Phase10CampaignManifest }> {
  const fsPromises = await import('node:fs/promises');
  const pathMod = await import('node:path');
  const needle = campaignId.trim().toLowerCase();
  const entries = await fsPromises.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = pathMod.join(rootDir, entry.name, 'manifest.json');
    try {
      const manifest = await resumeCampaign(candidate);
      if (manifest.campaignId.toLowerCase() === needle) {
        return { manifestPath: candidate, manifest };
      }
    } catch {
      // skip
    }
  }
  // Also allow rootDir itself as a single manifest path.
  try {
    const manifest = await resumeCampaign(rootDir);
    if (manifest.campaignId.toLowerCase() === needle) {
      return { manifestPath: rootDir, manifest };
    }
  } catch {
    // ignore
  }
  throw new Error(`campaignId ${campaignId} not found under ${rootDir}`);
}
