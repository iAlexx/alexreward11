import type { PoolClient } from 'pg';

import { loadProviderMonetaryFacts } from '../admin-read.js';
import { withLedgerTransaction, type AdsDb } from '../db.js';
import { AdsDomainError } from '../errors.js';
import {
  evaluateProviderMonetaryEligibility,
  type ProviderMonetaryEligibilityResult,
} from '../monetary/eligibility.js';
import { getProvider } from '../provider-sdk/registry.js';
import type {
  EnvironmentName,
  ProviderCertificationCase,
  ProviderCertificationStatus,
} from '../types.js';

export type ProviderCertificationCategory =
  | 'AVAILABILITY_AND_DELIVERY'
  | 'COMPLETION_AND_DUPLICATES'
  | 'AUTHENTICITY_AND_REPLAY'
  | 'CORRELATION_AND_IDENTITY'
  | 'PROVIDER_FAILURE'
  | 'LIMITS_AND_ELIGIBILITY'
  | 'REPORTING_AND_SETTLEMENT';

interface CaseDefinition {
  readonly caseCode: ProviderCertificationCase;
  readonly category: ProviderCertificationCategory;
  /** Owner mandatory certification categories 1–20 (Spec V1.3 §156G). */
  readonly mandatory: boolean;
}

/**
 * Ordered certification catalogue. Ordinals 1–20 are the Owner's mandatory pre-approval
 * categories; 21–23 belong to the reporting/settlement phase and are reported separately.
 */
export const PROVIDER_CERTIFICATION_CASES: readonly CaseDefinition[] = [
  { caseCode: 'AVAILABILITY_SUCCESS', category: 'AVAILABILITY_AND_DELIVERY', mandatory: true },
  { caseCode: 'NO_FILL', category: 'AVAILABILITY_AND_DELIVERY', mandatory: true },
  { caseCode: 'LOAD_FAILURE', category: 'AVAILABILITY_AND_DELIVERY', mandatory: true },
  { caseCode: 'START_FAILURE', category: 'AVAILABILITY_AND_DELIVERY', mandatory: true },
  { caseCode: 'VALID_COMPLETION', category: 'COMPLETION_AND_DUPLICATES', mandatory: true },
  { caseCode: 'DUPLICATE_CLIENT_CALLBACK', category: 'COMPLETION_AND_DUPLICATES', mandatory: true },
  { caseCode: 'DUPLICATE_SERVER_CALLBACK', category: 'COMPLETION_AND_DUPLICATES', mandatory: true },
  {
    caseCode: 'SERVER_CALLBACK_BEFORE_CLIENT_CALLBACK',
    category: 'COMPLETION_AND_DUPLICATES',
    mandatory: true,
  },
  { caseCode: 'LATE_CALLBACK', category: 'COMPLETION_AND_DUPLICATES', mandatory: true },
  {
    caseCode: 'INVALID_OR_MISSING_SIGNATURE',
    category: 'AUTHENTICITY_AND_REPLAY',
    mandatory: true,
  },
  { caseCode: 'REPLAY', category: 'AUTHENTICITY_AND_REPLAY', mandatory: true },
  { caseCode: 'WRONG_USER', category: 'CORRELATION_AND_IDENTITY', mandatory: true },
  { caseCode: 'WRONG_SESSION', category: 'CORRELATION_AND_IDENTITY', mandatory: true },
  { caseCode: 'AMBIGUOUS_CORRELATION', category: 'CORRELATION_AND_IDENTITY', mandatory: true },
  { caseCode: 'PROVIDER_TIMEOUT', category: 'PROVIDER_FAILURE', mandatory: true },
  { caseCode: 'PROVIDER_OUTAGE', category: 'PROVIDER_FAILURE', mandatory: true },
  { caseCode: 'REQUEST_CAP_REACHED', category: 'LIMITS_AND_ELIGIBILITY', mandatory: true },
  { caseCode: 'SUCCESSFUL_CAP_REACHED', category: 'LIMITS_AND_ELIGIBILITY', mandatory: true },
  { caseCode: 'COUNTRY_NOT_ELIGIBLE', category: 'LIMITS_AND_ELIGIBILITY', mandatory: true },
  { caseCode: 'PROVIDER_SUSPENDED', category: 'LIMITS_AND_ELIGIBILITY', mandatory: true },
  { caseCode: 'REPORTING_IMPORT', category: 'REPORTING_AND_SETTLEMENT', mandatory: false },
  { caseCode: 'SETTLEMENT_MISMATCH', category: 'REPORTING_AND_SETTLEMENT', mandatory: false },
  {
    caseCode: 'INVALID_TRAFFIC_REVERSAL_INPUT',
    category: 'REPORTING_AND_SETTLEMENT',
    mandatory: false,
  },
];

