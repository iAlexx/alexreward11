export const LOCALES = ['ar', 'en', 'ru'] as const;

export type Locale = (typeof LOCALES)[number];

export const defaultLocale: Locale = 'en';

const RTL_LOCALES: ReadonlySet<string> = new Set(['ar']);

export function isRtlLocale(locale: string): boolean {
  return RTL_LOCALES.has(locale);
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
