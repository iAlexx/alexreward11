import { defaultLocale, isLocale, type Locale } from '@alex-rewards/i18n';
import ar from '@alex-rewards/i18n/messages/ar.json';
import en from '@alex-rewards/i18n/messages/en.json';
import ru from '@alex-rewards/i18n/messages/ru.json';

/** Message catalogs are bundled statically so a locale switch never needs a network read. */
export const messagesByLocale = { ar, en, ru } as const satisfies Record<Locale, unknown>;

export type AppMessages = typeof en;

export function messagesFor(locale: string): AppMessages {
  return isLocale(locale) ? messagesByLocale[locale] : messagesByLocale[defaultLocale];
}
