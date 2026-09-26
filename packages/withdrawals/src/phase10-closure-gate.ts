/**
 * Phase 10 closure-stage eligibility gate (separate from technical acceptance).
 *
 * Technical acceptance (`evaluatePhase10AcceptanceFromEvidence`) may create the
 * final archive and always keeps `mayMarkPhase10Closed=false`.
 * This module alone may return `mayMarkPhase10Closed=true` when post-run closure
 * requirements are satisfied.
 *
 * Historical live-readiness (schema-v2 B2: UNLOCKED / REAL / seqno admitted)
 * is proven from approved artifacts — NOT from current signer/REAL flags.
 * Current post-run safety requires pause + LOCKED + REAL=false + FAKE=false.
 *
 * Read-only evaluation never mutates campaign, ledger, chain, or safety.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Pool, PoolClient } from 'pg';

import type { DeploymentEnvironment } from './config.js';
import { isPayoutDispatchPaused } from './flags.js';
import {
  parseLiveReadinessEvidence,
  type Phase10AcceptanceGateVerdict,
} from './phase10-acceptance-gate.js';
import type { Phase10CampaignManifest } from './phase10-campaign.js';
import { isPool } from './db.js';

export const PHASE10_CLOSURE_GATE_SCHEMA_VERSION = 1 as const;

export const PHASE10_REQUIRED_ACCEPTANCE_PAYOUTS = 100 as const;

export type Phase10ClosureBlockerCode =
  | 'TECHNICAL_ACCEPTANCE_NOT_VALID'
  | 'TECHNICAL_ACCEPTANCE_READINESS_PASS_MISSING'
  | 'OWNER_REVIEW_NOT_APPROVED'
  | 'OWNER_REVIEW_PACKAGE_INVALID'
  | 'OWNER_EVIDENCE_BINDING_MISSING'
  | 'FINAL_ARCHIVE_MISSING'
  | 'FINAL_ARCHIVE_NOT_MARKED_CREATED'
  | 'FINAL_ARCHIVE_HASH_MISMATCH'
  | 'FINAL_ARCHIVE_MANIFEST_HASH_MISMATCH'
  | 'FINAL_ARCHIVE_INDEX_INVALID'
  | 'CAMPAIGN_INCOMPLETE'
  | 'CAMPAIGN_STATUS_INVALID_FOR_CLOSURE'
  | 'UNEXPECTED_PAYOUT_101'
  | 'ORDINAL_RANGE_INVALID'
  | 'UNRESOLVED_WITHDRAWALS'
  | 'ACTIVE_PAYOUT_LEASES'
  | 'DUPLICATE_ECONOMIC_PAYOUT'
  | 'DUPLICATE_SETTLEMENT'
  | 'RESERVED_BALANCE_NONZERO'
  | 'EVIDENCE_BINDING_MISMATCH'
  | 'CHAIN_EVIDENCE_DIGEST_MISMATCH'
  | 'HISTORICAL_LIVE_READINESS_INVALID'
  | 'PAYOUT_DISPATCH_NOT_PAUSED'
  | 'SIGNER_NOT_LOCKED'
  | 'SIGNER_STILL_SIGNING_READY'
  | 'REAL_CHAIN_STILL_ENABLED'
  | 'FAKE_CHAIN_STILL_ENABLED'
  | 'KNOWN_TEST_CONDITION_NOT_ACKNOWLEDGED'
  | 'PHASE10_ALREADY_CLOSED';

export interface Phase10ClosureBlocker {
  readonly code: Phase10ClosureBlockerCode;
  readonly message: string;
}

export type Phase10ClosureCheckStatus = 'PASS' | 'FAIL' | 'SKIPPED';

export interface Phase10ClosureCheckResult {
  readonly status: Phase10ClosureCheckStatus;
  readonly detail: string;
}

export interface Phase10ClosureCurrentSafetyInput {
  /** Current PAYOUT_DISPATCH_PAUSE enabled. */
  readonly payoutDispatchPaused: boolean;
  /** Current signer custodyState (expect LOCKED). */
  readonly signerCustodyState: string | null;
  /** Current signingReady (expect false). */
  readonly signingReady: boolean;
  /** Current WITHDRAWAL_REAL_CHAIN_ENABLED (expect false). */
  readonly realChainEnabled: boolean;
  /** Current WITHDRAWAL_FAKE_CHAIN_ENABLED (expect false). */
  readonly fakeChainEnabled: boolean;
}

export interface Phase10ClosureEconomicSnapshot {
  readonly unresolvedWithdrawals: number;
  readonly activePayoutLeases: number;
  readonly duplicateEconomicPayouts: number;
  readonly duplicateSettlements: number;
  /** USER_RESERVED_LIABILITY for controlled user (atomic string). */
  readonly reservedBalanceAtomic: string;
}

export interface Phase10ClosureEligibilityInput {
  readonly ownerReviewPackagePath: string;
  /**
   * Directory containing PHASE_10 package ZIP, MANIFEST.md, PACKAGE_SHA256.txt,
   * ARCHIVE_INDEX.json (as recorded on the Owner review package).
   */
  readonly finalArchiveDirectory: string;
  /**
   * Optional path overrides — defaulted from Owner evidence binding when omitted.
   */
  readonly campaignEvidencePath?: string;
  readonly readinessEvidencePath?: string;
  readonly chainHistoryEvidencePath?: string;
  readonly acceptanceEvalPath?: string;
  /** Live DB for economic queries when economicSnapshot is not supplied. */
  readonly db?: Pool | PoolClient;
  readonly deploymentEnvironment?: DeploymentEnvironment;
  readonly controlledUserId?: string;
  /** Injected economic snapshot (tests / offline). When omitted, loaded from db. */
  readonly economicSnapshot?: Phase10ClosureEconomicSnapshot;
  /** Current post-run safety (CLI probes / tests). */
  readonly currentSafety: Phase10ClosureCurrentSafetyInput;
  readonly evaluatedAt?: string;
}

export interface Phase10ClosureEvidenceBindingSummary {
  readonly campaignId: string;
  readonly acceptanceCutoff: string;
  readonly acceptanceResult: Phase10AcceptanceGateVerdict | string;
  readonly chainEvidenceDigest: string;
  readonly sha256: Readonly<Record<string, string>>;
  readonly paths: Readonly<Record<string, string>>;
}

