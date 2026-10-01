import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function readDoc(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('Phase 18 documentation truth', () => {
  it('INCIDENT_RESPONSE.md is Phase 18 financial containment, not Phase 1 placeholder', () => {
    const doc = readDoc('docs/INCIDENT_RESPONSE.md');
    expect(doc).toMatch(/PHASE18_INCIDENT_RESPONSE/);
    expect(doc).toMatch(/FINANCIAL_AMBIGUITY_CONTAINMENT/);
    expect(doc).toMatch(/NO_AUTO_UNPAUSE/);
    expect(doc).toMatch(/NO_BLIND_RESEND/);
    expect(doc).not.toMatch(/Financial incident procedures are not active because Phase 1/);
  });

  it('DISASTER_RECOVERY.md records enabled PITR and completed isolated restore', () => {
    const doc = readDoc('docs/DISASTER_RECOVERY.md');
    expect(doc).toMatch(/PITR_ENABLED/);
    expect(doc).toMatch(/ISOLATED_RESTORE_DRILL_PASS/);
    expect(doc).toMatch(/FULL_TECHNICAL_RESTORE_GATE_PASS/);
    expect(doc).toMatch(/PAYOUT_RESUME_OWNER_GATED/);
    expect(doc).not.toMatch(/PITR is NOT currently enabled/);
    expect(doc).not.toMatch(/No restore drill has yet been executed/);
  });

  it('OPERATIONS_RUNBOOK.md contains all 13 Phase 18 Owner operations procedures', () => {
    const doc = readDoc('docs/OPERATIONS_RUNBOOK.md');
    expect(doc).toMatch(/PHASE18_OWNER_OPERATIONS_PROCEDURES/);
    expect(doc).toMatch(/AUTO_UNPAUSE_FALSE/);
    expect(doc).toMatch(/AUTO_RESEND_FALSE/);
    expect(doc).toMatch(/PAYOUT_PAUSE_PROCEDURE/);
    const required = [
      '### 1. Fund Hot Wallet',
      '### 2. Verify coverage',
      '### 3. Approve withdrawal',
      '### 4. Hold suspicious withdrawal',
      '### 5. Review fraud flag',
      '### 6. Pause / resume payouts',
      '### 7. Change reward rule',
      '### 8. Respond to AdsGram outage',
      '### 9. Restore backup',
      '### 10. Rotate Bot token',
      '### 11. Rotate signer',
      '### 12. Retire Hot Wallet',
      '### 13. Handle reconciliation issue',
    ];
    for (const heading of required) {
      expect(doc).toContain(heading);
    }
  });

  it('PHASE_18_OBSERVABILITY_DR_PLAN.md records Step 2B PASS with Owner-gated resume and archive pending', () => {
    const doc = readDoc('docs/PHASE_18_OBSERVABILITY_DR_PLAN.md');
    expect(doc).toMatch(/STEP2B_COMPLETED/);
    expect(doc).toMatch(/FULL_TECHNICAL_RESTORE_GATE_PASS/);
    expect(doc).toMatch(/PAYOUT_RESUME_OWNER_GATED/);
    expect(doc).toMatch(/ARCHIVE_PENDING/);
    expect(doc).toMatch(/AUTO_UNPAUSE_FALSE/);
    expect(doc).toMatch(/AUTO_RESEND_FALSE/);
    expect(doc).not.toMatch(/Step 2B planned sequence \(NOT started\)/);
    expect(doc).not.toMatch(/PITR\/infra not yet enabled/);
  });
});
