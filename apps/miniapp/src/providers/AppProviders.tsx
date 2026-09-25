'use client';

import type { ReactNode } from 'react';

import type { AppMessages } from '../i18n/messages';
import { AuthProvider } from './AuthProvider';
import { LocaleMessagesProvider } from './LocaleMessagesProvider';
import { QueryProvider } from './QueryProvider';

export function AppProviders({
  children,
  locale,
  messages,
}: {
  readonly children: ReactNode;
  readonly locale: string;
  readonly messages: AppMessages;
}) {
  return (
    <LocaleMessagesProvider initialLocale={locale} initialMessages={messages}>
      <QueryProvider>
        <AuthProvider>{children}</AuthProvider>
      </QueryProvider>
    </LocaleMessagesProvider>
  );
}
