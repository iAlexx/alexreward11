/**
 * Phase 18 Step 2A — restore-drill evidence contract.
 * Observations only. Never payout/financial authority.
 */

export type DrillSectionStatus =
  | 'PASS'
  | 'FAIL'
  | 'NOT_OBSERVED'
  | 'NOT_EXECUTED'
  | 'OWNER_REVIEW_REQUIRED'
  | 'THRESHOLD_NOT_CONFIGURED';

export interface RestoreTargetFingerprint {
  readonly currentDatabase: string;
  readonly expectedDatabase: string;
  readonly targetHost: string;
  readonly sourceHostProvided: boolean;
  readonly sourceHost: string | null;
  readonly targetDistinctFromSource: boolean | null;
  readonly targetDatabaseName: string;
  readonly targetDatabaseNameMatchesExpected: boolean;
  readonly databaseReadOnlyEnforced: boolean;
  readonly postgresVersion: string | null;
  readonly schemaMigrationHead: string | null;
  readonly schemaMigrationCount: number | null;
  /** Host/port/user redacted — never includes password or full URL. */
  readonly redactedTargetSummary: string;
}

export interface TimingEvidence {
  readonly backupCapturedAt: string | null;
  readonly restoreStartedAt: string | null;
  readonly restoreAvailableAt: string | null;
  readonly validationStartedAt: string;
  readonly validationCompletedAt: string;
  readonly observedRestoreSeconds: number | null;
  readonly observedValidationSeconds: number | null;
  readonly observedRtoSeconds: number | null;
  readonly sourceEvidenceCapturedAt: string | null;
  readonly restoredLatestAuthoritativeTimestamp: string | null;
  readonly observedRpoSeconds: number | null;
  /** Targets are Owner policy — never invented here. */
  readonly rtoTargetSeconds: 'OWNER_POLICY_REQUIRED';
  readonly rpoTargetSeconds: 'OWNER_POLICY_REQUIRED';
}

export interface CountCapture {
  readonly capturedAt: string;
  readonly tables: Readonly<Record<string, number>>;
}

/** Safe per-selected-user evidence. userReference is SHA-256 hex — never a raw UUID. */
export interface SelectedUserHistoryEvidence {
  readonly userReference: string;
  readonly userIdPresent: boolean;
  readonly ledgerAccountCount: number;
  readonly ledgerProjectionRowCount: number;
  readonly rewardEventCount: number;
  readonly withdrawalCount: number;
  readonly withdrawalsByState: Readonly<Record<string, number>>;
}

export interface RestoreDrillReport {
  readonly contractVersion: 'phase18-restore-drill-v1';
  readonly mode: 'DB_ONLY_STEP2A' | 'FULL_STEP2B';
  readonly observedAt: string;
  readonly target: RestoreTargetFingerprint;
  readonly timing: TimingEvidence;
  readonly schema: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly expectedMigrationCount: number;
    readonly appliedMigrationCount: number;
    readonly missingVersions: readonly string[];
    readonly criticalTablesMissing: readonly string[];
    readonly criticalColumnsMissing: readonly string[];
    readonly criticalEnumValuesMissing: readonly string[];
  };
  readonly payoutDispatchPause: {
    readonly status: DrillSectionStatus;
    readonly flagKey: 'PAYOUT_DISPATCH_PAUSE';
    readonly environment: string;
    readonly payoutDispatchPausedAtValidation: boolean | null;
    readonly autoUnpause: false;
    readonly reasonCode: string;
  };
  readonly ledgerInvariants: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly ok: boolean | null;
    readonly criticalCount: number;
    readonly findingCodes: readonly string[];
  };
  readonly withdrawalRestoreReconcile: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly dangerousCount: number;
    readonly warnCount: number;
    readonly byCategory: Readonly<Record<string, number>>;
    readonly autoResend: false;
    readonly autoUnpause: false;
    readonly historicalBaseline: 'NOT_SUPPLIED' | 'SUPPLIED';
  };
  readonly outbox: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly pending: number;
    readonly processing: number;
    readonly dispatched: number;
    readonly failed: number;
    readonly deadLetter: number;
    readonly oldestPendingAgeSeconds: number | null;
    readonly withdrawalApprovedPending: number;
    readonly duplicateDedupeKeyAnomalies: number;
    readonly lagThreshold: 'THRESHOLD_NOT_CONFIGURED';
  };
  readonly workflowReconciliation: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly dbExpectedWorkflowIdentityCount: number;
    readonly temporalObservedWorkflowCount: number;
    readonly matchedCount: number;
    readonly missingInTemporalCount: number;
    readonly unexpectedInTemporalCount: number;
    readonly statusCounts: Readonly<Record<string, number>>;
    readonly mismatchReferences: readonly string[];
    readonly temporalQueried: boolean;
  };
  readonly blockchainReconciliation: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly liveChainReconciliation: 'OBSERVED' | 'NOT_REQUIRED_EMPTY_SCOPE' | 'NOT_OBSERVED';
    readonly withdrawalsRequiringLiveChainCount: number;
    readonly liveProviderQueryPerformed: boolean;
    readonly chainScopeEmpty: boolean;
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
    readonly payoutInvariantFailCount: number | null;
    readonly payoutInvariantFindingCodes: readonly string[];
    readonly mismatchReferences: readonly string[];
  };
  readonly representativeCounts: {
    readonly status: DrillSectionStatus;
    readonly restoredCaptureStatus: DrillSectionStatus;
    readonly comparisonStatus: DrillSectionStatus;
    readonly failedTables: readonly string[];
    readonly sourceCapture: CountCapture | null;
    readonly restoredCapture: CountCapture | null;
    readonly diff: Readonly<Record<string, number>> | null;
  };
  readonly selectedUserHistory: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly userCountConfigured: number;
    readonly usersVerified: number;
    readonly users: readonly SelectedUserHistoryEvidence[];
  };
  readonly withdrawalRecords: {
    readonly status: DrillSectionStatus;
    readonly reasonCode: string;
    readonly byState: Readonly<Record<string, number>>;
    readonly requiringLiveChainCount: number;
  };
  /** DB-side validation evidence only — not the Phase 18 full restore gate. */
  readonly restoreValidationPass: boolean;
  /** FULL_STEP2B may be true only when every mandatory section PASSes. */
  readonly fullRestoreGatePass: boolean;
  /** Always false in restore-drill — Owner ceremony required to resume. */
  readonly payoutResumeAllowed: boolean;
  readonly resumeDecision: 'OWNER_APPROVAL_REQUIRED';
  readonly autoUnpause: false;
  readonly autoResend: false;
  readonly financialAuthority: false;
  readonly notes: readonly string[];
}
