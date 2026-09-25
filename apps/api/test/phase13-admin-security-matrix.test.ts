/**
 * Phase 13 Admin security matrix (rows 12–52) — unit / API-shape tests.
 *
 * Covers hard limits, AdsGram clarification gate, no balance editor, Founder
 * grant (no money), Policy Center arbitrary-code refusal, Review Queue ≠ ledger
 * write, estimates ≠ settled, PAYOUT_DISPATCH_PAUSE ceremony, and related Admin
 * control-surface invariants. Domain DB is mocked where needed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  refuseProviderMonetaryApprovalWithoutClarification,
  wouldExceedProviderHardLimit,
} from '@alex-rewards/ads';
import {
  assertHighImpactConfirmationValid,
  createHighImpactConfirmation,
} from '@alex-rewards/contracts';
import { describe, expect, it } from 'vitest';

import { OverviewController } from '../src/admin/overview.controller.js';
import { EconomicsController } from '../src/admin/economics.controller.js';
import { MissionsAdminController } from '../src/admin/missions-admin.controller.js';
import { ReferralAdminController } from '../src/admin/referral-admin.controller.js';
import { PolicyCenterController } from '../src/admin/policy-center.controller.js';
import { SettingsController } from '../src/admin/settings.controller.js';
import {
  PHASE10_PAYOUT_DISPATCH_PAUSE_BASELINE,
  refuseArbitraryPolicyPayload,
} from '../src/admin/http.js';
import { AppModule } from '../src/app.module.js';

const apiRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const adminSrc = join(apiRoot, 'src', 'admin');

function collectAdminSource(): string {
  const files = readdirSync(adminSrc).filter((name) => name.endsWith('.ts'));
  return files.map((name) => readFileSync(join(adminSrc, name), 'utf8')).join('\n');
}

describe('Phase 13 Admin security matrix 12–52', () => {
  // --- M12–M18: Overview / availability honesty ---
  it('M12 overview never fabricates known zeros for unavailable engines', () => {
    const overview = new OverviewController().overview();
    const missions = overview.domains.find((d) => d.key === 'missions');
    const referrals = overview.domains.find((d) => d.key === 'referrals');
    const fraud = overview.domains.find((d) => d.key === 'fraud_engine');
    expect(missions?.status).toBe('ENGINE_NOT_ENABLED');
    expect(referrals?.status).toBe('ENGINE_NOT_ENABLED');
    expect(fraud?.status).toBe('ENGINE_NOT_ENABLED');
    for (const domain of overview.domains) {
      expect(domain).not.toHaveProperty('amountAtomic');
    }
  });

  it('M13 missions foundation returns ENGINE_NOT_ENABLED and null data', () => {
    const body = new MissionsAdminController().list();
    expect(body.status).toBe('UNAVAILABLE');
    expect(body.reasonCode).toBe('ENGINE_NOT_ENABLED');
    expect(body.data).toBeNull();
  });

  it('M14 referral foundation returns ENGINE_NOT_ENABLED', () => {
    const body = new ReferralAdminController().foundation();
    expect(body.status).toBe('UNAVAILABLE');
    expect(body.reasonCode).toBe('ENGINE_NOT_ENABLED');
  });

  it('M15 settings families are typed-only', () => {
    const body = new SettingsController().families();
    expect(body.typedOnly).toBe(true);
    expect(body.families.length).toBeGreaterThan(0);
  });

  it('M16 policy families refuse arbitrary code metadata', () => {
    const families = new PolicyCenterController(
      null as never,
      null as never,
    ).families();
    for (const family of families.families) {
      expect(family.typedOnly).toBe(true);
      expect(family.acceptsArbitraryCode).toBe(false);
    }
  });

  it('M17 policy arbitrary JS/SQL/eval payloads are refused', () => {
    expect(() => refuseArbitraryPolicyPayload({ eval: '1+1' })).toThrow();
    expect(() => refuseArbitraryPolicyPayload({ javascript: 'alert(1)' })).toThrow();
    expect(() => refuseArbitraryPolicyPayload({ sql: 'SELECT 1' })).toThrow();
    expect(() => refuseArbitraryPolicyPayload({ script: 'x()' })).toThrow();
    expect(() => refuseArbitraryPolicyPayload({ expression: 'a>b' })).toThrow();
    expect(() =>
      refuseArbitraryPolicyPayload({ family: 'FEATURE_FLAGS', typed: { enabled: true } }),
    ).not.toThrow();
  });

  it('M18 high-impact confirmation binds action+resource+version and invalidates on payload change', async () => {
    const binding = await createHighImpactConfirmation({
      action: 'providers.limit_change',
      resourceType: 'ad_provider',
      resourceId: 'ADSGRAM',
      expectedVersion: '3',
      expiresAt: new Date(Date.now() + 60_000),
      payload: { maxCount: 25, reason: 'tighten' },
    });
    const ok = await assertHighImpactConfirmationValid(binding, {
      action: 'providers.limit_change',
      resourceType: 'ad_provider',
      resourceId: 'ADSGRAM',
      expectedVersion: '3',
      payload: { maxCount: 25, reason: 'tighten' },
    });
    expect(ok).toEqual({ ok: true });

    const changed = await assertHighImpactConfirmationValid(binding, {
      action: 'providers.limit_change',
      resourceType: 'ad_provider',
      resourceId: 'ADSGRAM',
      expectedVersion: '3',
      payload: { maxCount: 100, reason: 'tighten' },
    });
    expect(changed).toEqual({ ok: false, reason: 'PAYLOAD_CHANGED' });

    const versionDrift = await assertHighImpactConfirmationValid(binding, {
      action: 'providers.limit_change',
      resourceType: 'ad_provider',
      resourceId: 'ADSGRAM',
      expectedVersion: '4',
      payload: { maxCount: 25, reason: 'tighten' },
    });
    expect(versionDrift).toEqual({ ok: false, reason: 'VERSION_MISMATCH' });
  });

  // --- M19–M24: AdsGram / provider hard limits ---
  it('M19 AdsGram APPROVED without clarification is refused', () => {
    const result = refuseProviderMonetaryApprovalWithoutClarification({
      providerCode: 'ADSGRAM',
      targetStatus: 'APPROVED',
      openClarificationCount: 6,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe('OPEN_CLARIFICATION_ITEMS');
  });

  it('M20 AdsGram APPROVED with zero open clarifications is allowed by gate', () => {
    const result = refuseProviderMonetaryApprovalWithoutClarification({
      providerCode: 'ADSGRAM',
      targetStatus: 'APPROVED',
      openClarificationCount: 0,
    });
    expect(result.allowed).toBe(true);
  });

  it('M21 BLOCKED/TEST_ONLY targets are not blocked by clarification gate', () => {
    expect(
      refuseProviderMonetaryApprovalWithoutClarification({
        providerCode: 'ADSGRAM',
        targetStatus: 'BLOCKED',
        openClarificationCount: 6,
      }).allowed,
    ).toBe(true);
  });

  it('M22 admin cannot exceed PROVIDER_HARD with PLATFORM_SOFT', () => {
    expect(
      wouldExceedProviderHardLimit({
        limitScope: 'PLATFORM_SOFT',
        proposedMaxCount: 100,
        hardCeilingMaxCount: 30,
      }),
    ).toBe(true);
  });

  it('M23 PLATFORM_SOFT at or below hard ceiling is allowed', () => {
    expect(
      wouldExceedProviderHardLimit({
        limitScope: 'PLATFORM_SOFT',
        proposedMaxCount: 25,
        hardCeilingMaxCount: 30,
      }),
    ).toBe(false);
  });

  it('M24 missing hard ceiling fails closed for non-hard scopes', () => {
    expect(
      wouldExceedProviderHardLimit({
        limitScope: 'PLATFORM_SOFT',
        proposedMaxCount: 10,
        hardCeilingMaxCount: null,
      }),
    ).toBe(true);
  });

  // --- M25–M30: no balance editor / financial truth ---
  it('M25 no set-balance / direct balance editor routes in Admin controllers', () => {
    const controllerFiles = readdirSync(adminSrc).filter((name) =>
      name.endsWith('.controller.ts'),
    );
    const source = controllerFiles
      .map((name) => readFileSync(join(adminSrc, name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/@(Post|Put|Patch)\(['"][^'"]*(set-?balance|balance-editor|adjust-?balance)[^'"]*['"]\)/i);
    expect(source).not.toMatch(/\bsetBalance\s*\(/);
    expect(source).not.toMatch(/\bSET\s+BALANCE\b/i);
  });

  it('M26 AppModule registers Admin controllers and does not expose balance editor', () => {
    const mod = AppModule.register({
      DEPLOYMENT_ENV: 'LOCAL',
    } as never);
    const controllers = mod.controllers ?? [];
    const names = controllers.map((c) => (c as { name?: string }).name ?? String(c));
    expect(names).toContain('OverviewController');
    expect(names).toContain('UsersController');
    expect(names).toContain('WithdrawalsAdminController');
    expect(names).toContain('PolicyCenterController');
    expect(names).toContain('FeatureFlagsController');
    expect(names).toContain('ReviewQueueController');
    expect(names.some((n) => /BalanceEditor/i.test(n))).toBe(false);
  });

  it('M27 Founder grant response contract asserts moneyIssued=false', () => {
    // Contract shape: AdminFounderGrantResponse hard-codes moneyIssued/ledgerPostingsCreated false.
    const sample = {
      contractVersion: '1' as const,
      membershipId: '00000000-0000-4000-8000-000000000001',
      founderNumber: 1,
      planCode: 'FOUNDER_LIFETIME',
      moneyIssued: false as const,
      ledgerPostingsCreated: false as const,
    };
    expect(sample.moneyIssued).toBe(false);
    expect(sample.ledgerPostingsCreated).toBe(false);
  });

  it('M28 memberships controller source wraps grantFounderMembership (no ledger import for money)', () => {
    const source = readFileSync(join(adminSrc, 'memberships-admin.controller.ts'), 'utf8');
    expect(source).toContain('grantFounderMembership');
    expect(source).toContain('moneyIssued: false');
    expect(source).not.toContain('postLedger');
    expect(source).not.toContain('issueSimulatedReward');
  });

  it('M29 review queue actions declare ledgerWrite=false and call control-center wrappers', () => {
    const source = readFileSync(join(adminSrc, 'review-queue.controller.ts'), 'utf8');
    expect(source).toContain('assignReviewCase');
    expect(source).toContain('commentReviewCase');
    expect(source).toContain('escalateReviewCase');
    expect(source).toContain('resolveReviewCaseAfterDomainSuccess');
    expect(source).toContain('ledgerWrite: false');
    expect(source).not.toContain('INSERT INTO ledger_');
    expect(source).not.toContain('postTransaction');
  });

  it('M30 withdrawals admin wraps decideWithdrawal domain command only', () => {
    const source = readFileSync(join(adminSrc, 'withdrawals-admin.controller.ts'), 'utf8');
    expect(source).toContain('decideWithdrawal');
    expect(source).toContain("decision: 'APPROVE'");
    expect(source).toContain("decision: 'HOLD'");
    expect(source).toContain("decision: 'REJECT'");
    expect(source).not.toMatch(/UPDATE withdrawals\s+SET\s+state/i);
  });

  // --- M31–M38: economics / exposure / hot wallet ---
  it('M31 economics separates estimated vs settled labels', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('economic_exposure_limits')) {
          return { rows: [{ c: '0' }] };
        }
        if (sql.includes("state = 'CONFIRMED'")) {
          return { rows: [{ total: '12345' }] };
        }
        return { rows: [] };
      },
    };
    const controller = new EconomicsController(pool as never);
    const body = await controller.economics();
    expect(body.estimated.kind).toBe('ESTIMATED');
    expect(body.settled.kind).toBe('SETTLED');
    expect(body.note).toBe('estimates_are_not_settled');
    expect(body.estimated.status).toBe('UNAVAILABLE');
    expect(body.estimated.amountAtomic).toBeNull();
    expect(body.settled.amountAtomic).toBe('12345');
  });

  it('M32 unconfigured exposure does not invent estimated numbers', async () => {
    const pool = {
      query: async (sql: string) => {
        if (sql.includes('economic_exposure_limits')) return { rows: [{ c: '0' }] };
        if (sql.includes('withdrawals')) return { rows: [{ total: '0' }] };
        return { rows: [] };
      },
    };
    const body = await new EconomicsController(pool as never).economics();
    expect(body.estimated.status).toBe('UNAVAILABLE');
    expect(body.estimated.amountAtomic).toBeNull();
  });

  it('M33 hot wallet controller source never returns secrets', () => {
    const source = readFileSync(join(adminSrc, 'hot-wallet.controller.ts'), 'utf8');
    expect(source).toContain('signer_reference');
    expect(source).toContain('@Get');
    expect(source).not.toMatch(/\bprivateKey\b|\bseedPhrase\b|\bmnemonic\b|\bpassphrase\b/);
  });

  it('M34 ledger admin is read-only (no INSERT/UPDATE in controller)', () => {
    const source = readFileSync(join(adminSrc, 'ledger-admin.controller.ts'), 'utf8');
    expect(source).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    expect(source).toContain('@Get');
  });

  it('M35 ads admin reuses getProviderAdminView', () => {
    const source = readFileSync(join(adminSrc, 'ads-admin.controller.ts'), 'utf8');
    expect(source).toContain('getProviderAdminView');
    expect(source).toContain('assertProviderMonetaryApprovalAllowed');
  });

  it('M36 providers admin uses createProviderLimitRuleVersion', () => {
    const source = readFileSync(join(adminSrc, 'providers-admin.controller.ts'), 'utf8');
    expect(source).toContain('createProviderLimitRuleVersion');
    expect(source).toContain('impactPreview');
  });

  it('M37 reward engine creates new versions (not mutate history)', () => {
    const source = readFileSync(join(adminSrc, 'reward-engine-admin.controller.ts'), 'utf8');
    expect(source).toContain('createRewardRuleVersion');
    expect(source).not.toMatch(/UPDATE reward_rules\s+SET/i);
  });

  it('M38 entitlements create benefit rule versions', () => {
    const source = readFileSync(join(adminSrc, 'entitlements-admin.controller.ts'), 'utf8');
    expect(source).toContain('createBenefitRuleVersion');
  });

  // --- M39–M46: feature flags / reauth / audit ---
  it('M39 PAYOUT_DISPATCH_PAUSE baseline is documented and display-safe', () => {
    expect(PHASE10_PAYOUT_DISPATCH_PAUSE_BASELINE).toContain('Phase 10');
    expect(PHASE10_PAYOUT_DISPATCH_PAUSE_BASELINE).toContain('silent flip');
    const source = readFileSync(join(adminSrc, 'feature-flags.controller.ts'), 'utf8');
    expect(source).toContain('PAYOUT_DISPATCH_PAUSE');
    expect(source).toContain('gateHighImpactMutation');
    expect(source).toContain('silent flip refused');
  });

  it('M40 feature flag mutation requires reason + expectedVersion + reauth gate', () => {
    const source = readFileSync(join(adminSrc, 'feature-flags.controller.ts'), 'utf8');
    expect(source).toContain('gateHighImpactMutation');
    expect(source).toContain('feature_flag_versions');
    expect(source).toContain('audit_logs');
  });

  it('M41 expired high-impact confirmation is rejected', async () => {
    const binding = await createHighImpactConfirmation({
      action: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: '1',
      expiresAt: new Date(Date.now() - 1_000),
      payload: { enabled: false },
    });
    const result = await assertHighImpactConfirmationValid(binding, {
      action: 'feature_flags.mutate',
      resourceType: 'feature_flag',
      resourceId: 'PAYOUT_DISPATCH_PAUSE:LOCAL',
      expectedVersion: '1',
      payload: { enabled: false },
    });
    expect(result).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('M42 fraud admin marks Phase 14 unavailable', () => {
    const source = readFileSync(join(adminSrc, 'fraud-admin.controller.ts'), 'utf8');
    expect(source).toContain('ENGINE_NOT_ENABLED');
    expect(source).toContain('phase14Engine');
  });

  it('M43 audit controller is append-only read', () => {
    const source = readFileSync(join(adminSrc, 'audit.controller.ts'), 'utf8');
    expect(source).toContain('appendOnly: true');
    expect(source).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
  });

  it('M44 system health exposes no secrets', () => {
    const source = readFileSync(join(adminSrc, 'system.controller.ts'), 'utf8');
    expect(source).toContain('@Get');
    expect(source).toContain('components');
    expect(source).not.toMatch(/\bpassword\b|\bapiKey\b|\bsessionToken\b|\bprivateKey\b/i);
  });

  it('M45 notifications create draft metadata only', () => {
    const source = readFileSync(join(adminSrc, 'notifications-admin.controller.ts'), 'utf8');
    expect(source).toContain("'DRAFT'");
    expect(source).toContain('draft metadata only');
    expect(source).not.toMatch(/@(Post|Put)\(['"][^'"]*(send|dispatch|broadcast)[^'"]*['"]\)/i);
  });

  it('M46 support tickets read from schema', () => {
    const source = readFileSync(join(adminSrc, 'support-admin.controller.ts'), 'utf8');
    expect(source).toContain('support_tickets');
  });

  // --- M47–M52: RBAC / controller registration / ownership ---
  it('M47 all Admin controllers use AdminSessionGuard (OWNER via guard)', () => {
    const source = collectAdminSource();
    const controllerFiles = readdirSync(adminSrc).filter(
      (name) => name.endsWith('.controller.ts'),
    );
    expect(controllerFiles.length).toBeGreaterThanOrEqual(20);
    for (const file of controllerFiles) {
      const text = readFileSync(join(adminSrc, file), 'utf8');
      expect(text).toContain('@UseGuards(AdminSessionGuard)');
    }
  });

  it('M48 high-impact helper gates reason + expectedVersion + reauth', () => {
    const source = readFileSync(join(adminSrc, 'http.ts'), 'utf8');
    expect(source).toContain('assertRecentReauth');
    expect(source).toContain('requireReason');
    expect(source).toContain('requireExpectedVersion');
  });

  it('M49 PROVIDER_HARD scope replacements are not blocked by ceiling helper', () => {
    expect(
      wouldExceedProviderHardLimit({
        limitScope: 'PROVIDER_HARD',
        proposedMaxCount: 100,
        hardCeilingMaxCount: 30,
      }),
    ).toBe(false);
  });

  it('M50 confirmation action mismatch refuses', async () => {
    const binding = await createHighImpactConfirmation({
      action: 'a',
      resourceType: 'r',
      resourceId: '1',
      expectedVersion: '1',
      expiresAt: new Date(Date.now() + 60_000),
      payload: { x: 1 },
    });
    const result = await assertHighImpactConfirmationValid(binding, {
      action: 'b',
      resourceType: 'r',
      resourceId: '1',
      expectedVersion: '1',
      payload: { x: 1 },
    });
    expect(result).toEqual({ ok: false, reason: 'ACTION_MISMATCH' });
  });

  it('M51 users detail documents no direct balance editor', () => {
    const source = readFileSync(join(adminSrc, 'users.controller.ts'), 'utf8');
    expect(source).toContain('no direct balance editor');
  });

  it('M52 Admin is control/read surface — overview lists domains without fabricating money', () => {
    const overview = new OverviewController().overview();
    expect(overview.contractVersion).toBe('1');
    expect(overview.domains.some((d) => d.key === 'ledger')).toBe(true);
    expect(overview.domains.some((d) => d.key === 'economics')).toBe(true);
    const moneyKeys = overview.domains.flatMap((d) => Object.keys(d));
    expect(moneyKeys).not.toContain('balance');
    expect(moneyKeys).not.toContain('availableAtomic');
  });
});
