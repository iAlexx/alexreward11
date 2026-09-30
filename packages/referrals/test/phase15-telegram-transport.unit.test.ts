/**
 * Telegram referral transport helpers + end-to-end payload identity contract.
 */
import { describe, expect, it } from 'vitest';

import {
  REFERRAL_START_PREFIX,
  TELEGRAM_START_MAX_LENGTH,
  REFERRAL_CODE_MAX_TELEGRAM_LENGTH,
  assertReferralCodePolicyShape,
  buildReferralBotStartLink,
  buildReferralMiniAppLaunchLink,
  buildMainMiniAppLaunchLink,
  buildReferralStartPayload,
  parseReferralStartParam,
  referralCodeEntropyBits,
  ReferralDomainError,
} from '../src/index.js';

const SAFE_ALPHABET =
  'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789_-';

describe('Telegram referral transport policy', () => {
  it('accepts codeLength 60 with sufficient entropy and safe alphabet', () => {
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: SAFE_ALPHABET, codeLength: 60 }),
    ).not.toThrow();
    expect(referralCodeEntropyBits(Array.from(SAFE_ALPHABET).length, 60)).toBeGreaterThanOrEqual(
      96,
    );
  });

  it('rejects codeLength 61 and 64', () => {
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: SAFE_ALPHABET, codeLength: 61 }),
    ).toThrow(ReferralDomainError);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: SAFE_ALPHABET, codeLength: 64 }),
    ).toThrow(ReferralDomainError);
  });

  it('builds ref_ + 60-char code as exactly 64 chars', () => {
    const code = 'A'.repeat(REFERRAL_CODE_MAX_TELEGRAM_LENGTH);
    const built = buildReferralStartPayload(code);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('expected ok');
    expect(built.payload).toBe(`${REFERRAL_START_PREFIX}${code}`);
    expect(built.payload.length).toBe(TELEGRAM_START_MAX_LENGTH);
  });

  it('rejects alphabets with ., +, space, emoji/Unicode', () => {
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: `${SAFE_ALPHABET}.`, codeLength: 40 }),
    ).toThrow(ReferralDomainError);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: `${SAFE_ALPHABET}+`, codeLength: 40 }),
    ).toThrow(ReferralDomainError);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: `${SAFE_ALPHABET} `, codeLength: 40 }),
    ).toThrow(ReferralDomainError);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: `${SAFE_ALPHABET}😀`, codeLength: 40 }),
    ).toThrow(ReferralDomainError);
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: `${SAFE_ALPHABET}ß`, codeLength: 40 }),
    ).toThrow(ReferralDomainError);
  });

  it('accepts A-Za-z0-9_- subset when entropy is satisfied', () => {
    expect(() =>
      assertReferralCodePolicyShape({ alphabet: SAFE_ALPHABET, codeLength: 40 }),
    ).not.toThrow();
  });
});

describe('Telegram deep-link builders', () => {
  it('builds ?start= and ?startapp= with exact opaque code (no rewrite)', () => {
    const code = 'ABC_123-x';
    expect(buildReferralBotStartLink('ExampleBot', code)).toBe(
      'https://t.me/ExampleBot?start=ref_ABC_123-x',
    );
    expect(buildReferralMiniAppLaunchLink('ExampleBot', code)).toBe(
      'https://t.me/ExampleBot?startapp=ref_ABC_123-x',
    );
  });

  it('returns null for historical unsafe codes (no fabricated link)', () => {
    expect(buildReferralBotStartLink('ExampleBot', 'bad.code')).toBeNull();
    expect(buildReferralBotStartLink('ExampleBot', 'bad+code')).toBeNull();
    expect(buildReferralBotStartLink('ExampleBot', 'bad code')).toBeNull();
    expect(buildReferralMiniAppLaunchLink('ExampleBot', 'bad%code')).toBeNull();
    expect(buildReferralStartPayload('')).toEqual({ ok: false, reason: 'EMPTY' });
  });

  it('preserves exact code identity across legacy start → startapp bridge → Mini App parse', () => {
    const code = 'AbC_12-XyZ';
    const legacyStart = buildReferralBotStartLink('MyBotName', code);
    const userFacing = buildReferralMiniAppLaunchLink('MyBotName', code);
    expect(legacyStart).toBe(`https://t.me/MyBotName?start=ref_${code}`);
    expect(userFacing).toBe(`https://t.me/MyBotName?startapp=ref_${code}`);
    const legacyPayload = legacyStart!.split('?start=')[1]!;
    const startappPayload = userFacing!.split('?startapp=')[1]!;
    expect(legacyPayload).toBe(startappPayload);
    expect(parseReferralStartParam(legacyPayload)).toEqual({
      kind: 'REFERRAL_CODE',
      code,
    });
    expect(parseReferralStartParam(startappPayload)).toEqual({
      kind: 'REFERRAL_CODE',
      code,
    });
  });

  it('builds Main Mini App ?startapp with no payload', () => {
    expect(buildMainMiniAppLaunchLink('ExampleBot')).toBe('https://t.me/ExampleBot?startapp');
    expect(buildMainMiniAppLaunchLink('')).toBeNull();
    expect(buildMainMiniAppLaunchLink('@ExampleBot')).toBeNull();
    expect(buildMainMiniAppLaunchLink('bad bot')).toBeNull();
  });
});
