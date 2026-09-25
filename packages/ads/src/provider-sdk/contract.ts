import type { AdsDb } from '../db.js';
import type {
  AdFormat,
  AuthorizeAdInput,
  AuthorizeAdResult,
  AvailabilityInput,
  AvailabilityResult,
  EnvironmentName,
  ProviderClientSignal,
  ProviderHealth,
  ProviderMonetaryStatus,
  ProviderVerificationResult,
  VerificationContext,
} from '../types.js';

import type { ProviderCapabilities } from './capabilities.js';

/**
 * Versioned adapter manifest (Spec V1.3 §156D.3). Mirrors `ad_provider_manifests`
 * so a registered adapter can be compared against the approved database row.
 */
export interface ProviderManifest {
  readonly providerId: string;
  readonly providerCode: string;
  readonly name: string;
  readonly manifestVersion: number;
  readonly adapterVersion: string;
  readonly environment: EnvironmentName;
  readonly supportedFormats: readonly AdFormat[];
  readonly credentialsReference: string | null;
  readonly policyStatus: string;
  readonly productionMonetaryStatus: ProviderMonetaryStatus;
  /** Register of unresolved questions blocking production money, if any. */
  readonly clarificationReference: string | null;
}

/**
 * Required adapter contract (Spec V1.3 §19 / §156D.2).
 *
 * The adapter normalizes evidence, availability and health. It never decides a reward
 * amount, never posts to the ledger and never treats a client callback as money.
 */
export interface RewardedAdProvider {
  readonly code: string;
  readonly providerId: string;

  getManifest(): ProviderManifest;
  getCapabilities(): ProviderCapabilities;
  getAvailability(db: AdsDb, input: AvailabilityInput): Promise<AvailabilityResult>;
  authorizeSession(db: AdsDb, input: AuthorizeAdInput): Promise<AuthorizeAdResult>;
  /** Pure normalization of untrusted client input. Must not touch the database. */
  normalizeClientEvent(input: unknown): ProviderClientSignal;
  verifyServerSignal(
    input: unknown,
    context: VerificationContext,
  ): Promise<ProviderVerificationResult>;
  getHealth(db: AdsDb): Promise<ProviderHealth>;

  /** Optional reporting/reconciliation hooks arrive with the settlement phase. */
  fetchReporting?(db: AdsDb, input: ProviderReportingInput): Promise<ProviderReportingResult>;
  reconcile?(db: AdsDb, input: ProviderReconciliationInput): Promise<ProviderReconciliationResult>;
}

export interface ProviderReportingInput {
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly countryCode?: string | null;
}

export interface ProviderReportingResult {
  readonly supported: boolean;
  readonly reasonCodes: readonly string[];
  readonly rows: readonly Readonly<Record<string, string | number | null>>[];
}

export interface ProviderReconciliationInput {
  readonly settlementPeriodId: string;
}

export interface ProviderReconciliationResult {
  readonly supported: boolean;
  readonly reasonCodes: readonly string[];
  readonly mismatchCount: number;
}
