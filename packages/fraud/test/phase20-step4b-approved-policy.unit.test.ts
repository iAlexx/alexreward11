/**
 * Phase 20 Step 4B — Owner-approved Closed Beta policy static + pure-engine validation.
 * No DB. No activation.
 */
import { describe, expect, it } from 'vitest';

import {
  COLLECTOR_SIGNAL_CODES,
  evaluateRiskSignals,
  evaluateTrustSignals,
  parseEligibilityPolicyConfig,
  parseTrustPolicyConfig,
  resolveEligibilityFeatureFlagBinding,
  validateRiskRuleConfig,
  type RiskRuleVersion,
  type TrustSignalFact,
} from '../src/index.js';
import { loadPhase20OwnerApprovedPolicy } from './load-phase20-approved-policy.js';

const artifact = loadPhase20OwnerApprovedPolicy();

function riskRule(): RiskRuleVersion {
  const cfg = validateRiskRuleConfig({
    thresholds: artifact.risk.thresholds,
    signalWeights: artifact.risk.signalWeights,
    signalParams: artifact.risk.signalParams,
    actions: artifact.risk.actions,
  });
  return {
    id: '00000000-0000-4000-8000-000000000001',
    ruleVersion: 20,
    thresholds: cfg.thresholds,
    signalWeights: cfg.signalWeights,
    signalParams: cfg.signalParams,
    actions: cfg.actions,
    status: 'ACTIVE',
    effectiveFrom: new Date('2020-01-01T00:00:00.000Z'),
    effectiveTo: null,
    reason: 'phase20-step4b-approved',
    auditReference: null,
  };
}

function facts(active: readonly string[]) {
  const weights = artifact.risk.signalWeights;
  return Object.keys(weights)
    .sort()
    .map((code) => ({
      code,
      active: active.includes(code),
      reasonCode: active.includes(code) ? `${code}_ACTIVE` : `${code}_INACTIVE`,
    }));
}

describe('Phase 20 Step 4B approved policy static check', () => {
  it('artifact refuses activationAuthorized and keeps exact identity', () => {
    expect(artifact.artifactId).toBe('PHASE20_CLOSED_BETA_OWNER_APPROVED_POLICY');
    expect(artifact.status).toBe('OWNER_APPROVED_STAGING_CANDIDATE');
    expect(artifact.activationAuthorized).toBe(false);
    expect(artifact.phase).toBe(20);
  });

  it('parses Risk/Trust/Eligibility through authoritative parsers', () => {
    expect(() =>
      validateRiskRuleConfig({
        thresholds: artifact.risk.thresholds,
        signalWeights: artifact.risk.signalWeights,
        signalParams: artifact.risk.signalParams,
        actions: artifact.risk.actions,
      }),
    ).not.toThrow();
    expect(() => parseTrustPolicyConfig(artifact.trust)).not.toThrow();
    expect(() => parseEligibilityPolicyConfig(artifact.eligibility)).not.toThrow();
  });

  it('uses only collector-supported risk signals and exact Owner weights', () => {
    const supported = new Set<string>(COLLECTOR_SIGNAL_CODES);
    expect(artifact.risk.signalWeights).toEqual({
      OPEN_HIGH_FRAUD_FLAG: 55,
      OPEN_CRITICAL_FRAUD_FLAG: 80,
      CONFIRMED_FRAUD_FLAG: 60,
      SHARED_PAYOUT_WALLET: 35,
      SHARED_DEVICE_SIGNAL: 25,
      SHARED_NETWORK_SIGNAL: 20,
      NETWORK_COUNTRY_CHANGED: 15,
    });
    for (const code of Object.keys(artifact.risk.signalWeights)) {
      expect(supported.has(code)).toBe(true);
    }
    expect(artifact.risk.signalParams).toEqual({});
    expect(artifact.risk.signalWeights).not.toHaveProperty('AD_REVERSED_REWARD_HISTORY');
    expect(artifact.risk.signalWeights).not.toHaveProperty('REFERRAL_REJECTED_EDGE_HISTORY');
  });

  it('eligibility has no REFERRAL_ACTIVATION/MEMBERSHIP_CLAIM and no unsupported FEATURE_FLAG gates', () => {
    const eligibility = parseEligibilityPolicyConfig(artifact.eligibility);
    expect(eligibility.actions.REFERRAL_ACTIVATION).toBeUndefined();
    expect(eligibility.actions.MEMBERSHIP_CLAIM).toBeUndefined();
    for (const [actionType, cfg] of Object.entries(eligibility.actions)) {
      if (cfg?.requiredGates.includes('FEATURE_FLAG')) {
        expect(resolveEligibilityFeatureFlagBinding(actionType as never).kind).not.toBe(
          'unsupported',
        );
      }
    }
  });

  it('exact approved risk thresholds/actions and trust 25/25/25/25 + 25/50/75', () => {
    expect(artifact.risk.thresholds).toEqual({ lowMax: 20, mediumMax: 50, highMax: 75 });
    expect(artifact.risk.actions).toEqual({
      LOW: 'MANUAL_REVIEW',
      MEDIUM: 'MANUAL_REVIEW',
      HIGH: 'HELD',
      CRITICAL: 'WITHDRAWAL_BLOCKED',
    });
    const trust = parseTrustPolicyConfig(artifact.trust);
    expect(trust.signals).toEqual({
      ACCOUNT_AGE: { weight: 25, minDays: 1 },
      VERIFIED_PRIMARY_WALLET_AGE: { weight: 25, minDays: 1 },
      REWARDED_AD_HISTORY: { weight: 25, minCount: 1 },
      CONFIRMED_PAYOUT_HISTORY: { weight: 25, minCount: 1 },
    });
    expect(trust.stateThresholds).toEqual({
      basicMin: 25,
      establishedMin: 50,
      trustedMin: 75,
    });
  });
});

