export {
  LOCALES,
  defaultLocale,
  isLocale,
  isRtlLocale,
} from './locales.js';
export type { Locale } from './locales.js';

/**
 * Package subpaths for locale message catalogs.
 * Import as `@alex-rewards/i18n/messages/en.json` (and ar/ru).
 */
export const messageCatalogs = {
  ar: '@alex-rewards/i18n/messages/ar.json',
  en: '@alex-rewards/i18n/messages/en.json',
  ru: '@alex-rewards/i18n/messages/ru.json',
} as const;
