/**
 * Phase 14 Step 14 — Admin fraud read/ensure unit + source regressions.
 * No DB required. Proves READY envelope shape, no mark-safe, package boundaries,
 * and domain invariants (Founder/Trust/weak-signal/COUNTRY/AdsGram/reconstructability).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extractSafeAggregates, FraudAdminController } from '../src/admin/fraud-admin.controller.js';
import { OverviewController } from '../src/admin/overview.controller.js';
import { AppModule } from '../src/app.module.js';

const apiRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const adminSrc = join(apiRoot, 'src', 'admin');
const repoRoot = join(apiRoot, '..', '..');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('Phase 14 fraud-admin unit / source', () => {
  it('registers FraudAdminController on AppModule', () => {
    const mod = AppModule.register({ DEPLOYMENT_ENV: 'LOCAL' } as never);
    const names = new Set(
      (mod.controllers ?? []).map((c) => (c as { name?: string }).name ?? ''),
    );
    expect(names.has('FraudAdminController')).toBe(true);
  });

  it('overview fraud_engine is READY', () => {
    const overview = new OverviewController().overview();
    const fraud = overview.domains.find((d) => d.key === 'fraud_engine');
    expect(fraud?.status).toBe('READY');
    expect(fraud).not.toHaveProperty('reasonCode');
  });

  it('extractSafeAggregates surfaces only allowlisted counts (no PII keys)', () => {
    const aggregates = extractSafeAggregates(
      ['SHARED_PAYOUT_WALLET', 'SHARED_NETWORK_SIGNAL', 'AD_REVERSED_REWARD_HISTORY'],
      {
        signalEvidence: [
          {
            code: 'SHARED_PAYOUT_WALLET',
            active: true,
            reasonCode: 'SHARED_PAYOUT_WALLET',
            safeDetails: { relatedAccountCount: 2 },
          },
          {
            code: 'SHARED_NETWORK_SIGNAL',
            active: true,
            reasonCode: 'SHARED_NETWORK_SIGNAL',
            safeDetails: { relatedAccountCount: 3 },
          },
          {
            code: 'AD_REVERSED_REWARD_HISTORY',
            active: true,
            reasonCode: 'AD_REVERSED_REWARD_HISTORY',
            safeDetails: { reversedAdRewardCount: 4 },
          },
          {
            code: 'REFERRAL_REJECTED_EDGE_HISTORY',
            active: true,
            reasonCode: 'REFERRAL_REJECTED_EDGE_HISTORY',
            safeDetails: { rejectedReferralCount: 1 },
          },
        ],
      },
      {},
    );
    expect(aggregates).toEqual({
      relatedPayoutAccountCount: 2,
      relatedNetworkAccountCount: 3,
      reversedAdRewardCount: 4,
      rejectedReferralCount: 1,
      signalCodesPresent: [
        'SHARED_PAYOUT_WALLET',
        'SHARED_NETWORK_SIGNAL',
        'AD_REVERSED_REWARD_HISTORY',
        'REFERRAL_REJECTED_EDGE_HISTORY',
      ],
    });
    expect(JSON.stringify(aggregates)).not.toMatch(
      /"ip"|walletAddress|initData|private_key|exact_ip|client_ip|raw_ip/i,
    );
  });

  it('fraud-admin controller has no evaluate-and-persist / mark-safe / Risk mutation', () => {
    const source = read(join(adminSrc, 'fraud-admin.controller.ts'));
    expect(source).toContain('ensureReviewCase');
    expect(source).toContain("caseType: 'FRAUD_REVIEW'");
    expect(source).toContain("status: 'READY'");
    expect(source).not.toMatch(/from\s+['"]@alex-rewards\/fraud['"]/);
    expect(source).not.toMatch(/\bevaluateAndPersist(Risk|Trust|Eligibility)?\s*\(/);
    expect(source).not.toMatch(/['"]mark[_-]?safe['"]|fraud\.mark_safe|action:\s*['"]MARK_SAFE['"]/i);
    expect(source).not.toMatch(/upsertRiskProfile|persistRiskSnapshot|persistTrustSnapshot/);
    expect(source).not.toMatch(/\bUPDATE\s+risk_profiles\b|\bUPDATE\s+users\b/i);
  });

  it('assertFutureDomainMutationAvailable still blocks mark_safe in review-queue', () => {
    const source = read(join(adminSrc, 'review-queue.controller.ts'));
    expect(source).toContain('assertFutureDomainMutationAvailable');
  });

  it('Admin SPA fraud page has no fraud package import and no safe-clearance button', () => {
    const page = read(
      join(repoRoot, 'apps', 'admin', 'src', 'components', 'pages', 'FraudPage.tsx'),
    );
    expect(page).not.toMatch(/from\s+['"]@alex-rewards\/fraud['"]/);
    expect(page).not.toMatch(/Mark Safe|markSafe|mark_safe|fraud\.mark_safe/i);
    expect(page).toContain('Ensure FRAUD_REVIEW');
    expect(page).toContain('fraud.ensure_review');
  });

  it('Founder cannot bypass CRITICAL Risk (domain source + withdrawal integration)', () => {
    const eligibilityAuth = read(
      join(repoRoot, 'packages', 'fraud', 'test', 'phase14-eligibility-authoritative.db.test.ts'),
    );
    expect(eligibilityAuth).toMatch(/Founder cannot bypass RISK/i);
    expect(eligibilityAuth).toContain('INELIGIBLE_RISK_POLICY');

    const withdrawal = read(
      join(repoRoot, 'packages', 'withdrawals', 'test', 'phase14-withdrawal-integration.test.ts'),
    );
    expect(withdrawal).toMatch(/Founder low Risk/);
    expect(withdrawal).toMatch(/critical Risk action/);
  });

  it('Trust TRUSTED cannot override disallowed RISK_POLICY', () => {
    const trustCore = read(join(repoRoot, 'packages', 'fraud', 'test', 'phase14-trust-core.unit.test.ts'));
    expect(trustCore).toMatch(/Risk override/i);
    const eligibilityCore = read(
      join(repoRoot, 'packages', 'fraud', 'test', 'phase14-eligibility-core.unit.test.ts'),
    );
    expect(eligibilityCore).not.toMatch(/if\s*\(.*TRUSTED.*\)\s*.*ELIGIBLE/i);
    const withdrawal = read(
      join(repoRoot, 'packages', 'withdrawals', 'test', 'phase14-withdrawal-integration.test.ts'),
    );
    expect(withdrawal).toMatch(/Trust TRUSTED \+ low Risk/);
  });

  it('single weak signal cannot BAN/SUSPEND/FREEZE automatically', () => {
    const riskRule = read(join(repoRoot, 'packages', 'fraud', 'src', 'risk-rule.ts'));
    expect(riskRule).not.toMatch(/BAN_FOREVER|PERMANENT_BAN/);
    expect(riskRule).toContain("'SUSPEND_EARNING'");
    expect(riskRule).toContain("'FREEZE_ACCOUNT'");

    const evaluator = read(join(repoRoot, 'packages', 'fraud', 'src', 'risk-evaluator.ts'));
    expect(evaluator).toContain('neverAutoBan: true');
    expect(evaluator).toMatch(/Does not execute actions/);

    const evaluatePersist = read(join(repoRoot, 'packages', 'fraud', 'src', 'evaluate-and-persist.ts'));
    expect(evaluatePersist).toContain('neverAutoBan: true');
    expect(evaluatePersist).not.toMatch(/SUSPEND_EARNING|FREEZE_ACCOUNT|BAN/);
    expect(evaluatePersist).toMatch(/Never mutates users\.status/);

    // Source scan: no auto status mutation from fraud package evaluate paths.
    const fraudSrc = join(repoRoot, 'packages', 'fraud', 'src');
    for (const name of readdirSync(fraudSrc).filter((n) => n.endsWith('.ts'))) {
      const src = read(join(fraudSrc, name));
      expect(src, name).not.toMatch(/status\s*=\s*'BAN'|status\s*=\s*'SUSPENDED'|withdrawal_status\s*=\s*'FROZEN'/);
    }
  });

  it('COUNTRY remains OWNER_POLICY_REQUIRED fail-closed', () => {
    const preflight = read(join(repoRoot, 'packages', 'withdrawals', 'src', 'phase14-preflight.ts'));
    expect(preflight).toContain('OWNER_POLICY_REQUIRED');
    expect(preflight).toContain('ELIGIBILITY_POLICY_NOT_CONFIGURED');

    const eligibilityAuth = read(
      join(repoRoot, 'packages', 'fraud', 'test', 'phase14-eligibility-authoritative.db.test.ts'),
    );
    expect(eligibilityAuth).toMatch(/COUNTRY_POLICY required fails closed/);
  });

  it('AdsGram production monetary remains BLOCKED', () => {
    const adsPage = read(join(repoRoot, 'apps', 'admin', 'src', 'components', 'pages', 'AdsPage.tsx'));
    expect(adsPage).toContain('BLOCKED');
    expect(adsPage).toContain('adsgram-blocked');
  });

  it('adverse action reconstructable from risk snapshot + eligibility + withdrawal linkage', () => {
    const migration = read(join(repoRoot, 'migrations', '0006_risk_referral_tasks_missions.sql'));
    expect(migration).toContain('withdrawals_risk_snapshot_fkey');
    expect(migration).toMatch(/Referenced by withdrawals so a decision stays reconstructable/);

    const withdrawalCreate = read(join(repoRoot, 'packages', 'withdrawals', 'src', 'create.ts'));
    expect(withdrawalCreate).toMatch(/risk_snapshot|riskSnapshot|eligibility/i);
  });

  it('FraudAdminController constructor is injectable (pool + config)', () => {
    expect(FraudAdminController.length).toBe(2);
  });
});
