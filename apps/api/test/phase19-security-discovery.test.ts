/**
 * Phase 19 Step 1 — pre-Mainnet security discovery proofs (source contracts).
 *
 * These tests document verified controls AND open finding proofs without
 * changing product behavior. Finding proofs assert current gap existence so
 * CI remains green during discovery; remediation steps must invert them.
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
  // Capture until the next method at class indentation or end of class-ish block.
  const from = source.slice(start);
  const next = from.slice(marker.length).search(/\n  (async |[a-zA-Z].*\()/);
  const body = next < 0 ? from : from.slice(0, marker.length + next);
  return body;
}

describe('Phase 19 security discovery — Category 1 membership claim issue', () => {
  const src = readAdmin('memberships-admin.controller.ts');

  it('P19 control: grantFounder requires gate + consumed confirmation', () => {
    const grant = extractMethod(src, 'grantFounder');
    expect(grant).toMatch(/gateHighImpactMutation/);
    expect(grant).toMatch(/requireConsumedConfirmation/);
    expect(grant).toMatch(/memberships\.founder_grant/);
  });

  it('P19-SEC-001 proof: issueClaimCode uses gate but omits requireConsumedConfirmation', () => {
    const issue = extractMethod(src, 'issueClaimCode');
    expect(issue).toMatch(/gateHighImpactMutation/);
    expect(issue).not.toMatch(/requireConsumedConfirmation/);
    expect(issue).not.toMatch(/confirmationId/);
  });
});

describe('Phase 19 security discovery — Category 6/9 Policy Center vs Feature Flags', () => {
  const policy = readAdmin('policy-center.controller.ts');
  const flags = readAdmin('feature-flags.controller.ts');

  it('P19 control: dedicated Feature Flags path versions + audits + silent-flip refuse', () => {
    expect(flags).toMatch(/feature_flag_versions/);
    expect(flags).toMatch(/audit_logs/);
    expect(flags).toMatch(/PAYOUT_DISPATCH_PAUSE/);
    expect(flags).toMatch(/silent flip refused|silent\)\$/i);
  });

  it('P19-SEC-009 proof: Policy Center FEATURE_FLAGS applies setFeatureFlagEnabled without version table write', () => {
    expect(policy).toMatch(/family === 'FEATURE_FLAGS'/);
    expect(policy).toMatch(/setFeatureFlagEnabled/);
    expect(policy).toMatch(/applied: true/);
    // Dedicated invariants absent from policy controller source.
    expect(policy).not.toMatch(/INSERT INTO feature_flag_versions/);
    expect(policy).not.toMatch(/silent flip refused/);
  });

  it('P19 control: Policy Center returns applied=false for REWARD_RULES family path', () => {
    expect(policy).toMatch(/PROVIDER_LIMITS \/ REWARD_RULES/);
    expect(policy).toMatch(/applied: false/);
  });
});

describe('Phase 19 security discovery — Category 10 Review Queue', () => {
  const rq = readAdmin('review-queue.controller.ts');

  it('P19 control: non-resolve actions declare ledgerWrite false', () => {
    expect(rq).toMatch(/ledgerWrite: false/);
  });

  it('P19-SEC-017 proof: RESOLVE_AFTER_DOMAIN hardcodes domainSucceeded true', () => {
    const idx = rq.indexOf("case 'RESOLVE_AFTER_DOMAIN'");
    expect(idx).toBeGreaterThanOrEqual(0);
    const slice = rq.slice(idx, idx + 700);
    expect(slice).toMatch(/domainSucceeded:\s*true/);
    expect(slice).toMatch(/ADMIN_API_RESOLVE_AFTER_DOMAIN/);
    // No evidence lookup / domain command verify in this branch.
    expect(slice).not.toMatch(/domainEvidence|verifyDomain|domainCommandId|assertDomainSucceeded/);
  });
});

describe('Phase 19 security discovery — Category 4/5 provider trust markers', () => {
  it('AdsGram webhook controller keeps rewardCredited false in source', () => {
    const wh = readFileSync(
      join(apiRoot, 'src', 'ads', 'adsgram-webhook.controller.ts'),
      'utf8',
    );
    expect(wh).toMatch(/rewardCredited:\s*false/);
  });
});
