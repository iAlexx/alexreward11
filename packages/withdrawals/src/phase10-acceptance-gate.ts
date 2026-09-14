/**
 * Phase 10 acceptance / archive gate — verifies evidence itself.
 * Does NOT create archives. Does NOT mark Phase 10 closed.
 * Path-only / caller-trusted counts are never sufficient for PASS.
 */
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

import { PHASE10_FAILURE_SCENARIO_CATALOGUE } from './phase10-campaign.js';
import {
  PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
  evaluateChainHistoryForAcceptance,
  readPhase10ChainHistoryEvidence,
  type Phase10ChainHistoryAcceptanceBinding,
} from './phase10-chain-history-evidence.js';
import { checkPhase10PayoutInvariants } from './phase10-payout-invariants.js';

const MIN_CONTROLLED_CONFIRMED = 100;
const MIN_PLANNED_COUNT = 100;

export const PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS: readonly string[] =
  PHASE10_FAILURE_SCENARIO_CATALOGUE.filter(
    (s) => s.classification === 'REQUIRES_REAL_TESTNET',
  ).map((s) => s.id);

/**
 * Legacy path/count presence bag — kept for backward compatibility.
 * Never sufficient for PASS on its own; use evaluatePhase10AcceptanceFromEvidence.
 */
export interface Phase10LiveEvidencePresence {
  readonly campaignEvidencePath: string | null;
  readonly failureInjectionEvidencePath: string | null;
  readonly invariantResultsPath: string | null;
  readonly readinessPassAtLiveWindow: boolean;
  readonly controlledPayoutCountConfirmed: number;
  readonly duplicateEconomicPayouts: number;
}

export type Phase10AcceptanceGateVerdict =
  | 'REFUSED_MISSING_LIVE_EVIDENCE'
  | 'REFUSED_DUPLICATE_ECONOMIC_PAYOUT'
  | 'REFUSED_DUPLICATE_SETTLEMENT'
  | 'REFUSED_INSUFFICIENT_CONFIRMED_COUNT'
  | 'REFUSED_INVARIANT_FAILURE'
  | 'REFUSED_UNRESOLVED_CAMPAIGN'
  | 'REFUSED_CHAIN_PROOF_REQUIRED'
  | 'REFUSED_CAMPAIGN_BINDING'
  | 'PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED';

export interface Phase10AcceptanceGateResult {
  readonly verdict: Phase10AcceptanceGateVerdict;
  readonly mayCreateFinalArchive: boolean;
  readonly mayMarkPhase10Closed: boolean;
  readonly reasons: readonly string[];
  readonly confirmedCount: number;
  readonly duplicateEconomicPayouts: number;
  readonly duplicateSettlements: number;
}

export interface Phase10AcceptanceFromEvidenceInput {
  readonly db: Pool;
  readonly campaignEvidencePath: string;
  readonly failureInjectionEvidencePath: string;
  readonly readinessEvidencePath: string;
  /**
   * Authoritative Hot Wallet outgoing-history evidence path.
   * Required for final acceptance — caller boolean alone is refused.
   */
  readonly chainHistoryEvidencePath?: string | null;
  /** Optional precomputed invariant dump path; still re-verified against DB. */
  readonly invariantResultsPath?: string | null;
}

/** @deprecated Prefer Phase10AcceptanceFromEvidenceInput with evaluatePhase10AcceptanceFromEvidence. */
export type Phase10AcceptanceGateInput = Phase10AcceptanceFromEvidenceInput;

interface CampaignEvidenceFile {
  readonly campaignId?: unknown;
  readonly networkCode?: unknown;
  readonly assetSymbol?: unknown;
  readonly acceptanceCampaign?: unknown;
  readonly mode?: unknown;
  readonly controlledUserId?: unknown;
  readonly plannedCount?: unknown;
  readonly plannedPayoutCount?: unknown;
  readonly createdAt?: unknown;
  /** Canonical attached withdrawals (Phase10CampaignManifest). */
  readonly withdrawalIds?: unknown;
  /** Legacy alias — used only when withdrawalIds is absent/empty. */
  readonly withdrawals?: unknown;
  readonly evidence?: unknown;
  readonly payouts?: ReadonlyArray<{
    readonly withdrawalId?: string;
    readonly id?: string;
    readonly campaignId?: string;
    readonly finalWithdrawalState?: string;
    readonly state?: string;
  }>;
  readonly records?: ReadonlyArray<{
    readonly withdrawalId?: string;
    readonly id?: string;
    readonly campaignId?: string;
    readonly finalWithdrawalState?: string;
    readonly state?: string;
  }>;
  readonly controlledPayouts?: ReadonlyArray<{
    readonly withdrawalId?: string;
    readonly id?: string;
    readonly campaignId?: string;
    readonly finalWithdrawalState?: string;
  }>;
}

interface FailureScenarioRow {
  readonly id?: unknown;
  readonly present?: unknown;
  readonly executed?: unknown;
  readonly ok?: unknown;
  readonly status?: unknown;
  readonly result?: unknown;
  readonly evidence?: unknown;
  readonly unresolved?: unknown;
  readonly classification?: unknown;
  readonly completed?: unknown;
}

function refuse(
  verdict: Phase10AcceptanceGateVerdict,
  reasons: readonly string[],
  extras?: {
    readonly confirmedCount?: number;
    readonly duplicateEconomicPayouts?: number;
    readonly duplicateSettlements?: number;
  },
): Phase10AcceptanceGateResult {
  return {
    verdict,
    mayCreateFinalArchive: false,
    mayMarkPhase10Closed: false,
    reasons: [...reasons],
    confirmedCount: extras?.confirmedCount ?? 0,
    duplicateEconomicPayouts: extras?.duplicateEconomicPayouts ?? 0,
    duplicateSettlements: extras?.duplicateSettlements ?? 0,
  };
}