export interface Phase10ClosureEligibilityResult {
  readonly schemaVersion: typeof PHASE10_CLOSURE_GATE_SCHEMA_VERSION;
  readonly evaluatedAt: string;
  readonly eligible: boolean;
  readonly mayMarkPhase10Closed: boolean;
  readonly blockers: readonly Phase10ClosureBlocker[];
  readonly checks: {
    readonly technicalAcceptance: Phase10ClosureCheckResult;
    readonly ownerReview: Phase10ClosureCheckResult;
    readonly finalArchive: Phase10ClosureCheckResult;
    readonly campaign: Phase10ClosureCheckResult;
    readonly economicSafety: Phase10ClosureCheckResult;
    readonly evidenceBinding: Phase10ClosureCheckResult;
    readonly historicalLiveReadiness: Phase10ClosureCheckResult;
    readonly closureSafety: Phase10ClosureCheckResult;
    readonly knownTestCondition: Phase10ClosureCheckResult;
  };
  readonly evidenceBinding: Phase10ClosureEvidenceBindingSummary | null;
  readonly archive: {
    readonly packageSha256: string | null;
    readonly manifestSha256: string | null;
    readonly packagePath: string | null;
    readonly matchesOwnerRecord: boolean;
  };
  readonly campaignSummary: {
    readonly campaignId: string | null;
    readonly status: string | null;
    readonly plannedCount: number | null;
    readonly evidenceCount: number | null;
    readonly remaining: number | null;
    readonly ordinalMin: number | null;
    readonly ordinalMax: number | null;
    readonly ordinal101Present: boolean;
    readonly realModeCheckpoint: string | null;
  };
  readonly economicSummary: Phase10ClosureEconomicSnapshot | null;
  readonly closureSafety: Phase10ClosureCurrentSafetyInput;
  readonly historicalLiveReadiness: {
    readonly treatedAsHistoricalArtifact: true;
    readonly schemaVersion: number | null;
    readonly verdict: string | null;
    readonly signerWasUnlockedDuringLiveWindow: boolean | null;
    readonly realWasEnabledDuringLiveWindow: boolean | null;
  };
  readonly knownTestCondition: {
    readonly classification: 'KNOWN_ACCEPTED_NON_BLOCKING_CONDITION' | 'MISSING' | 'INVALID';
    readonly failingTestCount: number | null;
    readonly ownerInformedAndAccepted: boolean;
    readonly fullRepositoryTestSuiteGreen: false;
  };
  /**
   * Campaign `realExecutionGates` are historical execution-window fields.
   * Closure does not require them to be currently true and must not rewrite them.
   */
  readonly realExecutionGatesNote: string;
}

export interface Phase10ClosureAuditRecord {
  readonly schemaVersion: 1;
  readonly packageKind: 'PHASE10_CLOSURE_AUDIT';
  readonly phase: '10';
  readonly campaignId: string;
  readonly technicalAcceptanceVerdict: string;
  readonly acceptanceCutoff: string;
  readonly ownerApproval: {
    readonly approved: boolean;
    readonly approvedAt: string | null;
  };
  readonly finalArchiveSha256: string;
  readonly manifestSha256: string | null;
  readonly chainEvidenceDigest: string;
  readonly closureGate: {
    readonly eligible: boolean;
    readonly mayMarkPhase10Closed: boolean;
    readonly blockers: readonly Phase10ClosureBlocker[];
    readonly evaluatedAt: string;
  };
  readonly campaignSummary: Phase10ClosureEligibilityResult['campaignSummary'];
  readonly economicSummary: Phase10ClosureEconomicSnapshot | null;
  readonly finalSafetyState: Phase10ClosureCurrentSafetyInput;
  readonly knownTestCondition: Phase10ClosureEligibilityResult['knownTestCondition'];
  /**
   * Only set when an authorized closure mutation actually occurs.
   * Eligibility evaluation / fixtures leave this null.
   */
  readonly closedAt: string | null;
}

export type Phase10CampaignFinalStatus = 'COMPLETED';

export interface Phase10CampaignClosureTransitionResult {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly finalStatus: Phase10CampaignFinalStatus | null;
  readonly manifest: Phase10CampaignManifest | null;
  /** Historical gates preserved unchanged when ok. */
  readonly realExecutionGatesUnchanged: boolean;
}

export type ClosePhase10OutcomeCode =
  | 'CLOSED'
  | 'ALREADY_CLOSED'
  | 'REFUSED_NOT_ELIGIBLE'
  | 'REFUSED_MUTATION_DISABLED'
  | 'REFUSED_MISSING_INPUT';

export interface ClosePhase10Input {
  readonly eligibilityInput: Phase10ClosureEligibilityInput;
  /**
   * When true, closePhase10 performs mutation (campaign COMPLETED + audit write).
   * Production Owner-authorized runs must set this explicitly after a separate
   * closure authorization. Default false refuses mutation.
   */
  readonly executeMutation?: boolean;
  readonly closureAuditOutputPath?: string;
  readonly now?: () => Date;
}

