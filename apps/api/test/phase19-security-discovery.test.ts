/**
 * Phase 19 Step 2A — security remediation source contracts + finding proofs.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const apiRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const adminSrc = join(apiRoot, 'src', 'admin');

function readAdmin(name: string): string {
  return readFileSync(join(adminSrc, name), 'utf8');
}

function extractMethod(source: string, methodName: string): string {
  const marker = `async ${methodName}(`;
  const start = source.indexOf(marker);
  expect(start, `method ${methodName} missing`).toBeGreaterThanOrEqual(0);
  const from = source.slice(start);
  const next = from.slice(marker.length).search(/\n  (async |[a-zA-Z].*\()/);
  return next < 0 ? from : from.slice(0, marker.length + next);
}

describe('Phase 19 security remediation — Category 1 claim-code issue', () => {
  const src = readAdmin('memberships-admin.controller.ts');

  it('P19-SEC-001 closed: issueClaimCode requires consumed confirmation', () => {
    const issue = extractMethod(src, 'issueClaimCode');
    expect(issue).toMatch(/gateHighImpactMutation/);
    expect(issue).toMatch(/requireConsumedConfirmation/);
    expect(issue).toMatch(/memberships\.founder_claim_code_issue/);
    expect(issue).toMatch(/confirmationId/);
    expect(issue).toMatch(/expiresAt/);
    expect(issue).toMatch(/issuedForReference/);
    expect(issue).toMatch(/reserveFounderNumber/);
    expect(issue).toMatch(/reason:\s*gated\.reason/);
  });

  it('P19-SEC-002 closed: grantFounder and issueClaimCode each require confirmation (route-scoped)', () => {
    expect(extractMethod(src, 'grantFounder')).toMatch(/requireConsumedConfirmation/);
    expect(extractMethod(src, 'issueClaimCode')).toMatch(/requireConsumedConfirmation/);
  });
});

describe('Phase 19 security remediation — Category 6/9 Policy Center FEATURE_FLAGS', () => {
  const policy = readAdmin('policy-center.controller.ts');
  const flags = readAdmin('feature-flags.controller.ts');

  it('P19-SEC-009 closed: Policy Center does not mutate FEATURE_FLAGS', () => {
    expect(policy).not.toMatch(/setFeatureFlagEnabled/);
    expect(policy).toMatch(/FEATURE_FLAGS/);
    expect(policy).toMatch(/applied: false/);
    expect(policy).toMatch(/use dedicated typed Admin endpoint/);
  });

  it('dedicated Feature Flags path still versions + audits + silent-flip refuse', () => {
    expect(flags).toMatch(/feature_flag_versions/);
    expect(flags).toMatch(/audit_logs/);
    expect(flags).toMatch(/PAYOUT_DISPATCH_PAUSE/);
    expect(flags).toMatch(/silent flip refused|silent\)\$/i);
  });
});

describe('Phase 19 security remediation — Category 10 Review Queue', () => {
  const rq = readAdmin('review-queue.controller.ts');

  it('P19-SEC-017 closed: Admin HTTP does not expose RESOLVE_AFTER_DOMAIN success path', () => {
    expect(rq).not.toMatch(/case 'RESOLVE_AFTER_DOMAIN'/);
    expect(rq).not.toMatch(/domainSucceeded:\s*true/);
    expect(rq).toMatch(/ASSIGN/);
    expect(rq).toMatch(/COMMENT/);
    expect(rq).toMatch(/ESCALATE/);
    expect(rq).toMatch(/assertFutureDomainMutationAvailable/);
  });
});

describe('Phase 19 security remediation — ads webhook marker', () => {
  it('AdsGram webhook controller keeps rewardCredited false', () => {
    const wh = readFileSync(join(apiRoot, 'src', 'ads', 'adsgram-webhook.controller.ts'), 'utf8');
    expect(wh).toMatch(/rewardCredited:\s*false/);
  });
});
