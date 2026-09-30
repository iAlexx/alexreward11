/**
 * Bot /start transport bridge — pure logic, no DB mutation.
 */
import { describe, expect, it } from 'vitest';

import { resolveReferralStartBridge } from '../src/referral-start.js';

describe('resolveReferralStartBridge', () => {
  it('plain /start launches Main Mini App without startapp identity', () => {
    const result = resolveReferralStartBridge({
      startPayload: '',
      botUsername: 'ExampleBot',
    });
    expect(result).toEqual({
      kind: 'LAUNCH_MAIN',
      launchUrl: 'https://t.me/ExampleBot?startapp',
    });
    if (result.kind !== 'LAUNCH_MAIN') throw new Error('expected LAUNCH_MAIN');
    expect(result.launchUrl.includes('startapp=')).toBe(false);
    expect(result.launchUrl.includes('ref_')).toBe(false);
  });

  it('builds Mini App ?startapp=ref_<code> for valid /start payload', () => {
    const result = resolveReferralStartBridge({
      startPayload: 'ref_ABC_123-x',
      botUsername: 'ExampleBot',
    });
    expect(result).toEqual({
      kind: 'LAUNCH',
      launchUrl: 'https://t.me/ExampleBot?startapp=ref_ABC_123-x',
      payload: 'ref_ABC_123-x',
      code: 'ABC_123-x',
    });
  });

  it('ignores malformed ref_, unsafe payload, and unrelated /start', () => {
    expect(
      resolveReferralStartBridge({
        startPayload: 'ref_',
        botUsername: 'ExampleBot',
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: 'ref_bad.code',
        botUsername: 'ExampleBot',
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: 'campaign_x',
        botUsername: 'ExampleBot',
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: 'ref_ABC_123-x',
        botUsername: undefined,
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: '',
        botUsername: undefined,
      }).kind,
    ).toBe('IGNORE');
  });

  it('never attributes and never invents referral financial authority', () => {
    // Pure function — no pool / no referral domain mutation surface.
    const result = resolveReferralStartBridge({
      startPayload: 'ref_SAFECODE1',
      botUsername: 'ExampleBot',
    });
    expect(result.kind).toBe('LAUNCH');
    if (result.kind !== 'LAUNCH') throw new Error('expected LAUNCH');
    expect(result.launchUrl.includes('?startapp=ref_SAFECODE1')).toBe(true);
    expect(result.launchUrl.includes('?start=')).toBe(false);
  });
});