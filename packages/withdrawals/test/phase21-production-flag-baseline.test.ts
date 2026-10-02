import { describe, expect, it } from 'vitest';

import {
  PHASE21_PRODUCTION_FLAG_BASELINE,
  runPhase21ProductionFlagBaseline,
  type Phase21ProductionFlagBaselineClient,
} from '../src/phase21-production-flag-baseline.js';

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
      if (text.includes('INSERT INTO feature_flags')) {
        const key = String(params?.[0] ?? '');
        const enabled = Boolean(params?.[1]);
        store.set(key, enabled);
        return { rows: [] as unknown as T[], rowCount: 1 };
      }
      return { rows: [] as unknown as T[] };
    },
  };
}

describe('phase21 production flag baseline', () => {
  const prevApply = process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY;
  const prevCeremony = process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;

  function restoreEnv(): void {
    if (prevApply === undefined) delete process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY;
    else process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY = prevApply;
    if (prevCeremony === undefined) delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    else process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED = prevCeremony;
  }

  it('defaults to DRY_RUN and plans CREATE for missing rows', async () => {
    delete process.env.PHASE21_PRODUCTION_FLAG_BASELINE_APPLY;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    const store = new Map<string, boolean>();
    const result = await runPhase21ProductionFlagBaseline(mockClient(store));
    expect(result.mode).toBe('DRY_RUN');
    expect(result.applied).toBe(false);
    expect(result.rows.every((r) => r.action === 'CREATE')).toBe(true);
    expect(result.rows).toHaveLength(PHASE21_PRODUCTION_FLAG_BASELINE.length);
    restoreEnv();
  });

  it('refuses conflicts without overwrite', async () => {
    const store = new Map<string, boolean>([['PAYOUT_DISPATCH_PAUSE', false]]);
    const result = await runPhase21ProductionFlagBaseline(mockClient(store), {
      forceApply: true,
    });
    expect(result.applied).toBe(false);
    expect(result.conflicts.some((c) => c.flagKey === 'PAYOUT_DISPATCH_PAUSE')).toBe(true);
    expect(store.get('PAYOUT_DISPATCH_PAUSE')).toBe(false);
  });

  it('apply creates only missing rows when gated', async () => {
    const store = new Map<string, boolean>([
      ['WITHDRAWAL_REQUESTS_PAUSE', true],
      ['PUBLIC_PAYOUT_LOGS_ENABLED', false],
    ]);
    const result = await runPhase21ProductionFlagBaseline(mockClient(store), {
      forceApply: true,
    });
    expect(result.mode).toBe('APPLY');
    expect(result.applied).toBe(true);
    expect(result.createdCount).toBe(PHASE21_PRODUCTION_FLAG_BASELINE.length - 2);
    expect(store.get('PAYOUT_DISPATCH_PAUSE')).toBe(true);
    expect(store.get('AUTO_PAYOUT_PAUSE')).toBe(true);
    expect(store.get('PUBLIC_PAYOUT_LOGS_ENABLED')).toBe(false);
  });

  it('idempotent exact retry creates zero rows', async () => {
    const store = new Map<string, boolean>();
    for (const flag of PHASE21_PRODUCTION_FLAG_BASELINE) {
      store.set(flag.flagKey, flag.enabled);
    }
    const result = await runPhase21ProductionFlagBaseline(mockClient(store), {
      forceApply: true,
    });
    expect(result.applied).toBe(true);
    expect(result.createdCount).toBe(0);
    expect(result.rows.every((r) => r.action === 'ALREADY_MATCHES')).toBe(true);
  });
});
