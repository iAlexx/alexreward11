/**
 * Phase 20 Step 2 — referral authority static proofs (no DB).
 * Confirms self-referral coverage and no hardcoded 500/700 bps rate defaults.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('Phase 20 referral authority (unit)', () => {
  it('phase15 attribution tests cover SELF_REFERRAL and ALREADY_ATTRIBUTED', () => {
    const src = readFileSync(join(here, 'phase15-attribution.db.test.ts'), 'utf8');
    expect(src).toMatch(/SELF_REFERRAL/);
    expect(src).toMatch(/ALREADY_ATTRIBUTED/);
    expect(src).toMatch(/attributeReferralCode/);
  });

  it('effective-rate source forbids hardcoded 500/700 bps defaults', () => {
    const src = readFileSync(join(here, '../src/effective-rate.ts'), 'utf8');
    expect(src).toMatch(/No hardcoded 500\/700/);
    expect(src).not.toMatch(/baseRateBps\s*[:=]\s*500\b/);
    expect(src).not.toMatch(/baseRateBps\s*[:=]\s*700\b/);
    expect(src).not.toMatch(/effectiveRateBps\s*[:=]\s*500\b/);
    expect(src).not.toMatch(/effectiveRateBps\s*[:=]\s*700\b/);
  });

  it('harness TEST_REFERRAL_BASE_RATE_BPS is not 500 or 700', () => {
    const src = readFileSync(join(here, 'harness.ts'), 'utf8');
    expect(src).toMatch(/TEST_REFERRAL_BASE_RATE_BPS\s*=\s*123/);
    expect(src).not.toMatch(/TEST_REFERRAL_BASE_RATE_BPS\s*=\s*500\b/);
    expect(src).not.toMatch(/TEST_REFERRAL_BASE_RATE_BPS\s*=\s*700\b/);
  });
});