import { describe, expect, it } from 'vitest';

import { isPayoutDispatchPaused } from '../src/flags.js';

function mockClient(rows: ReadonlyArray<{ enabled: boolean }>) {
  return {
    async query() {
      return { rows: [...rows] };
    },
  } as never;
}

describe('P19-SEC-016 payout pause fail-closed', () => {
  it('explicit true => paused for all environments', async () => {
    for (const env of ['LOCAL', 'DEV', 'STAGING', 'PRODUCTION'] as const) {
      expect(await isPayoutDispatchPaused(mockClient([{ enabled: true }]), env)).toBe(true);
    }
  });

  it('explicit false => not paused', async () => {
    for (const env of ['LOCAL', 'DEV', 'STAGING', 'PRODUCTION'] as const) {
      expect(await isPayoutDispatchPaused(mockClient([{ enabled: false }]), env)).toBe(false);
    }
  });

  it('missing STAGING => paused (fail closed)', async () => {
    expect(await isPayoutDispatchPaused(mockClient([]), 'STAGING')).toBe(true);
  });

  it('missing PRODUCTION => paused (fail closed)', async () => {
    expect(await isPayoutDispatchPaused(mockClient([]), 'PRODUCTION')).toBe(true);
  });

  it('missing LOCAL/DEV => not paused (fixture-compatible)', async () => {
    expect(await isPayoutDispatchPaused(mockClient([]), 'LOCAL')).toBe(false);
    expect(await isPayoutDispatchPaused(mockClient([]), 'DEV')).toBe(false);
  });
});
