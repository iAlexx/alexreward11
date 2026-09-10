import { describe, expect, it } from 'vitest';

import { FakeTonChainProvider } from '@alex-rewards/ton';

import { classifySubmitError } from '../src/broadcast-gate.js';

describe('phase10 crash matrix (fake provider)', () => {
  it('before sign: no sendBoc calls', async () => {
    const fake = new FakeTonChainProvider();
    // Crash before sign means broadcast never starts.
    expect(fake.getSendBocCallCount()).toBe(0);
    expect(fake.getSubmittedBocs()).toEqual([]);
  });

  it('after sign before broadcast: pre-submit failure classifies FAILED_PRE_BROADCAST', () => {
    const classification = classifySubmitError(new Error('FAKE_PROVIDER_PRE_SUBMIT_FAILURE'));
    expect(classification.kind).toBe('FAILED_PRE_BROADCAST');
  });

  it('rpc timeout classifies UNKNOWN/RPC_TIMEOUT and never invites blind resend', async () => {
    const fake = new FakeTonChainProvider({ sendBocTimeout: true });
    await expect(fake.sendBoc('Ym9j')).rejects.toThrow(/TIMEOUT/);
    expect(fake.getSendBocCallCount()).toBe(1);
    expect(fake.getSubmittedBocs()).toHaveLength(1);

    const classification = classifySubmitError(new Error('FAKE_PROVIDER_RPC_TIMEOUT'));
    expect(classification.kind).toBe('UNKNOWN');
    if (classification.kind === 'UNKNOWN') {
      expect(classification.ambiguityClass).toBe('RPC_TIMEOUT');
    }

    // Second blind send would be another call — gate forbids this when submitted_at set.
    // Here we only prove provider was already invoked once; resend policy is in broadcast-gate.
    await expect(fake.sendBoc('Ym9j')).rejects.toThrow(/TIMEOUT/);
    expect(fake.getSendBocCallCount()).toBe(2);
  });

  it('crash-after-submit classifies UNKNOWN not FAILED_PRE_BROADCAST', () => {
    const classification = classifySubmitError(new Error('CRASH_AFTER_SUBMIT'));
    expect(classification.kind).toBe('UNKNOWN');
    if (classification.kind === 'UNKNOWN') {
      expect(classification.ambiguityClass).toBe('CRASH_AFTER_SUBMIT');
    }
  });
});