export interface ProviderCertificationCaseContext {
  readonly providerCode: string;
  readonly providerId: string;
  readonly caseCode: ProviderCertificationCase;
  readonly category: ProviderCertificationCategory;
  readonly environment: EnvironmentName;
  readonly asOf: Date;
  readonly db: AdsDb | null;
}

export interface ProviderCertificationCaseOutcome {
  readonly status: ProviderCertificationStatus;
  readonly reasonCodes?: readonly string[];
  readonly evidenceReference?: string | null;
  readonly detailsRedacted?: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * A case runner performs the real scenario against a real database and asserts the
 * invariant. The harness intentionally ships no fixtures: inventing balances or fake
 * provider payloads here would certify the fixture rather than the system.
 */
export type ProviderCertificationCaseRunner = (
  context: ProviderCertificationCaseContext,
) => Promise<ProviderCertificationCaseOutcome> | ProviderCertificationCaseOutcome;

export interface ProviderCertificationDeps {
  readonly db?: AdsDb;
  readonly environment?: EnvironmentName;
  readonly asOf?: Date;
  readonly cases: Partial<Record<ProviderCertificationCase, ProviderCertificationCaseRunner>>;
  /**
   * When set together with `db`, the run and its per-case results are persisted to
   * `provider_certification_runs` / `provider_certification_results`.
   */
  readonly persistRunReference?: string;
}

export interface ProviderCertificationCaseResult {
  readonly ordinal: number;
  readonly caseCode: ProviderCertificationCase;
  readonly category: ProviderCertificationCategory;
  readonly mandatory: boolean;
  readonly status: ProviderCertificationStatus;
  readonly reasonCodes: readonly string[];
  readonly evidenceReference: string | null;
  readonly detailsRedacted: Readonly<Record<string, string | number | boolean | null>>;
  readonly executedAt: string;
}

export interface ProviderCertificationSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly blocked: number;
  readonly mandatoryTotal: number;
  readonly mandatoryPassed: number;
  readonly allMandatoryPassed: boolean;
}

export interface ProviderCertificationRunResult {
  readonly providerCode: string;
  readonly providerId: string;
  readonly adapterVersion: string;
  readonly environment: EnvironmentName;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly overallStatus: ProviderCertificationStatus;
  readonly results: readonly ProviderCertificationCaseResult[];
  readonly summary: ProviderCertificationSummary;
  readonly monetary: ProviderMonetaryEligibilityResult | null;
  /**
   * True only when every mandatory case passed AND the provider-neutral monetary gate is
   * already satisfied by data. A passing suite alone never approves production money.
   */
  readonly productionMonetaryApprovalRecommended: boolean;
  readonly reasonCodes: readonly string[];
}

/**
 * Run the provider certification suite for one registered adapter.
 *
 * The suite is reusable across providers: the catalogue, ordering, mandatory set and
 * summary logic are provider-neutral, and each scenario is supplied by the caller as a
 * runner that exercises the real pipeline. A case with no runner is reported as SKIPPED
 * rather than silently treated as a pass.
 */
export async function runProviderCertificationCases(
  providerCode: string,
  deps: ProviderCertificationDeps,
): Promise<ProviderCertificationRunResult> {
  const adapter = getProvider(providerCode);
  const asOf = deps.asOf ?? new Date();
  const environment = deps.environment ?? 'STAGING';
  const manifest = adapter.getManifest();
  const db = deps.db ?? null;

  const monetary =
    db === null ? null : await evaluateMonetaryFromDb(db, adapter.providerId, providerCode);

  const startedAt = new Date();
  const results: ProviderCertificationCaseResult[] = [];

  for (const [index, definition] of PROVIDER_CERTIFICATION_CASES.entries()) {
    const runner = deps.cases[definition.caseCode];
    const executedAt = new Date();

    if (runner === undefined) {
      results.push({
        ordinal: index + 1,
        caseCode: definition.caseCode,
        category: definition.category,
        mandatory: definition.mandatory,
        status: 'SKIPPED',
        reasonCodes: ['CASE_RUNNER_NOT_PROVIDED'],
        evidenceReference: null,
        detailsRedacted: {},
        executedAt: executedAt.toISOString(),
      });
      continue;
    }

    try {
      const outcome = await runner({
        providerCode,
        providerId: adapter.providerId,
        caseCode: definition.caseCode,
        category: definition.category,
        environment,
        asOf,
        db,
      });
      results.push({
        ordinal: index + 1,
        caseCode: definition.caseCode,
        category: definition.category,
        mandatory: definition.mandatory,
        status: outcome.status,
        reasonCodes: outcome.reasonCodes ?? [],
        evidenceReference: outcome.evidenceReference ?? null,
        detailsRedacted: outcome.detailsRedacted ?? {},
        executedAt: executedAt.toISOString(),
      });
    } catch (error) {
      results.push({
        ordinal: index + 1,
        caseCode: definition.caseCode,
        category: definition.category,
        mandatory: definition.mandatory,
        status: 'FAILED',
        reasonCodes: [
          error instanceof AdsDomainError ? error.code : 'CASE_RUNNER_THREW',
          error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
        ],
        evidenceReference: null,
        detailsRedacted: {},
        executedAt: executedAt.toISOString(),
      });
    }
  }

  const summary = summarize(results);
  const overallStatus: ProviderCertificationStatus =
    summary.failed > 0 ? 'FAILED' : summary.allMandatoryPassed ? 'PASSED' : 'BLOCKED';

  const reasonCodes: string[] = [];
  if (!summary.allMandatoryPassed) reasonCodes.push('MANDATORY_CASES_INCOMPLETE');
  if (monetary !== null && !monetary.eligible) reasonCodes.push(...monetary.reasonCodes);

  const completedAt = new Date();
  const run: ProviderCertificationRunResult = {
    providerCode,
    providerId: adapter.providerId,
    adapterVersion: manifest.adapterVersion,
    environment,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    overallStatus,
    results,
    summary,
    monetary,
    productionMonetaryApprovalRecommended:
      summary.allMandatoryPassed && monetary !== null && monetary.eligible,
    reasonCodes,
  };

  if (db !== null && deps.persistRunReference !== undefined) {
    await persistRun(db, run, deps.persistRunReference);
  }

  return run;
}