export interface ClosePhase10Result {
  readonly outcome: ClosePhase10OutcomeCode;
  readonly mayMarkPhase10Closed: boolean;
  readonly phase10Closed: boolean;
  readonly campaignStatus: string | null;
  readonly eligibility: Phase10ClosureEligibilityResult;
  readonly auditRecord: Phase10ClosureAuditRecord | null;
  readonly mutated: boolean;
  readonly message: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function pushBlocker(
  blockers: Phase10ClosureBlocker[],
  code: Phase10ClosureBlockerCode,
  message: string,
): void {
  blockers.push({ code, message });
}

function checkPass(detail: string): Phase10ClosureCheckResult {
  return { status: 'PASS', detail };
}

function checkFail(detail: string): Phase10ClosureCheckResult {
  return { status: 'FAIL', detail };
}

function stringMapFromRecord(rec: Record<string, unknown> | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (rec === null) return out;
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

export async function loadPhase10ClosureEconomicSnapshot(
  db: Pool | PoolClient,
  controlledUserId: string,
  deploymentEnvironment: DeploymentEnvironment = 'LOCAL',
): Promise<Phase10ClosureEconomicSnapshot & { payoutDispatchPaused: boolean }> {
  const query = async <T extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<T[]> => {
    const result = isPool(db)
      ? await db.query<T>(text, [...params])
      : await db.query<T>(text, [...params]);
    return result.rows;
  };

  const unresolved = (
    await query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM withdrawals WHERE state IN (
         'RECONCILE_REQUIRED','BROADCASTING','BROADCASTED','CONFIRMING','SIGNING','QUEUED','APPROVED'
       ) OR (state='HELD' AND held_from_reconcile=true)`,
    )
  )[0]?.c;

  const leases = (
    await query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM hot_wallet_dispatch_leases WHERE expires_at > now()`,
    ).catch(() => [{ c: 0 }])
  )[0]?.c;

  const reservedRows = await query<{ bal: string }>(
    `SELECT lab.balance_atomic::text AS bal
     FROM ledger_accounts la
     JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
     WHERE la.owner_id = $1::uuid
       AND la.account_type = 'USER_RESERVED_LIABILITY'
     LIMIT 1`,
    [controlledUserId],
  );

  const pause = await (async () => {
    if (isPool(db)) {
      return db.connect().then(async (client) => {
        try {
          return await isPayoutDispatchPaused(client, deploymentEnvironment);
        } finally {
          client.release();
        }
      });
    }
    return isPayoutDispatchPaused(db, deploymentEnvironment);
  })();

  return {
    unresolvedWithdrawals: unresolved ?? 0,
    activePayoutLeases: leases ?? 0,
    // Campaign-level duplicate counts are taken from acceptance evidence package;
    // economic snapshot reserved/unresolved/leases are live. Duplicates default 0 here
    // and are overridden by acceptance package values in the evaluator.
    duplicateEconomicPayouts: 0,
    duplicateSettlements: 0,
    reservedBalanceAtomic: reservedRows[0]?.bal ?? '0',
    payoutDispatchPaused: pause,
  };
}

function extractCampaignOrdinals(campaign: Record<string, unknown>): {
  readonly ordinals: number[];
  readonly has101: boolean;
  readonly min: number | null;
  readonly max: number | null;
} {
  const evidence = Array.isArray(campaign.evidence) ? campaign.evidence : [];
  const ordinals: number[] = [];
  for (const row of evidence) {
    const rec = asRecord(row);
    if (rec === null) continue;
    const raw = rec.ordinal;
    let n: number | null = null;
    if (typeof raw === 'number' && Number.isInteger(raw)) n = raw;
    else if (typeof raw === 'string' && raw.trim() !== '' && Number.isInteger(Number(raw))) {
      n = Number(raw);
    }
    if (n !== null) ordinals.push(n);
  }
  const has101 = ordinals.includes(101);
  return {
    ordinals,
    has101,
    min: ordinals.length > 0 ? Math.min(...ordinals) : null,
    max: ordinals.length > 0 ? Math.max(...ordinals) : null,
  };
}

function ordinalRangeComplete(ordinals: readonly number[], expected: number): boolean {
  if (ordinals.length !== expected) return false;
  const set = new Set(ordinals);
  if (set.size !== expected) return false;
  for (let i = 1; i <= expected; i += 1) {
    if (!set.has(i)) return false;
  }
  return true;
}

/**
 * Authoritative Phase 10 closure eligibility evaluator.
 * Never mutates state. Never sets mayMarkPhase10Closed based on current UNLOCKED/REAL.
 */
export async function evaluatePhase10ClosureEligibility(
  input: Phase10ClosureEligibilityInput,
): Promise<Phase10ClosureEligibilityResult> {
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();
  const blockers: Phase10ClosureBlocker[] = [];

  let technicalAcceptance = checkFail('not evaluated');
  let ownerReview = checkFail('not evaluated');
  let finalArchive = checkFail('not evaluated');
  let campaignCheck = checkFail('not evaluated');
  let economicSafety = checkFail('not evaluated');
  let evidenceBindingCheck = checkFail('not evaluated');
  let historicalLiveReadiness = checkFail('not evaluated');
  let closureSafety = checkFail('not evaluated');
  let knownTestConditionCheck = checkFail('not evaluated');

  let evidenceBinding: Phase10ClosureEvidenceBindingSummary | null = null;
  let economicSummary: Phase10ClosureEconomicSnapshot | null = null;
  let packageSha256: string | null = null;
  let manifestSha256: string | null = null;
  let packagePath: string | null = null;
  let matchesOwnerRecord = false;

  const campaignSummary = {
    campaignId: null as string | null,
    status: null as string | null,
    plannedCount: null as number | null,
    evidenceCount: null as number | null,
    remaining: null as number | null,
    ordinalMin: null as number | null,
    ordinalMax: null as number | null,
    ordinal101Present: false,
    realModeCheckpoint: null as string | null,
  };

  const historicalLive = {
    treatedAsHistoricalArtifact: true as const,
    schemaVersion: null as number | null,
    verdict: null as string | null,
    signerWasUnlockedDuringLiveWindow: null as boolean | null,
    realWasEnabledDuringLiveWindow: null as boolean | null,
  };

  let knownTestCondition: Phase10ClosureEligibilityResult['knownTestCondition'] = {
    classification: 'MISSING',
    failingTestCount: null,
    ownerInformedAndAccepted: false,
    fullRepositoryTestSuiteGreen: false,
  };

  const safety = input.currentSafety;

  // --- Owner review package ---
  if (!existsSync(input.ownerReviewPackagePath)) {
    pushBlocker(blockers, 'OWNER_REVIEW_PACKAGE_INVALID', 'owner-review-package.json missing');
    ownerReview = checkFail('owner-review-package.json missing');
  } else {
    let ownerPkgRaw: unknown;
    try {
      ownerPkgRaw = readJsonFile(input.ownerReviewPackagePath);
    } catch (e) {
      pushBlocker(
        blockers,
        'OWNER_REVIEW_PACKAGE_INVALID',
        `owner-review-package.json unreadable: ${String(e)}`,
      );
      ownerReview = checkFail('unreadable');
      ownerPkgRaw = null;
    }

    const ownerPkg = asRecord(ownerPkgRaw);
    if (ownerPkg === null) {
      pushBlocker(blockers, 'OWNER_REVIEW_PACKAGE_INVALID', 'owner-review-package.json not an object');
      ownerReview = checkFail('not an object');
    } else {
      if (ownerPkg.phase10Closed === true) {
        pushBlocker(blockers, 'PHASE10_ALREADY_CLOSED', 'phase10Closed already true on Owner package');
      }

      if (ownerPkg.ownerReviewApproved !== true) {
        pushBlocker(blockers, 'OWNER_REVIEW_NOT_APPROVED', 'ownerReviewApproved !== true');
        ownerReview = checkFail('ownerReviewApproved !== true');
      } else {
        ownerReview = checkPass('ownerReviewApproved=true');
      }

      const approval = asRecord(ownerPkg.ownerApproval);
      const binding = approval !== null ? asRecord(approval.evidenceBinding) : null;
      if (binding === null) {
        pushBlocker(
          blockers,
          'OWNER_EVIDENCE_BINDING_MISSING',
          'ownerApproval.evidenceBinding missing',
        );
        evidenceBindingCheck = checkFail('evidenceBinding missing');
      } else {
        const campaignId = readNonEmptyString(binding.campaignId) ?? '';
        const acceptanceCutoff = readNonEmptyString(binding.acceptanceCutoff) ?? '';
        const acceptanceResult =
          readNonEmptyString(binding.acceptanceResult) ??
          readNonEmptyString(asRecord(ownerPkg.evaluator)?.verdict) ??
          '';
        const chainBlock = asRecord(binding.chainHistory);
        const chainEvidenceDigest =
          readNonEmptyString(chainBlock?.evidenceDigest) ??
          readNonEmptyString(ownerPkg.chainEvidenceDigest) ??
          '';
        const sha256 = stringMapFromRecord(asRecord(binding.sha256));
        const paths = stringMapFromRecord(asRecord(binding.paths));

        evidenceBinding = {
          campaignId,
          acceptanceCutoff,
          acceptanceResult,
          chainEvidenceDigest,
          sha256,
          paths,
        };

        // Technical acceptance from Owner binding + eval artifact
        const evalPath =
          input.acceptanceEvalPath ??
          paths.evalFinal ??
          null;
        let readinessPass = false;
        let acceptanceVerdict: string | null = acceptanceResult || null;
        let dupEconomic = 0;
        let dupSettlement = 0;

        if (evalPath !== null && existsSync(evalPath)) {
          const evalRaw = asRecord(readJsonFile(evalPath));
          const result = evalRaw !== null ? asRecord(evalRaw.result) : null;
          if (result !== null) {
            acceptanceVerdict =
              readNonEmptyString(result.verdict) ?? acceptanceVerdict;
            if (result.mayCreateFinalArchive === true) readinessPass = true;
            if (typeof result.duplicateEconomicPayouts === 'number') {
              dupEconomic = result.duplicateEconomicPayouts;
            }
            if (typeof result.duplicateSettlements === 'number') {
              dupSettlement = result.duplicateSettlements;
            }
          }
          if (evalRaw?.readinessPass === true) readinessPass = true;
          if (evalRaw?.mayCreateFinalArchive === true) readinessPass = true;
        }

        const evaluator = asRecord(ownerPkg.evaluator);
        if (evaluator !== null) {
          if (evaluator.mayCreateFinalArchive === true) readinessPass = true;
          if (typeof evaluator.duplicateEconomicPayouts === 'number') {
            dupEconomic = evaluator.duplicateEconomicPayouts;
          }
          if (typeof evaluator.duplicateSettlements === 'number') {
            dupSettlement = evaluator.duplicateSettlements;
          }
          acceptanceVerdict =
            readNonEmptyString(evaluator.verdict) ?? acceptanceVerdict;
        }

        if (acceptanceVerdict !== 'PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED') {
          pushBlocker(
            blockers,
            'TECHNICAL_ACCEPTANCE_NOT_VALID',
            `acceptance verdict=${String(acceptanceVerdict)} (need PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED)`,
          );
          technicalAcceptance = checkFail(`verdict=${String(acceptanceVerdict)}`);
        } else if (!readinessPass) {
          pushBlocker(
            blockers,
            'TECHNICAL_ACCEPTANCE_READINESS_PASS_MISSING',
            'technical acceptance readinessPass / mayCreateFinalArchive not true',
          );
          technicalAcceptance = checkFail('readinessPass missing');
        } else {
          technicalAcceptance = checkPass(
            'PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED + readinessPass',
          );
        }

        // Evidence binding hash verification
        const hashMismatches: string[] = [];
        for (const [key, expected] of Object.entries(sha256)) {
          const path = paths[key];
          if (path === undefined || !existsSync(path)) {
            hashMismatches.push(`${key}: path missing`);
            continue;
          }
          const actual = sha256File(path);
          if (actual.toLowerCase() !== expected.toLowerCase()) {
            hashMismatches.push(`${key}: hash mismatch`);
          }
        }
        if (hashMismatches.length > 0) {
          pushBlocker(
            blockers,
            'EVIDENCE_BINDING_MISMATCH',
            `evidence SHA-256 binding failed: ${hashMismatches.join('; ')}`,
          );
          evidenceBindingCheck = checkFail(hashMismatches.join('; '));
        } else {
          evidenceBindingCheck = checkPass('all Owner-bound evidence SHA-256 match');
        }

        // Chain digest
        const chainPath = input.chainHistoryEvidencePath ?? paths.chainHistory;
        if (chainPath === undefined || !existsSync(chainPath)) {
          pushBlocker(
            blockers,
            'CHAIN_EVIDENCE_DIGEST_MISMATCH',
            'chain history evidence path missing',
          );
        } else {
          const chainRaw = asRecord(readJsonFile(chainPath));
          const digest = readNonEmptyString(chainRaw?.evidenceDigest);
          if (digest === null || digest.toLowerCase() !== chainEvidenceDigest.toLowerCase()) {
            pushBlocker(
              blockers,
              'CHAIN_EVIDENCE_DIGEST_MISMATCH',
              `chain evidenceDigest mismatch (expected ${chainEvidenceDigest}, got ${String(digest)})`,
            );
          }
        }

        // Historical live readiness (schema-v2 B2) — NOT current safety
        const readinessPath = input.readinessEvidencePath ?? paths.readiness;
        if (readinessPath === undefined || !existsSync(readinessPath)) {
          pushBlocker(
            blockers,
            'HISTORICAL_LIVE_READINESS_INVALID',
            'historical readiness evidence path missing',
          );
          historicalLiveReadiness = checkFail('path missing');
        } else {
          const readinessRaw = readJsonFile(readinessPath);
          const parsed = parseLiveReadinessEvidence(readinessRaw);
          const readyRec = asRecord(readinessRaw);
          historicalLive.schemaVersion =
            typeof readyRec?.schemaVersion === 'number' ? readyRec.schemaVersion : null;
          historicalLive.verdict = readNonEmptyString(readyRec?.verdict);
          historicalLive.signerWasUnlockedDuringLiveWindow =
            readyRec?.signerUnlocked === true ||
            readNonEmptyString(readyRec?.signerCustodyState) === 'UNLOCKED';
          historicalLive.realWasEnabledDuringLiveWindow = readyRec?.realChainEnabled === true;

          if (parsed.errors.length > 0 || parsed.parsed === null) {
            pushBlocker(
              blockers,
              'HISTORICAL_LIVE_READINESS_INVALID',
              `historical B2 readiness invalid: ${parsed.errors.join('; ')}`,
            );
            historicalLiveReadiness = checkFail(parsed.errors.join('; '));
          } else {
            historicalLiveReadiness = checkPass(
              'schema-v2 B2 READY_FOR_CONTROLLED_LIVE_TESTNET (historical UNLOCKED/REAL accepted)',
            );
          }
        }

        // Campaign
        const campaignPath = input.campaignEvidencePath ?? paths.campaign;
        if (campaignPath === undefined || !existsSync(campaignPath)) {
          pushBlocker(blockers, 'CAMPAIGN_INCOMPLETE', 'campaign evidence path missing');
          campaignCheck = checkFail('path missing');
        } else {
          const camp = asRecord(readJsonFile(campaignPath));
          if (camp === null) {
            pushBlocker(blockers, 'CAMPAIGN_INCOMPLETE', 'campaign evidence not an object');
            campaignCheck = checkFail('not an object');
          } else {
            const plannedCount =
              typeof camp.plannedCount === 'number'
                ? camp.plannedCount
                : typeof camp.plannedPayoutCount === 'number'
                  ? camp.plannedPayoutCount
                  : null;
            const withdrawalIds = Array.isArray(camp.withdrawalIds)
              ? camp.withdrawalIds.filter(
                  (id): id is string => typeof id === 'string' && id.trim() !== '',
                )
              : [];
            const evidenceArr = Array.isArray(camp.evidence) ? camp.evidence : [];
            const ordinalsInfo = extractCampaignOrdinals(camp);
            campaignSummary.campaignId = readNonEmptyString(camp.campaignId);
            campaignSummary.status = readNonEmptyString(camp.status);
            campaignSummary.plannedCount = plannedCount;
            campaignSummary.evidenceCount = evidenceArr.length;
            campaignSummary.remaining =
              plannedCount !== null ? Math.max(0, plannedCount - withdrawalIds.length) : null;
            campaignSummary.ordinalMin = ordinalsInfo.min;
            campaignSummary.ordinalMax = ordinalsInfo.max;
            campaignSummary.ordinal101Present = ordinalsInfo.has101;
            campaignSummary.realModeCheckpoint =
              typeof camp.realModeCheckpoint === 'string' ? camp.realModeCheckpoint : null;

            // AWAITING_OWNER_APPROVAL is expected pre-closure; COMPLETED also ok if re-evaluating.
            const statusOk =
              campaignSummary.status === 'AWAITING_OWNER_APPROVAL' ||
              campaignSummary.status === 'COMPLETED' ||
              campaignSummary.status === 'EVIDENCE_REFRESHED';
            if (!statusOk) {
              pushBlocker(
                blockers,
                'CAMPAIGN_STATUS_INVALID_FOR_CLOSURE',
                `campaign status=${String(campaignSummary.status)} not eligible for closure transition`,
              );
            }

            if (
              plannedCount !== PHASE10_REQUIRED_ACCEPTANCE_PAYOUTS ||
              withdrawalIds.length !== PHASE10_REQUIRED_ACCEPTANCE_PAYOUTS ||
              evidenceArr.length !== PHASE10_REQUIRED_ACCEPTANCE_PAYOUTS ||
              campaignSummary.remaining !== 0 ||
              !ordinalRangeComplete(ordinalsInfo.ordinals, PHASE10_REQUIRED_ACCEPTANCE_PAYOUTS)
            ) {
              pushBlocker(
                blockers,
                'CAMPAIGN_INCOMPLETE',
                `campaign incomplete planned=${String(plannedCount)} attached=${withdrawalIds.length} evidence=${evidenceArr.length} remaining=${String(campaignSummary.remaining)} ordinals=${ordinalsInfo.min}..${ordinalsInfo.max}`,
              );
              campaignCheck = checkFail('incomplete 100/100 ordinal range');
            } else if (ordinalsInfo.has101) {
              pushBlocker(blockers, 'UNEXPECTED_PAYOUT_101', 'evidence ordinal 101 present');
              campaignCheck = checkFail('ordinal 101 present');
            } else if (
              campaignSummary.campaignId !== null &&
              campaignId !== '' &&
              campaignSummary.campaignId !== campaignId
            ) {
              pushBlocker(
                blockers,
                'EVIDENCE_BINDING_MISMATCH',
                `campaignId mismatch package=${campaignId} campaign=${campaignSummary.campaignId}`,
              );
              campaignCheck = checkFail('campaignId mismatch');
            } else {
              campaignCheck = checkPass('100/100 ordinals 1..100, #101 absent');
            }
          }
        }

        // Final archive
        if (ownerPkg.finalArchiveCreated !== true) {
          pushBlocker(
            blockers,
            'FINAL_ARCHIVE_NOT_MARKED_CREATED',
            'finalArchiveCreated !== true on Owner package',
          );
          finalArchive = checkFail('finalArchiveCreated !== true');
        } else {
          const archiveMeta = asRecord(ownerPkg.archive);
          const expectedPackageSha =
            readNonEmptyString(archiveMeta?.packageSha256)?.toLowerCase() ?? null;
          const expectedManifestSha =
            readNonEmptyString(archiveMeta?.manifestSha256)?.toLowerCase() ?? null;
          const packageZipName =
            readNonEmptyString(archiveMeta?.packageZip) ??
            'PHASE_10_TON_TESTNET_PAYOUT_PACKAGE_20260925-034434.zip';
          const manifestName = readNonEmptyString(archiveMeta?.manifest) ?? 'MANIFEST.md';
          packagePath = join(input.finalArchiveDirectory, packageZipName);
          const manifestPath = join(input.finalArchiveDirectory, manifestName);
          const indexPath = join(input.finalArchiveDirectory, 'ARCHIVE_INDEX.json');
          const packageShaFile = join(input.finalArchiveDirectory, 'PACKAGE_SHA256.txt');

          if (!existsSync(packagePath) || !existsSync(manifestPath)) {
            pushBlocker(
              blockers,
              'FINAL_ARCHIVE_MISSING',
              `archive package or manifest missing under ${input.finalArchiveDirectory}`,
            );
            finalArchive = checkFail('archive files missing');
          } else {
            packageSha256 = sha256File(packagePath).toLowerCase();
            manifestSha256 = sha256File(manifestPath).toLowerCase();
            matchesOwnerRecord =
              expectedPackageSha !== null &&
              expectedManifestSha !== null &&
              packageSha256 === expectedPackageSha &&
              manifestSha256 === expectedManifestSha;

            if (expectedPackageSha === null || packageSha256 !== expectedPackageSha) {
              pushBlocker(
                blockers,
                'FINAL_ARCHIVE_HASH_MISMATCH',
                `package SHA-256 mismatch expected=${String(expectedPackageSha)} actual=${packageSha256}`,
              );
            }
            if (expectedManifestSha === null || manifestSha256 !== expectedManifestSha) {
              pushBlocker(
                blockers,
                'FINAL_ARCHIVE_MANIFEST_HASH_MISMATCH',
                `manifest SHA-256 mismatch expected=${String(expectedManifestSha)} actual=${manifestSha256}`,
              );
            }

            if (existsSync(packageShaFile)) {
              const listed = readFileSync(packageShaFile, 'utf8').trim().toLowerCase();
              if (!listed.startsWith(packageSha256)) {
                pushBlocker(
                  blockers,
                  'FINAL_ARCHIVE_HASH_MISMATCH',
                  'PACKAGE_SHA256.txt does not match computed package hash',
                );
              }
            }

            if (existsSync(indexPath)) {
              const index = asRecord(readJsonFile(indexPath));
              if (
                index === null ||
                index.packageKind !== 'PHASE10_FINAL_EVIDENCE_ARCHIVE' ||
                index.finalArchiveCreated !== true
              ) {
                pushBlocker(
                  blockers,
                  'FINAL_ARCHIVE_INDEX_INVALID',
                  'ARCHIVE_INDEX.json invalid or finalArchiveCreated !== true',
                );
              }
            } else {
              pushBlocker(
                blockers,
                'FINAL_ARCHIVE_INDEX_INVALID',
                'ARCHIVE_INDEX.json missing',
              );
            }

            if (
              !blockers.some(
                (b) =>
                  b.code === 'FINAL_ARCHIVE_MISSING' ||
                  b.code === 'FINAL_ARCHIVE_HASH_MISMATCH' ||
                  b.code === 'FINAL_ARCHIVE_MANIFEST_HASH_MISMATCH' ||
                  b.code === 'FINAL_ARCHIVE_INDEX_INVALID' ||
                  b.code === 'FINAL_ARCHIVE_NOT_MARKED_CREATED',
              )
            ) {
              finalArchive = checkPass('final archive SHA-256 + manifest + index valid');
            } else {
              finalArchive = checkFail('archive integrity failed');
            }
          }
        }

        // Known 21-test condition — required Owner acknowledgment; non-blocking when present
        const known =
          asRecord(approval?.knownTestCondition) ??
          asRecord(ownerPkg.knownTestCondition);
        const unrelated = known !== null ? asRecord(known.knownUnrelatedFailures) : null;
        const failingCount =
          unrelated !== null && typeof unrelated.failingTestCount === 'number'
            ? unrelated.failingTestCount
            : null;
        const ownerAccepted = known?.ownerInformedAndAccepted === true;
        const documented = known?.documented === true;
        if (!documented || !ownerAccepted || failingCount !== 21) {
          pushBlocker(
            blockers,
            'KNOWN_TEST_CONDITION_NOT_ACKNOWLEDGED',
            'Owner package must document and acknowledge the known 21 failures in phase10-canary-signing-recovery.test.ts',
          );
          knownTestConditionCheck = checkFail('known 21-test condition not acknowledged');
          knownTestCondition = {
            classification: known === null ? 'MISSING' : 'INVALID',
            failingTestCount: failingCount,
            ownerInformedAndAccepted: ownerAccepted,
            fullRepositoryTestSuiteGreen: false,
          };
        } else {
          knownTestCondition = {
            classification: 'KNOWN_ACCEPTED_NON_BLOCKING_CONDITION',
            failingTestCount: 21,
            ownerInformedAndAccepted: true,
            fullRepositoryTestSuiteGreen: false,
          };
          knownTestConditionCheck = checkPass(
            'KNOWN_ACCEPTED_NON_BLOCKING_CONDITION (21 failures; suite not claimed green)',
          );
        }

        // Economic safety
        if (input.economicSnapshot !== undefined) {
          economicSummary = {
            ...input.economicSnapshot,
            duplicateEconomicPayouts: dupEconomic || input.economicSnapshot.duplicateEconomicPayouts,
            duplicateSettlements: dupSettlement || input.economicSnapshot.duplicateSettlements,
          };
        } else if (input.db !== undefined) {
          const campaignForUser =
            input.campaignEvidencePath ?? paths.campaign !== undefined
              ? asRecord(
                  readJsonFile(
                    input.campaignEvidencePath ?? paths.campaign!,
                  ),
                )
              : null;
          const controlledUserId =
            input.controlledUserId ??
            readNonEmptyString(campaignForUser?.controlledUserId) ??
            '';
          if (controlledUserId === '') {
            pushBlocker(
              blockers,
              'UNRESOLVED_WITHDRAWALS',
              'controlledUserId required to load economic snapshot from DB',
            );
          } else {
            const live = await loadPhase10ClosureEconomicSnapshot(
              input.db,
              controlledUserId,
              input.deploymentEnvironment ?? 'LOCAL',
            );
            economicSummary = {
              unresolvedWithdrawals: live.unresolvedWithdrawals,
              activePayoutLeases: live.activePayoutLeases,
              duplicateEconomicPayouts: dupEconomic,
              duplicateSettlements: dupSettlement,
              reservedBalanceAtomic: live.reservedBalanceAtomic,
            };
          }
        } else {
          pushBlocker(
            blockers,
            'UNRESOLVED_WITHDRAWALS',
            'economicSnapshot or db required for live unresolved/lease verification',
          );
        }

        if (economicSummary !== null) {
          if (economicSummary.unresolvedWithdrawals !== 0) {
            pushBlocker(
              blockers,
              'UNRESOLVED_WITHDRAWALS',
              `unresolvedWithdrawals=${economicSummary.unresolvedWithdrawals}`,
            );
          }
          if (economicSummary.activePayoutLeases !== 0) {
            pushBlocker(
              blockers,
              'ACTIVE_PAYOUT_LEASES',
              `activePayoutLeases=${economicSummary.activePayoutLeases}`,
            );
          }
          if (economicSummary.duplicateEconomicPayouts !== 0) {
            pushBlocker(
              blockers,
              'DUPLICATE_ECONOMIC_PAYOUT',
              `duplicateEconomicPayouts=${economicSummary.duplicateEconomicPayouts}`,
            );
          }
          if (economicSummary.duplicateSettlements !== 0) {
            pushBlocker(
              blockers,
              'DUPLICATE_SETTLEMENT',
              `duplicateSettlements=${economicSummary.duplicateSettlements}`,
            );
          }
          if (economicSummary.reservedBalanceAtomic !== '0') {
            pushBlocker(
              blockers,
              'RESERVED_BALANCE_NONZERO',
              `reservedBalanceAtomic=${economicSummary.reservedBalanceAtomic}`,
            );
          }

          if (
            !blockers.some((b) =>
              (
                [
                  'UNRESOLVED_WITHDRAWALS',
                  'ACTIVE_PAYOUT_LEASES',
                  'DUPLICATE_ECONOMIC_PAYOUT',
                  'DUPLICATE_SETTLEMENT',
                  'RESERVED_BALANCE_NONZERO',
                ] as Phase10ClosureBlockerCode[]
              ).includes(b.code),
            )
          ) {
            economicSafety = checkPass('unresolved=0 leases=0 duplicates=0 reserved=0');
          } else {
            economicSafety = checkFail('economic safety failed');
          }
        }
      }
    }
  }

  // Post-run closure safety (CURRENT) — independent of historical B2 UNLOCKED/REAL
  const safetyFails: string[] = [];
  if (safety.payoutDispatchPaused !== true) {
    pushBlocker(blockers, 'PAYOUT_DISPATCH_NOT_PAUSED', 'PAYOUT_DISPATCH_PAUSE must be true');
    safetyFails.push('pause');
  }
  const custody = (safety.signerCustodyState ?? '').toUpperCase();
  if (custody !== 'LOCKED') {
    pushBlocker(
      blockers,
      'SIGNER_NOT_LOCKED',
      `signer custodyState must be LOCKED (got ${String(safety.signerCustodyState)})`,
    );
    safetyFails.push('signer');
  }
  if (safety.signingReady !== false) {
    pushBlocker(
      blockers,
      'SIGNER_STILL_SIGNING_READY',
      'signingReady must be false for post-run closure',
    );
    safetyFails.push('signingReady');
  }
  if (safety.realChainEnabled !== false) {
    pushBlocker(blockers, 'REAL_CHAIN_STILL_ENABLED', 'WITHDRAWAL_REAL_CHAIN_ENABLED must be false');
    safetyFails.push('REAL');
  }
  if (safety.fakeChainEnabled !== false) {
    pushBlocker(blockers, 'FAKE_CHAIN_STILL_ENABLED', 'WITHDRAWAL_FAKE_CHAIN_ENABLED must be false');
    safetyFails.push('FAKE');
  }
  closureSafety =
    safetyFails.length === 0
      ? checkPass('pause=true signer LOCKED signingReady=false REAL=false FAKE=false')
      : checkFail(`failed: ${safetyFails.join(',')}`);

  // Deduplicate blockers by code+message
  const uniqueBlockers: Phase10ClosureBlocker[] = [];
  const seen = new Set<string>();
  for (const b of blockers) {
    const key = `${b.code}|${b.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueBlockers.push(b);
  }

  // If economic path without db/snapshot added a blocker but test supplied snapshot later —
  // already handled. For the "no db and no snapshot" case we keep the blocker.

  // When economicSnapshot is provided, strip the "db required" blocker if present from old path.
  // (Current code only adds that blocker when neither is provided.)

  const eligible = uniqueBlockers.length === 0;
  return {
    schemaVersion: PHASE10_CLOSURE_GATE_SCHEMA_VERSION,
    evaluatedAt,
    eligible,
    mayMarkPhase10Closed: eligible,
    blockers: uniqueBlockers,
    checks: {
      technicalAcceptance,
      ownerReview,
      finalArchive,
      campaign: campaignCheck,
      economicSafety,
      evidenceBinding: evidenceBindingCheck,
      historicalLiveReadiness,
      closureSafety,
      knownTestCondition: knownTestConditionCheck,
    },
    evidenceBinding,
    archive: {
      packageSha256,
      manifestSha256,
      packagePath,
      matchesOwnerRecord,
    },
    campaignSummary,
    economicSummary,
    closureSafety: safety,
    historicalLiveReadiness: historicalLive,
    knownTestCondition,
    realExecutionGatesNote:
      'Campaign realExecutionGates / realModeCheckpoint are historical execution-window fields. Closure eligibility proves historical readiness via approved schema-v2 B2 readiness artifact and current post-run safety via closureSafetyChecks. Do not mutate realExecutionGates to fake clearance.',
  };
}

/**
 * Build immutable closure audit metadata. Does NOT set closedAt unless provided.
 */
export function buildPhase10ClosureAuditRecord(input: {
  readonly eligibility: Phase10ClosureEligibilityResult;
  readonly closedAt?: string | null;
  readonly ownerApprovedAt?: string | null;
}): Phase10ClosureAuditRecord {
  const e = input.eligibility;
  return {
    schemaVersion: 1,
    packageKind: 'PHASE10_CLOSURE_AUDIT',
    phase: '10',
    campaignId: e.evidenceBinding?.campaignId ?? e.campaignSummary.campaignId ?? '',
    technicalAcceptanceVerdict: e.evidenceBinding?.acceptanceResult ?? '',
    acceptanceCutoff: e.evidenceBinding?.acceptanceCutoff ?? '',
    ownerApproval: {
      approved: e.checks.ownerReview.status === 'PASS',
      approvedAt: input.ownerApprovedAt ?? null,
    },
    finalArchiveSha256: e.archive.packageSha256 ?? '',
    manifestSha256: e.archive.manifestSha256,
    chainEvidenceDigest: e.evidenceBinding?.chainEvidenceDigest ?? '',
    closureGate: {
      eligible: e.eligible,
      mayMarkPhase10Closed: e.mayMarkPhase10Closed,
      blockers: e.blockers,
      evaluatedAt: e.evaluatedAt,
    },
    campaignSummary: e.campaignSummary,
    economicSummary: e.economicSummary,
    finalSafetyState: e.closureSafety,
    knownTestCondition: e.knownTestCondition,
    closedAt: input.closedAt ?? null,
  };
}

/**
 * Pure campaign final-state transition planner.
 * Canonical final status is COMPLETED (existing enum — no invented CLOSED).
 * Clears realModeCheckpoint; preserves historical realExecutionGates unchanged.
 * Does NOT write files.
 */
export function transitionCampaignToPhase10FinalState(
  manifest: Phase10CampaignManifest,
  eligibility: Phase10ClosureEligibilityResult,
  nowIso?: string,
): Phase10CampaignClosureTransitionResult {
  if (!eligibility.mayMarkPhase10Closed || !eligibility.eligible) {
    return {
      ok: false,
      reason: 'closure eligibility mayMarkPhase10Closed=false',
      finalStatus: null,
      manifest: null,
      realExecutionGatesUnchanged: true,
    };
  }

  if (manifest.status === 'COMPLETED' && manifest.realModeCheckpoint === null) {
    return {
      ok: true,
      reason: 'ALREADY_CLOSED',
      finalStatus: 'COMPLETED',
      manifest,
      realExecutionGatesUnchanged: true,
    };
  }

  const updated: Phase10CampaignManifest = {
    ...manifest,
    status: 'COMPLETED',
    realModeCheckpoint: null,
    // Preserve historical execution gates exactly — do not rewrite.
    realExecutionGates: manifest.realExecutionGates,
    updatedAt: nowIso ?? new Date().toISOString(),
  };

  return {
    ok: true,
    reason: null,
    finalStatus: 'COMPLETED',
    manifest: updated,
    realExecutionGatesUnchanged: true,
  };
}

/**
 * Closure executor skeleton. Revalidates eligibility and refuses when false.
 * Mutation requires executeMutation=true. Default is refuse-to-mutate.
 * Idempotent: already-closed Owner package → ALREADY_CLOSED without re-mutation.
 */
export async function closePhase10(input: ClosePhase10Input): Promise<ClosePhase10Result> {
  const eligibility = await evaluatePhase10ClosureEligibility(input.eligibilityInput);

  if (!existsSync(input.eligibilityInput.ownerReviewPackagePath)) {
    return {
      outcome: 'REFUSED_MISSING_INPUT',
      mayMarkPhase10Closed: false,
      phase10Closed: false,
      campaignStatus: null,
      eligibility,
      auditRecord: null,
      mutated: false,
      message: 'owner-review-package.json missing',
    };
  }

  const ownerPkg = asRecord(readJsonFile(input.eligibilityInput.ownerReviewPackagePath));
  if (ownerPkg?.phase10Closed === true) {
    const audit = buildPhase10ClosureAuditRecord({
      eligibility,
      closedAt: readNonEmptyString(ownerPkg.closedAt),
      ownerApprovedAt: readNonEmptyString(asRecord(ownerPkg.ownerApproval)?.approvedAt),
    });
    return {
      outcome: 'ALREADY_CLOSED',
      mayMarkPhase10Closed: eligibility.mayMarkPhase10Closed,
      phase10Closed: true,
      campaignStatus: eligibility.campaignSummary.status,
      eligibility,
      auditRecord: audit,
      mutated: false,
      message: 'Phase 10 already closed — idempotent no-op',
    };
  }

  if (!eligibility.mayMarkPhase10Closed) {
    return {
      outcome: 'REFUSED_NOT_ELIGIBLE',
      mayMarkPhase10Closed: false,
      phase10Closed: false,
      campaignStatus: eligibility.campaignSummary.status,
      eligibility,
      auditRecord: buildPhase10ClosureAuditRecord({
        eligibility,
        closedAt: null,
        ownerApprovedAt: readNonEmptyString(
          asRecord(ownerPkg?.ownerApproval)?.approvedAt,
        ),
      }),
      mutated: false,
      message: `closure refused: ${eligibility.blockers.map((b) => b.code).join(',')}`,
    };
  }

  if (input.executeMutation !== true) {
    return {
      outcome: 'REFUSED_MUTATION_DISABLED',
      mayMarkPhase10Closed: true,
      phase10Closed: false,
      campaignStatus: eligibility.campaignSummary.status,
      eligibility,
      auditRecord: buildPhase10ClosureAuditRecord({
        eligibility,
        closedAt: null,
        ownerApprovedAt: readNonEmptyString(
          asRecord(ownerPkg?.ownerApproval)?.approvedAt,
        ),
      }),
      mutated: false,
      message:
        'eligible but executeMutation!==true — closure mutation not performed (Owner must authorize separately)',
    };
  }

  // Mutation path exists for future Owner-authorized execution and fixture tests only.
  const now = (input.now ?? (() => new Date()))().toISOString();
  const campaignPath =
    input.eligibilityInput.campaignEvidencePath ??
    eligibility.evidenceBinding?.paths.campaign;
  if (campaignPath === undefined || !existsSync(campaignPath)) {
    return {
      outcome: 'REFUSED_MISSING_INPUT',
      mayMarkPhase10Closed: true,
      phase10Closed: false,
      campaignStatus: null,
      eligibility,
      auditRecord: null,
      mutated: false,
      message: 'campaign path missing for closure mutation',
    };
  }

  const manifest = JSON.parse(readFileSync(campaignPath, 'utf8')) as Phase10CampaignManifest;
  const transition = transitionCampaignToPhase10FinalState(manifest, eligibility, now);
  if (!transition.ok || transition.manifest === null) {
    return {
      outcome: 'REFUSED_NOT_ELIGIBLE',
      mayMarkPhase10Closed: true,
      phase10Closed: false,
      campaignStatus: manifest.status,
      eligibility,
      auditRecord: null,
      mutated: false,
      message: transition.reason ?? 'campaign transition failed',
    };
  }

  const { writeFileSync } = await import('node:fs');
  writeFileSync(campaignPath, `${JSON.stringify(transition.manifest, null, 2)}\n`, 'utf8');

  const audit = buildPhase10ClosureAuditRecord({
    eligibility,
    closedAt: now,
    ownerApprovedAt: readNonEmptyString(asRecord(ownerPkg?.ownerApproval)?.approvedAt),
  });

  const updatedOwner = {
    ...ownerPkg,
    phase10Closed: true,
    closedAt: now,
    status: 'PHASE10_CLOSED',
    campaign: {
      ...(asRecord(ownerPkg?.campaign) ?? {}),
      status: 'COMPLETED',
    },
  };
  writeFileSync(
    input.eligibilityInput.ownerReviewPackagePath,
    `${JSON.stringify(updatedOwner, null, 2)}\n`,
    'utf8',
  );

  if (input.closureAuditOutputPath !== undefined) {
    writeFileSync(
      input.closureAuditOutputPath,
      `${JSON.stringify(audit, null, 2)}\n`,
      'utf8',
    );
  }

  return {
    outcome: 'CLOSED',
    mayMarkPhase10Closed: true,
    phase10Closed: true,
    campaignStatus: 'COMPLETED',
    eligibility,
    auditRecord: audit,
    mutated: true,
    message: 'Phase 10 closed via authoritative closure path',
  };
}

/** Test helper — hash a buffer with the same algorithm as archive verification. */
export function phase10ClosureSha256Hex(data: string | Buffer): string {
  return sha256Buffer(typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
}
