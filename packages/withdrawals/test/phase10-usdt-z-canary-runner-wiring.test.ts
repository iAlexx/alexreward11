import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Guards the isolated USDT Z canary runner wiring for FAILED_PRE Temporal redispatch.
 * Path is outside the Git tree (Owner ops desk) but must stay in sync with Phase 10 code.
 */
const CANARY_RUNNER = new URL(
  '../../../../../../ALExRewards/isolated-payout-testnet/config/_canary-usdt-z.mjs',
  import.meta.url,
);

describe('USDT Z canary runner wiring (failed-pre retry)', () => {
  it('live path invokes enqueueFailedPreBroadcastRetry and failed_pre_retry event', () => {
    let src: string;
    try {
      src = readFileSync(CANARY_RUNNER, 'utf8');
    } catch {
      // Alternate absolute path for Windows Owner desk layout
      src = readFileSync(
        'C:/Users/Master aLEX/ALExRewards/isolated-payout-testnet/config/_canary-usdt-z.mjs',
        'utf8',
      );
    }
    expect(src).toMatch(/enqueueFailedPreBroadcastRetry/);
    expect(src).toMatch(/WITHDRAWAL_FAILED_PRE_RETRY_OUTBOX_EVENT/);
    expect(src).toMatch(/CANARY_AUTHORIZE_LIVE_WINDOW/);
    expect(src).toMatch(/mode = 'failed_pre_retry_live'/);
    // Must not mint a second withdrawal in the retry branch
    const liveIdx = src.indexOf("mode = 'failed_pre_retry_live'");
    expect(liveIdx).toBeGreaterThan(0);
    const liveSlice = src.slice(liveIdx, liveIdx + 8000);
    expect(liveSlice).not.toMatch(/createWithdrawalFromQuote/);
    expect(liveSlice).toMatch(/enqueueFailedPreBroadcastRetry/);
    expect(liveSlice).toMatch(/signatureEvidenceAttemptCount/);
  });
});
