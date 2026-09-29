/**
 * Phase 16 Step 7 — integration gate invariants (no production seeds / authority matrix).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../..');

describe('Phase 16 integration gate invariants', () => {
  it('tasks package never imports rewards or ledger', () => {
    const srcRoot = join(repoRoot, 'packages/tasks/src');
    const files = readdirSync(srcRoot).filter((f) => f.endsWith('.ts'));
    for (const file of files) {
      const text = readFileSync(join(srcRoot, file), 'utf8');
      expect(text).not.toMatch(/from ['"]@alex-rewards\/ledger['"]/);
      expect(text).not.toMatch(/from ['"]@alex-rewards\/rewards['"]/);
      expect(text).not.toMatch(/import\(['"]@alex-rewards\/ledger['"]\)/);
      expect(text).not.toMatch(/import\(['"]@alex-rewards\/rewards['"]\)/);
    }
  });

  it('worker mission maintenance sequences progress before money', () => {
    const text = readFileSync(
      join(repoRoot, 'apps/worker/src/mission-maintenance.ts'),
      'utf8',
    );
    const pollerBody = text.slice(
      text.indexOf('export function createMissionMaintenancePoller'),
      text.indexOf('export function startMissionMaintenanceLoop'),
    );
    const daily = pollerBody.indexOf('handlers.processDailyLogin');
    const ad = pollerBody.indexOf('handlers.processValidAd');
    const streak = pollerBody.indexOf('handlers.processStreak');
    const claims = pollerBody.indexOf('handlers.processPendingClaims');
    const maturity = pollerBody.indexOf('handlers.processMaturity');
    expect(daily).toBeGreaterThan(-1);
    expect(ad).toBeGreaterThan(daily);
    expect(streak).toBeGreaterThan(ad);
    expect(claims).toBeGreaterThan(streak);
    expect(maturity).toBeGreaterThan(claims);
  });

  it('phase16 migrations do not seed production missions / budgets / streak / country', () => {
    for (const name of [
      '0051_phase16_mission_integrity.sql',
      '0052_phase16_mission_lifecycle_hardening.sql',
      '0053_phase16_mission_reward_issuance.sql',
    ]) {
      const sql = readFileSync(join(repoRoot, 'migrations', name), 'utf8').toLowerCase();
      expect(sql).not.toMatch(/insert into mission_definitions\b/);
      expect(sql).not.toMatch(/insert into mission_versions\b/);
      expect(sql).not.toMatch(/insert into reward_rules\b/);
      expect(sql).not.toMatch(/insert into reward_budget_periods\b/);
      expect(sql).not.toMatch(/insert into economic_exposure_limits\b/);
      expect(sql).not.toMatch(/insert into country/);
      expect(sql).not.toMatch(/insert into.*grace/);
    }
  });

  it('post-grant AD reversal cascade remains OWNER_POLICY_REQUIRED', () => {
    const text = readFileSync(
      join(repoRoot, 'packages/rewards/src/mission-maintenance.ts'),
      'utf8',
    );
    expect(text).toMatch(/OWNER_POLICY_REQUIRED/);
  });
});