/**
 * Backward-compatible gate: inspects path/count presence only.
 * Path-only evidence is NEVER sufficient for PASS — always refuses archive.
 * mayMarkPhase10Closed is always false.
 */
export function evaluatePhase10AcceptanceGate(
  evidence: Phase10LiveEvidencePresence,
): Phase10AcceptanceGateResult {
  const reasons: string[] = [];

  if (evidence.campaignEvidencePath === null || evidence.campaignEvidencePath.trim() === '') {
    reasons.push('campaign evidence package path missing');
  }
  if (
    evidence.failureInjectionEvidencePath === null ||
    evidence.failureInjectionEvidencePath.trim() === ''
  ) {
    reasons.push('failure-injection evidence path missing');
  }
  if (evidence.invariantResultsPath === null || evidence.invariantResultsPath.trim() === '') {
    reasons.push('invariant results path missing');
  }
  if (!evidence.readinessPassAtLiveWindow) {
    reasons.push('readiness was not PASS at live authorization window');
  }
  if (evidence.duplicateEconomicPayouts !== 0) {
    return refuse('REFUSED_DUPLICATE_ECONOMIC_PAYOUT', [
      ...reasons,
      `duplicateEconomicPayouts=${evidence.duplicateEconomicPayouts} (must be 0)`,
    ]);
  }
  if (reasons.length > 0) {
    return refuse('REFUSED_MISSING_LIVE_EVIDENCE', reasons);
  }
  if (evidence.controlledPayoutCountConfirmed < MIN_CONTROLLED_CONFIRMED) {
    return refuse('REFUSED_INSUFFICIENT_CONFIRMED_COUNT', [
      `confirmed=${evidence.controlledPayoutCountConfirmed} (need >= ${MIN_CONTROLLED_CONFIRMED})`,
    ]);
  }

  // Paths + caller-trusted counts alone are insufficient for PASS.
  return refuse('REFUSED_MISSING_LIVE_EVIDENCE', [
    'path-only / caller-trusted evidence is insufficient for PASS; use evaluatePhase10AcceptanceFromEvidence with readable evidence files and DB invariant verification',
  ]);
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Canonical attached withdrawal IDs.
 * Prefer `withdrawalIds` (Phase10CampaignManifest). Do not merge with legacy aliases —
 * merging would create false duplicate detections when both fields list the same IDs.
 */
function extractWithdrawalIds(file: CampaignEvidenceFile): string[] {
  if (Array.isArray(file.withdrawalIds) && file.withdrawalIds.length > 0) {
    return file.withdrawalIds.filter(
      (id): id is string => typeof id === 'string' && id.trim() !== '',
    );
  }

  // Legacy path only when canonical withdrawalIds is absent/empty.
  const ids: string[] = [];
  if (Array.isArray(file.withdrawals)) {
    for (const row of file.withdrawals) {
      if (typeof row === 'string' && row.trim() !== '') {
        ids.push(row);
        continue;
      }
      if (typeof row === 'object' && row !== null) {
        const rec = row as { id?: unknown; withdrawalId?: unknown };
        const id =
          (typeof rec.id === 'string' && rec.id.trim() !== '' ? rec.id : null) ??
          (typeof rec.withdrawalId === 'string' && rec.withdrawalId.trim() !== ''
            ? rec.withdrawalId
            : null);
        if (id !== null) ids.push(id);
      }
    }
  }

  const pools = [file.payouts, file.records, file.controlledPayouts];
  for (const pool of pools) {
    if (pool === undefined) continue;
    for (const row of pool) {
      const id =
        (typeof row.withdrawalId === 'string' && row.withdrawalId.trim() !== ''
          ? row.withdrawalId
          : null) ?? (typeof row.id === 'string' && row.id.trim() !== '' ? row.id : null);
      if (id !== null) ids.push(id);
    }
  }

  return ids;
}

/**
 * Derive authoritative Hot Wallet / Jetton master / expected payout identities
 * from campaign withdrawal rows in DB. Never trusts chain-history artifact fields.
 */
async function loadAuthoritativeCampaignChainHistoryBinding(
  db: Pool,
  withdrawalIds: readonly string[],
  campaignCreatedAt: Date,
): Promise<{
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly binding: Phase10ChainHistoryAcceptanceBinding | null;
}> {
  const reasons: string[] = [];
  if (withdrawalIds.length === 0) {
    return {
      ok: false,
      reasons: ['no campaign withdrawals for chain-history binding'],
      binding: null,
    };
  }

  const rows = await db.query<{
    withdrawal_id: string;
    hot_wallet_id: string;
    hot_wallet_address: string;
    payout_jetton_wallet_address: string | null;
    jetton_master: string | null;
    network_code: string;
    asset_symbol: string;
  }>(
    `SELECT w.id::text AS withdrawal_id,
            hw.id::text AS hot_wallet_id,
            hw.address AS hot_wallet_address,
            hw.payout_jetton_wallet_address,
            a.contract_identity AS jetton_master,
            n.code AS network_code,
            a.symbol AS asset_symbol
     FROM withdrawals w
     JOIN hot_wallets hw ON hw.id = w.hot_wallet_id
     JOIN networks n ON n.id = w.network_id
     JOIN assets a ON a.id = w.asset_id
     WHERE w.id = ANY($1::uuid[])`,
    [withdrawalIds],
  );

  if (rows.rows.length !== withdrawalIds.length) {
    reasons.push('one or more campaign withdrawals missing from DB for chain-history binding');
  }

  const hotIds = new Set(rows.rows.map((r) => r.hot_wallet_id));
  const hotAddresses = new Set(rows.rows.map((r) => r.hot_wallet_address.trim().toLowerCase()));
  const jettonWallets = new Set(
    rows.rows.map((r) => (r.payout_jetton_wallet_address ?? '').trim().toLowerCase()),
  );
  const masters = new Set(
    rows.rows.map((r) => (r.jetton_master ?? '').trim().toLowerCase()).filter((m) => m !== ''),
  );
  const networks = new Set(rows.rows.map((r) => r.network_code));
  const assets = new Set(rows.rows.map((r) => r.asset_symbol));

  if (hotIds.size !== 1 || hotAddresses.size !== 1) {
    reasons.push('campaign withdrawals do not agree on a single authoritative Hot Wallet');
  }
  if (jettonWallets.size !== 1) {
    reasons.push(
      'campaign withdrawals do not agree on a single authoritative Hot Wallet Jetton wallet',
    );
  }
  if (masters.size !== 1) {
    reasons.push('campaign withdrawals do not agree on a single authoritative Jetton master');
  }
  if (![...networks].every((n) => n === 'TON_TESTNET') || networks.size !== 1) {
    reasons.push('campaign withdrawals must all be TON_TESTNET for chain-history binding');
  }
  if (![...assets].every((a) => a === 'USDT') || assets.size !== 1) {
    reasons.push('campaign withdrawals must all be USDT for chain-history binding');
  }

  const first = rows.rows[0];
  if (first === undefined) {
    return {
      ok: false,
      reasons: reasons.length > 0 ? reasons : ['no DB rows for chain-history binding'],
      binding: null,
    };
  }
  if (
    first.payout_jetton_wallet_address === null ||
    first.payout_jetton_wallet_address.trim() === ''
  ) {
    reasons.push('authoritative Hot Wallet missing payout Jetton wallet address');
  }
  if (first.jetton_master === null || first.jetton_master.trim() === '') {
    reasons.push('authoritative asset missing Jetton master / contract identity');
  }

  const proofs = await db.query<{
    observed_query_id: string | null;
    correlation_reference: string | null;
  }>(
    `SELECT observed_query_id::text AS observed_query_id, correlation_reference
     FROM withdrawal_payout_reconciliations
     WHERE withdrawal_id = ANY($1::uuid[])
       AND resolution = 'INTENDED_PAYOUT_PROVEN'`,
    [withdrawalIds],
  );
  const expectedCampaignPayoutIdentities = [
    ...new Set(
      proofs.rows.flatMap((p) =>
        [p.observed_query_id, p.correlation_reference].filter(
          (id): id is string => typeof id === 'string' && id.trim() !== '',
        ),
      ),
    ),
  ];

  if (reasons.length > 0) {
    return { ok: false, reasons, binding: null };
  }

  return {
    ok: true,
    reasons: [],
    binding: {
      hotWalletAddress: first.hot_wallet_address,
      hotWalletJettonWallet: first.payout_jetton_wallet_address,
      jettonMaster: first.jetton_master!,
      networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      campaignWindowStart: campaignCreatedAt.toISOString(),
      expectedCampaignPayoutIdentities,
    },
  };
}

function parseCampaignCreatedAt(value: unknown): Date | null {
  const raw = readNonEmptyString(value);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function validateCampaignStructure(file: CampaignEvidenceFile): string[] {
  const errors: string[] = [];
  const campaignId = readNonEmptyString(file.campaignId);
  if (campaignId === null) {
    errors.push('campaign evidence missing campaignId');
  }
  if (file.networkCode !== 'TON_TESTNET') {
    errors.push('campaign evidence networkCode must be TON_TESTNET');
  }
  if (file.assetSymbol !== 'USDT') {
    errors.push('campaign evidence assetSymbol must be USDT');
  }
  if (file.acceptanceCampaign !== true) {
    errors.push('campaign evidence acceptanceCampaign must be true');
  }
  if (file.mode !== 'real') {
    errors.push('campaign evidence mode must be real');
  }
  const controlledUserId = readNonEmptyString(file.controlledUserId);
  if (controlledUserId === null) {
    errors.push('campaign evidence missing non-null controlledUserId');
  }
  if (parseCampaignCreatedAt(file.createdAt) === null) {
    errors.push('campaign evidence missing valid createdAt');
  }
  const planned =
    typeof file.plannedCount === 'number'
      ? file.plannedCount
      : typeof file.plannedPayoutCount === 'number'
        ? file.plannedPayoutCount
        : null;
  if (planned === null || !Number.isFinite(planned)) {
    errors.push('campaign evidence missing numeric plannedCount');
  } else if (planned < MIN_PLANNED_COUNT) {
    errors.push(`campaign plannedCount=${planned} (need >= ${MIN_PLANNED_COUNT})`);
  }
  if (!Array.isArray(file.withdrawalIds) || file.withdrawalIds.length === 0) {
    const hasLegacyWithdrawals = Array.isArray(file.withdrawals) && file.withdrawals.length > 0;
    if (!hasLegacyWithdrawals) {
      errors.push(
        'campaign evidence missing non-empty withdrawalIds (canonical Phase10CampaignManifest field)',
      );
    }
  }

  const listedIds = extractWithdrawalIds(file);
  if (listedIds.length === 0) {
    errors.push('campaign evidence contains no withdrawal ids');
  } else if (listedIds.length !== new Set(listedIds).size) {
    errors.push('campaign evidence contains duplicate withdrawal IDs');
  }

  return errors;
}

/**
 * Evidence-record binding for every attached/counted withdrawal.
 * Requires campaignId, unique positive ordinal, and exact withdrawalId match.
 */
function validateCampaignEvidenceRecords(
  file: CampaignEvidenceFile,
  campaignId: string,
  distinctWithdrawalIds: readonly string[],
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(file.evidence)) {
    errors.push('campaign evidence missing evidence array for counted withdrawals');
    return errors;
  }

  const byWithdrawalId = new Map<string, Record<string, unknown>>();
  const seenOrdinals = new Set<number>();
  const seenWithdrawalInEvidence = new Set<string>();

  for (const row of file.evidence) {
    const rec = asRecord(row);
    if (rec === null) {
      errors.push('campaign evidence contains non-object evidence record');
      continue;
    }
    const rowCampaign = readNonEmptyString(rec.campaignId);
    if (rowCampaign === null) {
      errors.push('evidence record missing campaignId');
      continue;
    }
    if (rowCampaign !== campaignId) {
      errors.push(`evidence record campaignId mismatch: ${rowCampaign}`);
      continue;
    }
    const withdrawalId = readNonEmptyString(rec.withdrawalId) ?? readNonEmptyString(rec.id);
    if (withdrawalId === null) {
      errors.push('evidence record missing withdrawalId');
      continue;
    }
    if (seenWithdrawalInEvidence.has(withdrawalId)) {
      errors.push(`withdrawal ${withdrawalId} appears in multiple evidence records / ordinals`);
      continue;
    }
    seenWithdrawalInEvidence.add(withdrawalId);

    const ordinalRaw = rec.ordinal;
    const ordinal =
      typeof ordinalRaw === 'number'
        ? ordinalRaw
        : typeof ordinalRaw === 'string' &&
            ordinalRaw.trim() !== '' &&
            Number.isFinite(Number(ordinalRaw))
          ? Number(ordinalRaw)
          : null;
    if (ordinal === null || !Number.isInteger(ordinal) || ordinal < 1) {
      errors.push(`evidence record for ${withdrawalId} missing unique positive ordinal`);
      continue;
    }
    if (seenOrdinals.has(ordinal)) {
      errors.push(`duplicate evidence ordinal: ${ordinal}`);
      continue;
    }
    seenOrdinals.add(ordinal);
    byWithdrawalId.set(withdrawalId, rec);
  }

  for (const withdrawalId of distinctWithdrawalIds) {
    const rec = byWithdrawalId.get(withdrawalId);
    if (rec === undefined) {
      errors.push(`counted withdrawal missing evidence record: ${withdrawalId}`);
      continue;
    }
    const recWithdrawalId = readNonEmptyString(rec.withdrawalId) ?? readNonEmptyString(rec.id);
    if (recWithdrawalId !== withdrawalId) {
      errors.push(`evidence record withdrawalId mismatch for ${withdrawalId}`);
    }
    const rowCampaign = readNonEmptyString(rec.campaignId);
    if (rowCampaign !== campaignId) {
      errors.push(`evidence record campaignId mismatch for ${withdrawalId}`);
    }
  }

  return errors;
}

function readNested(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return asRecord(record[key]);
}

export interface ParsedLiveReadinessEvidence {
  readonly controlledUserId: string;
  readonly networkCode: 'TON_TESTNET';
  readonly assetSymbol: 'USDT';
  readonly verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET';
  readonly recordedAt: string;
  readonly primaryEndpointFingerprint: string | null;
  readonly secondaryEndpointFingerprint: string | null;
  readonly primaryNetworkGlobalId: number;
  readonly secondaryNetworkGlobalId: number;
}

const PHASE10_LIVE_PREFLIGHT_SCHEMA_VERSION = 1;

/**
 * Parse + validate live preflight evidence.
 * Final acceptance requires the canonical Phase 10 live-preflight artifact.
 * Hand-authored loose readiness flags alone NEVER satisfy PASS.
 * Legacy nested preflight/readiness fields may remain for display only.
 */
export function parseLiveReadinessEvidence(raw: unknown): {
  readonly errors: readonly string[];
  readonly parsed: ParsedLiveReadinessEvidence | null;
} {
  const errors: string[] = [];
  const root = asRecord(raw);
  if (root === null) {
    return { errors: ['readiness evidence is not a JSON object'], parsed: null };
  }

  const preflight = readNested(root, 'preflight');
  const readiness = readNested(root, 'readiness');

  // Canonical artifact markers — loose flags without these never PASS acceptance.
  if (root.schemaVersion !== PHASE10_LIVE_PREFLIGHT_SCHEMA_VERSION) {
    errors.push(
      'canonical live-preflight schemaVersion must be exactly 1 (hand-authored loose readiness flags are refused)',
    );
  }

  if (root.liveAuthorizationWindow !== true) {
    errors.push('liveAuthorizationWindow must be true');
  }

  if (root.verdict !== 'READY_FOR_CONTROLLED_LIVE_TESTNET') {
    errors.push(
      'preflight verdict must be READY_FOR_CONTROLLED_LIVE_TESTNET (ok/status/verdict=PASS alone is insufficient)',
    );
  }

  if (root.realChainEnabled !== true) {
    errors.push('realChainEnabled must be true in live readiness evidence');
  }

  if (root.fakeChainEnabled !== false) {
    errors.push('fakeChainEnabled must be explicitly false in live readiness evidence');
  }

  const networkCode = readNonEmptyString(root.networkCode);
  if (networkCode !== 'TON_TESTNET') {
    errors.push('networkCode must be TON_TESTNET');
  }

  const assetSymbol = readNonEmptyString(root.assetSymbol);
  if (assetSymbol !== 'USDT') {
    errors.push('assetSymbol must be USDT');
  }

  const controlledUserId = readNonEmptyString(root.controlledUserId);
  if (controlledUserId === null) {
    errors.push('controlledUserId missing in live readiness evidence');
  }

  const recordedAt = readNonEmptyString(root.recordedAt);
  if (recordedAt === null) {
    errors.push('recordedAt missing in live readiness evidence');
  }

  if (!Array.isArray(root.preflightBlockers)) {
    errors.push('canonical live-preflight preflightBlockers array required');
  } else if (root.preflightBlockers.length !== 0) {
    errors.push('preflightBlockers.length must be 0 for acceptance');
  }

  const restore = asRecord(root.restoreScanSummary);
  if (restore === null) {
    errors.push('canonical live-preflight restoreScanSummary required');
  } else if (restore.dangerousCount !== 0) {
    errors.push('restoreScanSummary.dangerousCount must be 0');
  }

  const providers = asRecord(root.providers);
  const primary = providers !== null ? asRecord(providers.primary) : null;
  const secondary = providers !== null ? asRecord(providers.secondary) : null;
  if (providers === null || primary === null || secondary === null) {
    errors.push('canonical live-preflight providers.primary/secondary required');
  } else {
    if (providers.independenceProven !== true) {
      errors.push('provider independence must be proven');
    }
    if (primary.healthy !== true) {
      errors.push('primary provider must be healthy');
    }
    if (secondary.healthy !== true) {
      errors.push('secondary provider must be healthy');
    }
    if (primary.observedNetworkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID) {
      errors.push('primary observedNetworkGlobalId must be -3 (TON Testnet)');
    }
    if (secondary.observedNetworkGlobalId !== PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID) {
      errors.push('secondary observedNetworkGlobalId must be -3 (TON Testnet)');
    }
  }

  const externalProbes = asRecord(root.externalProbes);
  if (externalProbes === null) {
    errors.push('canonical live-preflight externalProbes required');
  } else {
    const signer = asRecord(externalProbes.signer);
    if (signer === null) {
      errors.push('externalProbes.signer required');
    } else {
      if (signer.probePerformed !== true) {
        errors.push('Signer probePerformed must be true');
      }
      if (signer.identityProbed !== true) {
        errors.push('Signer identityProbed must be true');
      }
      if (readNonEmptyString(signer.custodyState) !== 'UNLOCKED') {
        errors.push('Signer custodyState must be exactly UNLOCKED (local_ephemeral/n/a refused)');
      }
      if (signer.signingReady !== true) {
        errors.push('Signer signingReady must be true');
      }
      if (signer.identityMatchesExpected !== true) {
        errors.push('Signer identity must match authoritative expected fingerprint');
      }
      if (signer.walletAddressMatchesExpected !== true) {
        errors.push('Signer wallet address must match authoritative Hot Wallet');
      }
    }
  }

  // Legacy nested flags may exist for display; they must never salvage a non-canonical artifact.
  const legacyOnlyMasquerade =
    errors.length > 0 &&
    (root.signerProbed === true ||
      root.signerUnlocked === true ||
      preflight?.signerProbed === true ||
      preflight?.signerUnlocked === true ||
      readiness?.signerProbed === true ||
      readiness?.signerUnlocked === true ||
      root.ok === true ||
      root.status === 'PASS' ||
      root.verdict === 'PASS' ||
      (root.liveAuthorizationWindow === true &&
        root.verdict === 'READY_FOR_CONTROLLED_LIVE_TESTNET' &&
        root.schemaVersion !== PHASE10_LIVE_PREFLIGHT_SCHEMA_VERSION));
  if (legacyOnlyMasquerade) {
    errors.push(
      'hand-authored loose readiness flags cannot satisfy PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED',
    );
  }

  if (
    errors.length > 0 ||
    controlledUserId === null ||
    recordedAt === null ||
    networkCode !== 'TON_TESTNET' ||
    assetSymbol !== 'USDT' ||
    root.verdict !== 'READY_FOR_CONTROLLED_LIVE_TESTNET' ||
    primary === null ||
    secondary === null
  ) {
    return { errors, parsed: null };
  }

  return {
    errors,
    parsed: {
      controlledUserId,
      networkCode: 'TON_TESTNET',
      assetSymbol: 'USDT',
      verdict: 'READY_FOR_CONTROLLED_LIVE_TESTNET',
      recordedAt,
      primaryEndpointFingerprint: readNonEmptyString(primary.endpointFingerprint),
      secondaryEndpointFingerprint: readNonEmptyString(secondary.endpointFingerprint),
      primaryNetworkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
      secondaryNetworkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
    },
  };
}

/**
 * Fail-closed live preflight evidence. Generic ok/status/verdict=PASS alone is refused.
 */
export function validateLiveReadinessEvidence(raw: unknown): readonly string[] {
  return parseLiveReadinessEvidence(raw).errors;
}

function scenarioExecutedPresent(row: FailureScenarioRow): boolean {
  return row.present === true || row.executed === true || row.completed === true;
}

function scenarioHasEvidence(row: FailureScenarioRow): boolean {
  // status alone is never evidence — require result or evidence payload.
  if (row.result !== undefined && row.result !== null) return true;
  if (row.evidence !== undefined && row.evidence !== null) return true;
  return false;
}

function scenarioUnresolvedOrFailed(row: FailureScenarioRow): boolean {
  if (row.unresolved === true) return true;
  if (row.ok === false) return true;
  const status = (readNonEmptyString(row.status) ?? '').toUpperCase();
  return (
    status === 'FAILED' ||
    status === 'UNRESOLVED' ||
    status === 'ERROR' ||
    status === 'INCOMPLETE' ||
    status === 'BLOCKED'
  );
}

/**
 * Enforce required REAL Testnet failure scenarios. present/ok alone at file root is refused.
 * PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS is always the authoritative minimum set.
 * Evidence may list a superset via requiredScenarioIds, but may never omit any authoritative ID.
 */
export function validateFailureInjectionEvidence(raw: unknown): readonly string[] {
  const errors: string[] = [];
  const root = asRecord(raw);
  if (root === null) {
    return ['failure-injection evidence is not a JSON object'];
  }

  const scenarios = Array.isArray(root.scenarios) ? (root.scenarios as FailureScenarioRow[]) : null;
  if (scenarios === null) {
    errors.push('failure-injection evidence missing scenarios array');
  }

  // Root-level present/ok alone is never sufficient.
  if (scenarios === null && (root.present === true || root.ok === true)) {
    errors.push('present:true / ok:true alone cannot satisfy failure-injection acceptance');
  }
  if (scenarios !== null && scenarios.length === 0 && (root.present === true || root.ok === true)) {
    errors.push('present:true / ok:true alone cannot satisfy failure-injection acceptance');
  }

  const authoritativeIds = [...PHASE10_REQUIRED_REAL_FAILURE_SCENARIO_IDS];
  if (authoritativeIds.length === 0) {
    errors.push('no required REAL Testnet failure scenario ids configured');
  }

  if (Array.isArray(root.requiredScenarioIds) && root.requiredScenarioIds.length > 0) {
    const declared = root.requiredScenarioIds.filter(
      (id): id is string => typeof id === 'string' && id.trim() !== '',
    );
    const declaredSet = new Set(declared);
    for (const requiredId of authoritativeIds) {
      if (!declaredSet.has(requiredId)) {
        errors.push(
          `requiredScenarioIds omits authoritative REAL scenario ${requiredId} (cannot reduce authoritative set)`,
        );
      }
    }
  }

  const byId = new Map<string, FailureScenarioRow>();
  if (scenarios !== null) {
    for (const row of scenarios) {
      const id = readNonEmptyString(row.id);
      if (id !== null) byId.set(id, row);
    }
  }

  // Always iterate the authoritative IDs regardless of caller/file content.
  for (const requiredId of authoritativeIds) {
    const row = byId.get(requiredId);
    if (row === undefined) {
      errors.push(`required failure scenario missing: ${requiredId}`);
      continue;
    }
    const classification = readNonEmptyString(row.classification);
    if (classification !== 'REQUIRES_REAL_TESTNET') {
      errors.push(
        classification === null
          ? `required REAL Testnet scenario ${requiredId} missing classification REQUIRES_REAL_TESTNET`
          : `required REAL Testnet scenario ${requiredId} classification must be REQUIRES_REAL_TESTNET (got ${classification})`,
      );
    }
    if (!scenarioExecutedPresent(row)) {
      errors.push(`required failure scenario not executed/present: ${requiredId}`);
    }
    if (!scenarioHasEvidence(row)) {
      errors.push(`required failure scenario missing evidence/result: ${requiredId}`);
    }
    if (scenarioUnresolvedOrFailed(row)) {
      errors.push(
        `required failure scenario unresolved/failed cannot masquerade as completed proof: ${requiredId}`,
      );
    }
  }

  return errors;
}

/**
 * Authoritative acceptance entrypoint — reads evidence files from disk and
 * re-verifies every listed withdrawal against DB payout invariants.
 * Never sets mayMarkPhase10Closed=true.
 * mayCreateFinalArchive only when all checks pass and confirmed-with-chain-proof >= 100.
 */
export async function evaluatePhase10AcceptanceFromEvidence(
  input: Phase10AcceptanceFromEvidenceInput,
): Promise<Phase10AcceptanceGateResult> {
  const reasons: string[] = [];

  let campaign: CampaignEvidenceFile;
  try {
    const parsed = await readJsonFile(input.campaignEvidencePath);
    const campaignObject = asRecord(parsed);
    if (campaignObject === null) {
      return refuse('REFUSED_MISSING_LIVE_EVIDENCE', ['campaign evidence is not a JSON object']);
    }
    campaign = campaignObject;
  } catch (error) {
    return refuse('REFUSED_MISSING_LIVE_EVIDENCE', [
      `campaign evidence missing or unreadable: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const structureErrors = validateCampaignStructure(campaign);
  if (structureErrors.length > 0) {
    return refuse('REFUSED_CAMPAIGN_BINDING', structureErrors);
  }

  let failureRaw: unknown;
  try {
    failureRaw = await readJsonFile(input.failureInjectionEvidencePath);
  } catch (error) {
    return refuse('REFUSED_MISSING_LIVE_EVIDENCE', [
      `failure-injection evidence missing or unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
  const failureErrors = validateFailureInjectionEvidence(failureRaw);
  if (failureErrors.length > 0) {
    reasons.push(...failureErrors);
  }

  let readinessRaw: unknown;
  try {
    readinessRaw = await readJsonFile(input.readinessEvidencePath);
  } catch (error) {
    return refuse('REFUSED_MISSING_LIVE_EVIDENCE', [
      `readiness/preflight evidence missing or unreadable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ]);
  }
  const readinessParsed = parseLiveReadinessEvidence(readinessRaw);
  if (readinessParsed.errors.length > 0) {
    reasons.push(...readinessParsed.errors);
  }

  const controlledUserId = readNonEmptyString(campaign.controlledUserId)!;
  const campaignId = readNonEmptyString(campaign.campaignId)!;
  const campaignCreatedAt = parseCampaignCreatedAt(campaign.createdAt)!;
  const campaignNetwork = campaign.networkCode;
  const campaignAsset = campaign.assetSymbol;

  // Bind readiness identity/network/asset to campaign (even though each was validated alone).
  if (readinessParsed.parsed !== null) {
    if (readinessParsed.parsed.controlledUserId !== controlledUserId) {
      return refuse('REFUSED_CAMPAIGN_BINDING', [
        ...reasons,
        'readiness controlledUserId does not match campaign controlledUserId',
      ]);
    }
    if (
      readinessParsed.parsed.networkCode !== campaignNetwork ||
      campaignNetwork !== 'TON_TESTNET' ||
      readinessParsed.parsed.networkCode !== 'TON_TESTNET'
    ) {
      return refuse('REFUSED_CAMPAIGN_BINDING', [
        ...reasons,
        'readiness networkCode / campaign networkCode must both be TON_TESTNET',
      ]);
    }
    if (
      readinessParsed.parsed.assetSymbol !== campaignAsset ||
      campaignAsset !== 'USDT' ||
      readinessParsed.parsed.assetSymbol !== 'USDT'
    ) {
      return refuse('REFUSED_CAMPAIGN_BINDING', [
        ...reasons,
        'readiness assetSymbol / campaign assetSymbol must both be USDT',
      ]);
    }
  }

  const listedIds = extractWithdrawalIds(campaign);
  if (listedIds.length === 0) {
    return refuse('REFUSED_MISSING_LIVE_EVIDENCE', [
      ...reasons,
      'campaign evidence contains no withdrawal ids',
    ]);
  }
  if (listedIds.length !== new Set(listedIds).size) {
    return refuse('REFUSED_CAMPAIGN_BINDING', [
      ...reasons,
      'campaign evidence contains duplicate withdrawal IDs',
    ]);
  }

  // Distinct IDs for defensive internal iteration (duplicates already refused above).
  const distinctIds = [...new Set(listedIds)];

  // Authoritative Hot Wallet / Jetton / payout identities from DB — never from artifact self-fields.
  const dbBinding = await loadAuthoritativeCampaignChainHistoryBinding(
    input.db,
    distinctIds,
    campaignCreatedAt,
  );
  if (!dbBinding.ok || dbBinding.binding === null) {
    return refuse('REFUSED_CAMPAIGN_BINDING', [...reasons, ...dbBinding.reasons]);
  }

  // Authoritative Hot Wallet outgoing-history evidence (never caller boolean / self-binding).
  let chainHistoryUnexpected = 0;
  let chainHistoryFail = false;
  const chainHistoryPath = input.chainHistoryEvidencePath?.trim() || null;
  if (chainHistoryPath === null) {
    chainHistoryFail = true;
    reasons.push(
      'chain-history evidence path missing (authoritative Hot Wallet outgoing proof required)',
    );
  } else {
    const chainHistory = await readPhase10ChainHistoryEvidence(chainHistoryPath);
    if (chainHistory.parsed === null) {
      chainHistoryFail = true;
      reasons.push(...chainHistory.errors);
    } else {
      const binding: Phase10ChainHistoryAcceptanceBinding = {
        hotWalletAddress: dbBinding.binding.hotWalletAddress,
        hotWalletJettonWallet: dbBinding.binding.hotWalletJettonWallet ?? null,
        jettonMaster: dbBinding.binding.jettonMaster,
        networkGlobalId: PHASE10_TON_TESTNET_NETWORK_GLOBAL_ID,
        campaignWindowStart: campaignCreatedAt.toISOString(),
        campaignWindowEnd: new Date().toISOString(),
        primaryEndpointFingerprint: readinessParsed.parsed?.primaryEndpointFingerprint ?? null,
        secondaryEndpointFingerprint: readinessParsed.parsed?.secondaryEndpointFingerprint ?? null,
        expectedCampaignPayoutIdentities: dbBinding.binding.expectedCampaignPayoutIdentities ?? [],
      };
      const evaluated = evaluateChainHistoryForAcceptance(chainHistory.parsed, binding);
      if (!evaluated.ok) {
        chainHistoryFail = true;
        chainHistoryUnexpected = evaluated.unexpectedOutgoingCount;
        reasons.push(...evaluated.reasons);
      }
    }
  }

  const evidenceBindingErrors = validateCampaignEvidenceRecords(campaign, campaignId, distinctIds);
  if (evidenceBindingErrors.length > 0) {
    return refuse('REFUSED_CAMPAIGN_BINDING', [...reasons, ...evidenceBindingErrors]);
  }

  let confirmedCount = 0;
  let duplicateEconomic = 0;
  let duplicateSettlement = 0;
  let unresolved = false;
  let invariantFail = false;
  let chainProofFail = false;
  let campaignBindingFail = false;

  for (const withdrawalId of distinctIds) {
    const binding = await input.db.query<{
      user_id: string;
      state: string;
      network_code: string;
      asset_symbol: string;
      requested_at: Date;
      created_at: Date;
    }>(
      `SELECT w.user_id::text AS user_id,
              w.state::text AS state,
              n.code AS network_code,
              a.symbol AS asset_symbol,
              w.requested_at,
              w.created_at
       FROM withdrawals w
       JOIN networks n ON n.id = w.network_id
       JOIN assets a ON a.id = w.asset_id
       WHERE w.id = $1::uuid`,
      [withdrawalId],
    );
    const bound = binding.rows[0];
    if (bound === undefined) {
      campaignBindingFail = true;
      reasons.push(`campaign withdrawal not found in DB: ${withdrawalId}`);
      continue;
    }
    if (bound.user_id !== controlledUserId) {
      campaignBindingFail = true;
      reasons.push(
        `campaign withdrawal ${withdrawalId} user_id mismatch (expected controlledUserId)`,
      );
      continue;
    }
    if (bound.network_code !== 'TON_TESTNET') {
      campaignBindingFail = true;
      reasons.push(`campaign withdrawal ${withdrawalId} network is not TON_TESTNET`);
      continue;
    }
    if (bound.asset_symbol !== 'USDT') {
      campaignBindingFail = true;
      reasons.push(`campaign withdrawal ${withdrawalId} asset is not USDT`);
      continue;
    }

    // Authoritative economic timing: requested_at (NOT evidence recordedAt).
    const requestedAt = bound.requested_at;
    if (!(requestedAt instanceof Date) || Number.isNaN(requestedAt.getTime())) {
      campaignBindingFail = true;
      reasons.push(`campaign withdrawal ${withdrawalId} missing authoritative requested_at`);
      continue;
    }
    if (requestedAt.getTime() < campaignCreatedAt.getTime()) {
      campaignBindingFail = true;
      reasons.push(
        `campaign withdrawal ${withdrawalId} requested_at is before campaign.createdAt (historical/non-campaign)`,
      );
      continue;
    }

    const report = await checkPhase10PayoutInvariants(input.db, withdrawalId, {
      requireLiveAcceptanceProof: true,
    });
    if (!report.ok) {
      invariantFail = true;
      if (report.findings.some((f) => f.code === 'CHAIN_PROOF_REQUIRED' && f.severity === 'FAIL')) {
        chainProofFail = true;
      }
      reasons.push(`invariant FAIL for ${withdrawalId}`);
    }
    duplicateEconomic += report.duplicateEconomicPayoutCount;
    duplicateSettlement += report.duplicateSettlementCount;

    if (report.state === 'UNKNOWN' || report.state === 'RECONCILE_REQUIRED') {
      unresolved = true;
      reasons.push(`unresolved campaign state ${report.state} for ${withdrawalId}`);
    }

    const hasChainProofPass = report.findings.some(
      (f) => f.code === 'CHAIN_PROOF' && f.severity === 'PASS',
    );
    // Only controlled-campaign withdrawals that are CONFIRMED with live chain proof count.
    if (
      report.state === 'CONFIRMED' &&
      bound.state === 'CONFIRMED' &&
      report.ok &&
      hasChainProofPass
    ) {
      confirmedCount += 1;
    }
  }

  if (input.invariantResultsPath != null && input.invariantResultsPath.trim() !== '') {
    try {
      await readJsonFile(input.invariantResultsPath);
    } catch {
      reasons.push('invariant results path present but unreadable');
    }
  }

  if (campaignBindingFail) {
    return refuse('REFUSED_CAMPAIGN_BINDING', reasons, {
      confirmedCount,
      duplicateEconomicPayouts: duplicateEconomic,
      duplicateSettlements: duplicateSettlement,
    });
  }
  if (duplicateEconomic > 0 || chainHistoryUnexpected > 0) {
    return refuse(
      'REFUSED_DUPLICATE_ECONOMIC_PAYOUT',
      [
        ...reasons,
        ...(duplicateEconomic > 0 ? [`duplicateEconomicPayouts=${duplicateEconomic}`] : []),
        ...(chainHistoryUnexpected > 0
          ? [`unexpectedExternalOutgoing=${chainHistoryUnexpected}`]
          : []),
      ],
      {
        confirmedCount,
        duplicateEconomicPayouts: duplicateEconomic + chainHistoryUnexpected,
        duplicateSettlements: duplicateSettlement,
      },
    );
  }
  if (duplicateSettlement > 0) {
    return refuse(
      'REFUSED_DUPLICATE_SETTLEMENT',
      [...reasons, `duplicateSettlements=${duplicateSettlement}`],
      {
        confirmedCount,
        duplicateEconomicPayouts: duplicateEconomic,
        duplicateSettlements: duplicateSettlement,
      },
    );
  }
  if (chainProofFail) {
    return refuse('REFUSED_CHAIN_PROOF_REQUIRED', reasons, {
      confirmedCount,
      duplicateEconomicPayouts: duplicateEconomic,
      duplicateSettlements: duplicateSettlement,
    });
  }
  if (unresolved) {
    return refuse('REFUSED_UNRESOLVED_CAMPAIGN', reasons, {
      confirmedCount,
      duplicateEconomicPayouts: duplicateEconomic,
      duplicateSettlements: duplicateSettlement,
    });
  }
  if (invariantFail || chainHistoryFail || reasons.length > 0) {
    return refuse(
      invariantFail ? 'REFUSED_INVARIANT_FAILURE' : 'REFUSED_MISSING_LIVE_EVIDENCE',
      reasons,
      {
        confirmedCount,
        duplicateEconomicPayouts: duplicateEconomic,
        duplicateSettlements: duplicateSettlement,
      },
    );
  }
  if (confirmedCount < MIN_CONTROLLED_CONFIRMED) {
    return refuse(
      'REFUSED_INSUFFICIENT_CONFIRMED_COUNT',
      [`confirmed=${confirmedCount} (need >= ${MIN_CONTROLLED_CONFIRMED})`],
      {
        confirmedCount,
        duplicateEconomicPayouts: duplicateEconomic,
        duplicateSettlements: duplicateSettlement,
      },
    );
  }

  return {
    verdict: 'PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED',
    mayCreateFinalArchive: true,
    mayMarkPhase10Closed: false,
    reasons: [
      'Verified campaign/readiness/failure evidence and DB invariants; Owner must still authorize Phase 10 close and archive.',
    ],
    confirmedCount,
    duplicateEconomicPayouts: duplicateEconomic,
    duplicateSettlements: duplicateSettlement,
  };
}

/** @deprecated Synchronous caller-trusted path removed; use evaluatePhase10AcceptanceFromEvidence. */
export function evaluatePhase10AcceptanceGateLegacyTrustedCounts(): never {
  throw new Error(
    'evaluatePhase10AcceptanceGate path-only API never PASSes; use evaluatePhase10AcceptanceFromEvidence',
  );
}
