import { isLocale, isRtlLocale, LOCALES } from '@alex-rewards/i18n';
import { describe, expect, it } from 'vitest';

import { messagesByLocale, messagesFor } from '../src/i18n/messages';

describe('Phase 12 miniapp i18n', () => {
  it('ships ar, en, and ru catalogs with matching top-level keys', () => {
    expect(LOCALES).toEqual(['ar', 'en', 'ru']);
    const enKeys = Object.keys(messagesByLocale.en).sort();
    for (const locale of LOCALES) {
      expect(isLocale(locale)).toBe(true);
      expect(Object.keys(messagesByLocale[locale]).sort()).toEqual(enKeys);
    }
  });

  it('marks Arabic as RTL and others as LTR', () => {
    expect(isRtlLocale('ar')).toBe(true);
    expect(isRtlLocale('en')).toBe(false);
    expect(isRtlLocale('ru')).toBe(false);
  });

  it('falls back to the default catalog for unknown locales', () => {
    expect(messagesFor('zz')).toBe(messagesByLocale.en);
    expect(messagesFor('ar')).toBe(messagesByLocale.ar);
  });

  it('covers Phase 12 screen namespaces', () => {
    const en = messagesByLocale.en;
    for (const key of [
      'nav',
      'home',
      'earn',
      'tasks',
      'friends',
      'wallet',
      'profile',
      'founder',
      'auth',
      'onboarding',
      'activity',
      'notifications',
    ] as const) {
      expect(en[key]).toBeTypeOf('object');
    }
    expect(en.earn.monetaryBlockedTitle.length).toBeGreaterThan(0);
    expect(en.tasks.engineTitle.length).toBeGreaterThan(0);
    expect(en.friends.engineTitle.length).toBeGreaterThan(0);
    expect(en.founder.claimCodeHelp.length).toBeGreaterThan(0);
  });
});
