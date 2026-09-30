/**
 * Bot /start transport bridge — pure logic, no DB mutation.
 */
import { describe, expect, it } from 'vitest';

import {
  buildPlainStartWebAppButton,
  isSafeMiniAppPublicUrl,
  resolveReferralStartBridge,
} from '../src/referral-start.js';

const MINIAPP_URL = 'https://miniapp.example.com';

describe('resolveReferralStartBridge', () => {
  it('plain /start launches native Mini App web_app action from MINIAPP_PUBLIC_URL', () => {
    const result = resolveReferralStartBridge({
      startPayload: '',
      botUsername: 'ExampleBot',
      miniAppPublicUrl: MINIAPP_URL,
    });
    expect(result).toEqual({
      kind: 'LAUNCH_MAIN',
      webAppUrl: MINIAPP_URL,
    });
    if (result.kind !== 'LAUNCH_MAIN') throw new Error('expected LAUNCH_MAIN');
    expect(result.webAppUrl.includes('t.me')).toBe(false);
    expect(result.webAppUrl.includes('startapp')).toBe(false);
    expect(result.webAppUrl.includes('ref_')).toBe(false);

    const button = buildPlainStartWebAppButton(result.webAppUrl);
    expect(button).toEqual({
      text: 'Open LOOTRA',
      web_app: { url: MINIAPP_URL },
      style: 'primary',
    });
    expect('url' in button).toBe(false);
    expect(button.web_app.url).toBe(MINIAPP_URL);
  });

  it('plain /start does not require bot username when Mini App URL is configured', () => {
    expect(
      resolveReferralStartBridge({
        startPayload: '',
        botUsername: undefined,
        miniAppPublicUrl: MINIAPP_URL,
      }),
    ).toEqual({ kind: 'LAUNCH_MAIN', webAppUrl: MINIAPP_URL });
  });

  it('plain /start fails closed when MINIAPP_PUBLIC_URL is missing or unsafe', () => {
    expect(
      resolveReferralStartBridge({
        startPayload: '',
        botUsername: 'ExampleBot',
        miniAppPublicUrl: undefined,
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: '',
        botUsername: 'ExampleBot',
        miniAppPublicUrl: '',
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: '',
        botUsername: 'ExampleBot',
        miniAppPublicUrl: 'https://t.me/ExampleBot?startapp',
      }).kind,
    ).toBe('IGNORE');
    expect(isSafeMiniAppPublicUrl('https://t.me/ExampleBot?startapp')).toBe(false);
    expect(isSafeMiniAppPublicUrl(MINIAPP_URL)).toBe(true);
  });

  it('builds Mini App ?startapp=ref_<code> for valid /start payload', () => {
    const result = resolveReferralStartBridge({
      startPayload: 'ref_ABC_123-x',
      botUsername: 'ExampleBot',
      miniAppPublicUrl: MINIAPP_URL,
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
        miniAppPublicUrl: MINIAPP_URL,
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: 'ref_bad.code',
        botUsername: 'ExampleBot',
        miniAppPublicUrl: MINIAPP_URL,
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: 'campaign_x',
        botUsername: 'ExampleBot',
        miniAppPublicUrl: MINIAPP_URL,
      }).kind,
    ).toBe('IGNORE');
    expect(
      resolveReferralStartBridge({
        startPayload: 'ref_ABC_123-x',
        botUsername: undefined,
        miniAppPublicUrl: MINIAPP_URL,
      }).kind,
    ).toBe('IGNORE');
  });

  it('never attributes and never invents referral financial authority', () => {
    // Pure function — no pool / no referral domain mutation surface.
    const result = resolveReferralStartBridge({
      startPayload: 'ref_SAFECODE1',
      botUsername: 'ExampleBot',
      miniAppPublicUrl: MINIAPP_URL,
    });
    expect(result.kind).toBe('LAUNCH');
    if (result.kind !== 'LAUNCH') throw new Error('expected LAUNCH');
    expect(result.launchUrl.includes('?startapp=ref_SAFECODE1')).toBe(true);
    expect(result.launchUrl.includes('?start=')).toBe(false);
  });
});