describe('Phase 20 Step 4B approved risk outcome matrix', () => {
  const rule = riskRule();
  const allow = new Set(['ALLOW', 'EXTEND_PENDING', 'MANUAL_REVIEW']);

  it('no signals → LOW / MANUAL_REVIEW (eligibility allow)', () => {
    const r = evaluateRiskSignals(rule, facts([]));
    expect(r).toMatchObject({ score: 0, riskTier: 'LOW', action: 'MANUAL_REVIEW', neverAutoBan: true });
    expect(allow.has(r.action)).toBe(true);
  });

  it('OPEN_HIGH alone → HIGH / HELD (block)', () => {
    const r = evaluateRiskSignals(rule, facts(['OPEN_HIGH_FRAUD_FLAG']));
    expect(r).toMatchObject({ score: 55, riskTier: 'HIGH', action: 'HELD' });
    expect(allow.has(r.action)).toBe(false);
  });

  it('OPEN_CRITICAL alone → CRITICAL / WITHDRAWAL_BLOCKED (block)', () => {
    const r = evaluateRiskSignals(rule, facts(['OPEN_CRITICAL_FRAUD_FLAG']));
    expect(r).toMatchObject({ score: 80, riskTier: 'CRITICAL', action: 'WITHDRAWAL_BLOCKED' });
    expect(allow.has(r.action)).toBe(false);
  });

  it('CONFIRMED_FRAUD alone → HIGH / HELD (block)', () => {
    const r = evaluateRiskSignals(rule, facts(['CONFIRMED_FRAUD_FLAG']));
    expect(r).toMatchObject({ score: 60, riskTier: 'HIGH', action: 'HELD' });
  });

  it('SHARED_PAYOUT alone → MEDIUM / MANUAL_REVIEW (allow)', () => {
    const r = evaluateRiskSignals(rule, facts(['SHARED_PAYOUT_WALLET']));
    expect(r).toMatchObject({ score: 35, riskTier: 'MEDIUM', action: 'MANUAL_REVIEW' });
    expect(allow.has(r.action)).toBe(true);
  });

  it('SHARED_DEVICE alone → MEDIUM / MANUAL_REVIEW', () => {
    expect(evaluateRiskSignals(rule, facts(['SHARED_DEVICE_SIGNAL']))).toMatchObject({
      score: 25,
      riskTier: 'MEDIUM',
      action: 'MANUAL_REVIEW',
    });
  });

  it('SHARED_NETWORK alone → LOW / MANUAL_REVIEW (no auto-block)', () => {
    expect(evaluateRiskSignals(rule, facts(['SHARED_NETWORK_SIGNAL']))).toMatchObject({
      score: 20,
      riskTier: 'LOW',
      action: 'MANUAL_REVIEW',
    });
  });

  it('NETWORK_COUNTRY_CHANGED alone → LOW / MANUAL_REVIEW (no auto-ban)', () => {
    expect(evaluateRiskSignals(rule, facts(['NETWORK_COUNTRY_CHANGED']))).toMatchObject({
      score: 15,
      riskTier: 'LOW',
      action: 'MANUAL_REVIEW',
    });
  });
});

describe('Phase 20 Step 4B approved trust scoring', () => {
  const policy = parseTrustPolicyConfig(artifact.trust);

  function tf(satisfied: Readonly<Record<string, boolean>>): TrustSignalFact[] {
    return Object.keys(policy.signals)
      .sort()
      .map((code) => ({
        code,
        satisfied: satisfied[code] === true,
        reasonCode: satisfied[code] ? `${code}_MET` : `${code}_NOT_MET`,
      }));
  }

  it('brand-new → NEW score 0', () => {
    expect(evaluateTrustSignals(policy, tf({}))).toMatchObject({ score: 0, trustState: 'NEW' });
  });

  it('account age only → BASIC score 25', () => {
    expect(evaluateTrustSignals(policy, tf({ ACCOUNT_AGE: true }))).toMatchObject({
      score: 25,
      trustState: 'BASIC',
    });
  });

  it('age + wallet → ESTABLISHED score 50 (not TRUSTED)', () => {
    expect(
      evaluateTrustSignals(
        policy,
        tf({ ACCOUNT_AGE: true, VERIFIED_PRIMARY_WALLET_AGE: true }),
      ),
    ).toMatchObject({ score: 50, trustState: 'ESTABLISHED' });
  });

  it('age + wallet + rewarded ad → TRUSTED score 75', () => {
    expect(
      evaluateTrustSignals(
        policy,
        tf({
          ACCOUNT_AGE: true,
          VERIFIED_PRIMARY_WALLET_AGE: true,
          REWARDED_AD_HISTORY: true,
        }),
      ),
    ).toMatchObject({ score: 75, trustState: 'TRUSTED' });
  });
});