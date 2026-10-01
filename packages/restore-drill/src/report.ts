import type { RestoreDrillReport } from './types.js';

export function renderRestoreDrillMarkdown(report: RestoreDrillReport): string {
  const lines = [
    `# Phase 18 Restore Drill Report`,
    ``,
    `- contractVersion: ${report.contractVersion}`,
    `- mode: ${report.mode}`,
    `- observedAt: ${report.observedAt}`,
    `- restoreValidationPass: ${report.restoreValidationPass}`,
    `- fullRestoreGatePass: ${report.fullRestoreGatePass}`,
    `- payoutResumeAllowed: ${report.payoutResumeAllowed}`,
    `- resumeDecision: ${report.resumeDecision}`,
    `- autoUnpause: ${report.autoUnpause}`,
    `- autoResend: ${report.autoResend}`,
    ``,
    `## Target (host/service isolation)`,
    `- targetHost: ${report.target.targetHost}`,
    `- sourceHostProvided: ${String(report.target.sourceHostProvided)}`,
    `- targetDistinctFromSource: ${String(report.target.targetDistinctFromSource)}`,
    `- targetDatabaseName: ${report.target.targetDatabaseName}`,
    `- targetDatabaseNameMatchesExpected: ${String(report.target.targetDatabaseNameMatchesExpected)}`,
    `- databaseReadOnlyEnforced: ${String(report.target.databaseReadOnlyEnforced)}`,
    `- redactedTargetSummary: ${report.target.redactedTargetSummary}`,
    `- schemaMigrationHead: ${report.target.schemaMigrationHead ?? 'null'}`,
    ``,
    `## Gates`,
    `- schema: ${report.schema.status} (${report.schema.reasonCode})`,
    `- payoutPause: ${report.payoutDispatchPause.status} paused=${String(report.payoutDispatchPause.payoutDispatchPausedAtValidation)}`,
    `- ledger: ${report.ledgerInvariants.status} critical=${report.ledgerInvariants.criticalCount}`,
    `- withdrawalRestore: ${report.withdrawalRestoreReconcile.status} danger=${report.withdrawalRestoreReconcile.dangerousCount}`,
    `- outbox: ${report.outbox.status} pending=${report.outbox.pending} failed=${report.outbox.failed} deadLetter=${report.outbox.deadLetter}`,
    `- counts restored=${report.representativeCounts.restoredCaptureStatus} comparison=${report.representativeCounts.comparisonStatus}`,
    `- workflow: ${report.workflowReconciliation.status} (${report.workflowReconciliation.reasonCode}) dbExpected=${report.workflowReconciliation.dbExpectedWorkflowIdentityCount} temporalObserved=${report.workflowReconciliation.temporalObservedWorkflowCount}`,
    `- blockchain: ${report.blockchainReconciliation.status} (${report.blockchainReconciliation.reasonCode}) live=${report.blockchainReconciliation.liveChainReconciliation} providerQuery=${String(report.blockchainReconciliation.providerQueryPerformed)} scopeEmpty=${String(report.blockchainReconciliation.chainScopeEmpty)}`,
    `- selectedUserHistory: ${report.selectedUserHistory.status} verified=${report.selectedUserHistory.usersVerified}/${report.selectedUserHistory.userCountConfigured}`,
    `- withdrawalRecords: ${report.withdrawalRecords.status}`,
    ``,
    `## Timing (observations only; targets OWNER_POLICY_REQUIRED)`,
    `- observedValidationSeconds: ${String(report.timing.observedValidationSeconds)}`,
    `- observedRtoSeconds: ${String(report.timing.observedRtoSeconds)}`,
    `- observedRpoSeconds: ${String(report.timing.observedRpoSeconds)}`,
    `- rtoTargetSeconds: ${report.timing.rtoTargetSeconds}`,
    `- rpoTargetSeconds: ${report.timing.rpoTargetSeconds}`,
    ``,
    `## Notes`,
    ...report.notes.map((n) => `- ${n}`),
    ``,
  ];
  return lines.join('\n');
}

export function serializeRestoreDrillReport(report: RestoreDrillReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}