import { describe, expect, it } from 'vitest';

import { assertWithdrawalRequestsAllowed } from '../src/flags.js';
import { WithdrawalDomainError } from '../src/errors.js';

function mockClient(rows: ReadonlyArray<{ enabled: boolean }>) {
  return {
    async query() {
      return { rows: [...rows] };
    },
  } as never;
}

describe('Phase 21 withdrawal request pause fail-closed', () => {
  it('explicit true => PAUSED for all environments', async () => {
    for (const env of ['LOCAL', 'DEV', 'STAGING', 'PRODUCTION'] as const) {
      await expect(assertWithdrawalRequestsAllowed(mockClient([{ enabled: true }]), env)).rejects.toBeInstanceOf(
        WithdrawalDomainError,
      );
      await expect(assertWithdrawalRequestsAllowed(mockClient([{ enabled: true }]), env)).rejects.toMatchObject({
        code: 'PAUSED',
      });
    }
  });

  it('explicit false => allow', async () => {
    for (const env of ['LOCAL', 'DEV', 'STAGING', 'PRODUCTION'] as const) {
      await expect(
        assertWithdrawalRequestsAllowed(mockClient([{ enabled: false }]), env),
      ).resolves.toBeUndefined();
    }
  });

  it('missing STAGING => PAUSED fail-closed', async () => {
    await expect(assertWithdrawalRequestsAllowed(mockClient([]), 'STAGING')).rejects.toMatchObject({
      code: 'PAUSED',
      details: { reason: 'PAUSE_FLAG_MISSING' },
    });
  });

  it('missing PRODUCTION => PAUSED fail-closed', async () => {
    await expect(assertWithdrawalRequestsAllowed(mockClient([]), 'PRODUCTION')).rejects.toMatchObject({
      code: 'PAUSED',
      details: { reason: 'PAUSE_FLAG_MISSING' },
    });
  });

  it('missing LOCAL/DEV => allow (fixture-compatible)', async () => {
    await expect(assertWithdrawalRequestsAllowed(mockClient([]), 'LOCAL')).resolves.toBeUndefined();
    await expect(assertWithdrawalRequestsAllowed(mockClient([]), 'DEV')).resolves.toBeUndefined();
  });
});
