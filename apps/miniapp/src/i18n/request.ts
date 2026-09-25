import { defaultLocale, isLocale } from '@alex-rewards/i18n';
import { getRequestConfig } from 'next-intl/server';

import { messagesFor } from './messages';

/**
 * next-intl request config.
 *
 * Locale preference is applied client-side after settings load; the first paint uses
 * the default locale, then AuthProvider / settings sync the document lang+dir.
 */
export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale: isLocale(locale) ? locale : defaultLocale,
    messages: messagesFor(locale),
  };
});
