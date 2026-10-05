'use client';

import { isLocale, type Locale } from '@alex-rewards/i18n';
import { NextIntlClientProvider } from 'next-intl';
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { messagesFor, type AppMessages } from '../i18n/messages';

interface LocaleContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleMessagesProvider({
  children,
  initialLocale,
  initialMessages,
}: {
  readonly children: ReactNode;
  readonly initialLocale: string;
  readonly initialMessages: AppMessages;
}) {
  const start = isLocale(initialLocale) ? initialLocale : 'en';
  const [locale, setLocaleState] = useState<Locale>(start);
  const [messages, setMessages] = useState<AppMessages>(initialMessages);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    setMessages(messagesFor(next));
  }, []);

  const value = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <LocaleContext.Provider value={value}>
      <NextIntlClientProvider locale={locale} messages={messages}>
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}

export function useLocaleMessages(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === null) {
    throw new Error('useLocaleMessages must be used within LocaleMessagesProvider');
  }
  return ctx;
}
