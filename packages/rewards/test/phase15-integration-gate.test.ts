/**
 * Phase 15 Step 8 — integration gate smoke (no production seeds / no money invent).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  computeReferralBonusAtomic,
  referralBonusSourceIdFromOrigin,
} from '../src/index.js';

const repoRoot = join(import.meta.dirname, '../../..');

describe('Phase 15 integration gate invariants', () => {
  it('referral arithmetic remains integer FLOOR', () => {
    expect(computeReferralBonusAtomic({ sourceAmountAtomic: '10000', effectiveRateBps: 123 })).toBe(
      123n,
    );
    expect(computeReferralBonusAtomic({ sourceAmountAtomic: '19', effectiveRateBps: 123 })).toBe(0n);
  });

  it('deterministic referral source ids are stable', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(referralBonusSourceIdFromOrigin(id)).toBe(referralBonusSourceIdFromOrigin(id));
  });

  it('referrals package source never imports ledger', () => {
    const srcRoot = join(repoRoot, 'packages/referrals/src');
    const files = ['index.ts', 'code-policy.ts', 'effective-rate.ts', 'activation.ts', 'attribution.ts'];
    for (const file of files) {
      const text = readFileSync(join(srcRoot, file), 'utf8');
      expect(text).not.toMatch(/@alex-rewards\/ledger/);
    }
  });

  it('migrations do not seed production 500/700 referral rates or daily caps', () => {
    for (const name of [
      '0044_phase15_referral_rule_integrity.sql',
      '0045_phase15_referral_reference_hardening.sql',
      '0046_phase15_referral_rate_provenance.sql',
      '0047_phase15_referral_reward_issuance.sql',
      '0048_phase15_referral_code_policy.sql',
    ]) {
      const sql = readFileSync(join(repoRoot, 'migrations', name), 'utf8');
      expect(sql).not.toMatch(/base_rate_bps\s*,\s*500\b|VALUES\s*\([^)]*\b500\b/);
      expect(sql).not.toMatch(/\b700\b.*base_rate|base_rate.*\b700\b/);
      expect(sql.toLowerCase()).not.toMatch(/insert into referral_rule_versions/);
      expect(sql.toLowerCase()).not.toMatch(/insert into referral_code_policy_versions/);
      expect(sql.toLowerCase()).not.toMatch(
        /insert into economic_exposure_limits[\s\S]*max_referral_bonus_daily/,
      );
    }
  });
});
