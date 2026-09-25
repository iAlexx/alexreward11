/**
 * Phase 13 Admin API surface smoke — controller registration and pure contracts.
 */
import { describe, expect, it } from 'vitest';

import {
  ADMIN_API_CONTRACT_VERSION,
  createHighImpactConfirmation,
} from '@alex-rewards/contracts';

import { OverviewController } from '../src/admin/overview.controller.js';
import { PolicyCenterController } from '../src/admin/policy-center.controller.js';
import { AppModule } from '../src/app.module.js';

describe('Phase 13 Admin APIs', () => {
  it('exports admin contract version 1', () => {
    expect(ADMIN_API_CONTRACT_VERSION).toBe('1');
  });

  it('registers all Phase 13 Admin controllers on AppModule', () => {
    const mod = AppModule.register({ DEPLOYMENT_ENV: 'LOCAL' } as never);
    const names = new Set(
      (mod.controllers ?? []).map((c) => (c as { name?: string }).name ?? ''),
    );
    const required = [
      'OverviewController',
      'UsersController',
      'WithdrawalsAdminController',
      'HotWalletController',
      'LedgerAdminController',
      'AdsAdminController',
      'ProvidersAdminController',
      'RewardEngineAdminController',
      'MembershipsAdminController',
      'EntitlementsAdminController',
      'PolicyCenterController',
      'EconomicsController',
      'ExposureController',
      'ReviewQueueController',
      'FeatureFlagsController',
      'MissionsAdminController',
      'NotificationsAdminController',
      'FraudAdminController',
      'ReferralAdminController',
      'SupportAdminController',
      'AuditController',
      'SystemController',
      'SettingsController',
      'AdminAuthController',
    ];
    for (const name of required) {
      expect(names.has(name), `missing ${name}`).toBe(true);
    }
  });

  it('overview aggregates domains with unavailable engines labeled', () => {
    const body = new OverviewController().overview();
    expect(body.domains.length).toBeGreaterThanOrEqual(20);
    expect(body.domains.every((d) => typeof d.key === 'string')).toBe(true);
  });

  it('policy center lists typed families only', () => {
    const body = new PolicyCenterController(null as never, null as never).families();
    expect(body.families.every((f) => f.acceptsArbitraryCode === false)).toBe(true);
  });

  it('high-impact confirmation hash is stable for canonical payload key order', async () => {
    const a = await createHighImpactConfirmation({
      action: 'x',
      resourceType: 'y',
      resourceId: 'z',
      expectedVersion: '1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      payload: { b: 2, a: 1 },
    });
    const b = await createHighImpactConfirmation({
      action: 'x',
      resourceType: 'y',
      resourceId: 'z',
      expectedVersion: '1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      payload: { a: 1, b: 2 },
    });
    expect(a.confirmationHash).toBe(b.confirmationHash);
  });
});
