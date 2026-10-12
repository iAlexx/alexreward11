import { describe, expect, it } from 'vitest';

import {
  FAKE_CHAIN_PAYOUT_ACTIVITY_OPTIONS,
  REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS,
  foundationProbe,
} from '../src/workflows.js';
import { toWithdrawalPayoutActivityResult } from '../src/payout-activity-result.js';

describe('foundation Temporal workflow', () => {
  it('is deterministic and contains no business mutation', async () => {
    await expect(foundationProbe('phase-1')).resolves.toBe('foundation-ok:phase-1');
  });
});

describe('real-chain payout Temporal retry policy', () => {
  it('disables automatic retries for real-chain activities only', () => {
    expect(REAL_CHAIN_PAYOUT_ACTIVITY_OPTIONS.retry.maximumAttempts).toBe(1);
    expect(FAKE_CHAIN_PAYOUT_ACTIVITY_OPTIONS).not.toHaveProperty('retry');
  });
});

describe('toWithdrawalPayoutActivityResult', () => {
  it('preserves reason and stagesCompleted for FAILED_PRE_BROADCAST diagnostics', () => {
    const mapped = toWithdrawalPayoutActivityResult({
      state: 'FAILED_PRE_BROADCAST',
      attemptId: null,
      reason: 'WALLET_SEQNO_READMISSION_BLOCKED:RATE_LIMITED:http 429',
      stagesCompleted: [
        'pause_check',
        'owner_resource_gate',
        'approved_withdrawal_loaded',
        'authoritative_wallet_seqno',
        'fenced_dispatcher_lease',
      ],
    });
    expect(mapped).toEqual({
      state: 'FAILED_PRE_BROADCAST',
      attemptId: null,
      reason: 'WALLET_SEQNO_READMISSION_BLOCKED:RATE_LIMITED:http 429',
      stagesCompleted: [
        'pause_check',
        'owner_resource_gate',
        'approved_withdrawal_loaded',
        'authoritative_wallet_seqno',
        'fenced_dispatcher_lease',
      ],
    });
    expect(mapped.stagesCompleted).not.toContain('immutable_payout_attempt');
    expect(mapped.stagesCompleted).not.toContain('signer_attempt_id_signing');
    expect(mapped.stagesCompleted).not.toContain('provider_sendBoc');
  });

  it('omits optional fields when pipeline did not supply them', () => {
    expect(
      toWithdrawalPayoutActivityResult({
        state: 'CONFIRMED',
        attemptId: '01a0aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toEqual({
      state: 'CONFIRMED',
      attemptId: '01a0aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });
});
