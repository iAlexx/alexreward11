import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PHASE21_PRODUCTION_FLAG_BASELINE,
  applyPhase21ProductionFlagBaseline,
  planPhase21ProductionFlagBaseline,
  runPhase21ProductionFlagBaseline,
  type Phase21ProductionFlagBaselineClient,
} from '../src/phase21-production-flag-baseline.js';
import { __phase21TestSetApplyEnv } from '../src/phase21-ceremony-apply-gates.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';

function mockClient(store: Map<string, boolean>): Phase21ProductionFlagBaselineClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: readonly unknown[],
    ): Promise<{ rows: T[]; rowCount?: number | null }> {
      if (text.includes('SELECT enabled')) {
        const key = String(params?.[0] ?? '');
        if (!store.has(key)) return { rows: [] as unknown as T[] };
        return { rows: [{ enabled: store.get(key)! }] as unknown as T[] };
      }
      return { rows: [] as unknown as T[] };
    },
  };
}

describe('phase21 production flag baseline', () => {
  beforeEach(() => {
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  });
  const envKeys = [
    'DEPLOYMENT_ENV',
    'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
    'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
    'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
    'PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
    'ALEX_PHASE21_CEREMONY_TEST_HOOKS',
  ] as const;
  const prev: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function snap(): void {
    for (const k of envKeys) prev[k] = process.env[k];
  }

  it('run defaults to PLAN and has no forceApply option', async () => {
    snap();
    delete process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    const store = new Map<string, boolean>();
    const result = await runPhase21ProductionFlagBaseline(mockClient(store));
    expect(result.mode).toBe('PLAN');
    expect(result.applied).toBe(false);
    expect(result.applyAuthorized).toBe(false);
    expect(result.rows.every((r) => r.action === 'CREATE')).toBe(true);
    expect(result.rows).toHaveLength(PHASE21_PRODUCTION_FLAG_BASELINE.length);
    expect(result.notes.some((n) => n.includes('forceApply'))).toBe(true);
  });

  it('plan reports conflicts without overwrite', async () => {
    const store = new Map<string, boolean>([['PAYOUT_DISPATCH_PAUSE', false]]);
    const rows = await planPhase21ProductionFlagBaseline(mockClient(store));
    expect(rows.some((r) => r.flagKey === 'PAYOUT_DISPATCH_PAUSE' && r.action === 'CONFLICT')).toBe(
      true,
    );
    expect(store.get('PAYOUT_DISPATCH_PAUSE')).toBe(false);
  });

  it('apply refuses when env gates missing (no forceApply)', async () => {
    snap();
    delete process.env.DEPLOYMENT_ENV;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    delete process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY;
    delete process.env.PHASE21_CEREMONY_REQUIRED_DATABASE_NAME;

    const fakeClient = {
      async query(text: string) {
        if (text === 'BEGIN' || text === 'ROLLBACK' || text === 'COMMIT') return { rows: [] };
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) {
          return { rows: [{ sid: '1' }] };
        }
        return { rows: [] };
      },
    };

    const result = await applyPhase21ProductionFlagBaseline(fakeClient as never, {
      reason: 'test',
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: '11111111-1111-4111-8111-111111111111',
        currentDatabase: 'alex_rewards_phase20_test',
        systemIdentifier: '1',
      }),
    });
    expect(result.applied).toBe(false);
    expect(result.mode).toBe('REFUSED');
    expect(result.refuseCode).toBeTruthy();
  });

  it('apply refuses staging even with other gates', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'staging',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const fakeClient = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) {
          return { rows: [{ sid: '1' }] };
        }
        return { rows: [] };
      },
    };
    const result = await applyPhase21ProductionFlagBaseline(fakeClient as never, {
      reason: 'test',
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: '11111111-1111-4111-8111-111111111111',
        currentDatabase: 'alex_rewards_phase20_test',
        systemIdentifier: '1',
      }),
    });
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toBe('STAGING_APPLY_FORBIDDEN');
  });
});