function summarize(
  results: readonly ProviderCertificationCaseResult[],
): ProviderCertificationSummary {
  const mandatory = results.filter((result) => result.mandatory);
  const mandatoryPassed = mandatory.filter((result) => result.status === 'PASSED').length;
  return {
    total: results.length,
    passed: results.filter((result) => result.status === 'PASSED').length,
    failed: results.filter((result) => result.status === 'FAILED').length,
    skipped: results.filter((result) => result.status === 'SKIPPED').length,
    blocked: results.filter((result) => result.status === 'BLOCKED').length,
    mandatoryTotal: mandatory.length,
    mandatoryPassed,
    allMandatoryPassed: mandatory.length > 0 && mandatoryPassed === mandatory.length,
  };
}

async function evaluateMonetaryFromDb(
  db: AdsDb,
  providerId: string,
  providerCode: string,
): Promise<ProviderMonetaryEligibilityResult> {
  return withLedgerTransaction(db, async (client) => {
    const facts = await loadProviderMonetaryFacts(client, providerId);
    return evaluateProviderMonetaryEligibility({
      providerId: facts.providerId,
      providerCode,
      productionMonetaryStatus: facts.productionMonetaryStatus,
      cashRewardPolicyApproved: facts.capabilities.cashRewardPolicyApproved,
      serverSignalAuthentication: facts.capabilities.serverSignalAuthentication,
      sessionOrImpressionCorrelation: facts.capabilities.sessionOrImpressionCorrelation,
      health: facts.health.status,
      openClarificationCount: facts.openClarificationCount,
      requestHardLimitExceeded: false,
      successHardLimitExceeded: false,
    });
  });
}

async function persistRun(
  db: AdsDb,
  run: ProviderCertificationRunResult,
  runReference: string,
): Promise<void> {
  await withLedgerTransaction(db, async (client) => {
    const runId = await upsertRun(client, run, runReference);
    for (const result of run.results) {
      await client.query(
        `INSERT INTO provider_certification_results (
           run_id, case_code, status, evidence_reference, details_redacted, executed_at
         ) VALUES ($1::uuid, $2::provider_certification_case, $3::provider_certification_status,
                   $4, $5::jsonb, $6::timestamptz)
         ON CONFLICT (run_id, case_code) DO UPDATE
           SET status = EXCLUDED.status,
               evidence_reference = EXCLUDED.evidence_reference,
               details_redacted = EXCLUDED.details_redacted,
               executed_at = EXCLUDED.executed_at`,
        [
          runId,
          result.caseCode,
          result.status,
          result.evidenceReference,
          JSON.stringify({ ...result.detailsRedacted, reasonCodes: result.reasonCodes.join(',') }),
          result.executedAt,
        ],
      );
    }
  });
}

async function upsertRun(
  client: PoolClient,
  run: ProviderCertificationRunResult,
  runReference: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO provider_certification_runs (
       provider_id, adapter_version, environment, run_reference, overall_status,
       started_at, completed_at
     ) VALUES ($1::uuid, $2, $3::environment_name, $4, $5::provider_certification_status,
               $6::timestamptz, $7::timestamptz)
     ON CONFLICT (provider_id, run_reference) DO UPDATE
       SET overall_status = EXCLUDED.overall_status,
           completed_at = EXCLUDED.completed_at
     RETURNING id`,
    [
      run.providerId,
      run.adapterVersion,
      run.environment,
      runReference,
      run.overallStatus,
      run.startedAt,
      run.completedAt,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) {
    throw new AdsDomainError('INTERNAL', 'certification run upsert returned no row');
  }
  return row.id;
}
