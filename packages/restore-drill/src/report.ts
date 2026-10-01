import type { RestoreDrillReport } from './types.js';

export function renderRestoreDrillMarkdown(report: RestoreDrillReport): string {
  const lines = [
    `# Phase 18 Restore Drill Report`,
    ``,
    `- contractVersion: ${report.contractVersion}`,
    `- mode: ${report.mode}`,
    `- observedAt: ${report.observedAt}`,
    `- restoreValidationPass: ${report.restoreValidationPass}`,
    `- payoutResumeAllowed: ${report.payoutResumeAllowed}`,
    `- autoUnpause: ${report.autoUnpause}`,
    `- autoResend: ${report.autoResend}`,
    ``,
    `## Target`,
    `- currentDatabase: ${report.target.currentDatabase}`,
    `- expectedDatabase: ${report.target.expectedDatabase}`,
    `- redactedTargetSummary: ${report.target.redactedTargetSummary}`,
    `- schemaMigrationHead: ${report.target.schemaMigrationHead ?? 'null'}`,
    ``,
    `## Gates`,
    `- schema: ${report.schema.status} (${report.schema.reasonCode})`,
    `- payoutPause: ${report.payoutDispatchPause.status} paused=${String(report.payoutDispatchPause.payoutDispatchPausedAtValidation)}`,
    `- ledger: ${report.ledgerInvariants.status} critical=${report.ledgerInvariants.criticalCount}`,
    `- withdrawalRestore: ${report.withdrawalRestoreReconcile.status} danger=${report.withdrawalRestoreReconcile.dangerousCount}`,
    `- outbox: ${report.outbox.status} pending=${report.outbox.pending}`,
    `- workflow: ${report.workflowReconciliation.status} (${report.workflowReconciliation.reasonCode})`,
    `- blockchain: ${report.blockchainReconciliation.status} (${report.blockchainReconciliation.reasonCode})`,
    `- selectedUserHistory: ${report.selectedUserHistory.status}`,
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
