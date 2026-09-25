import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import { defaultLocale, isRtlLocale } from '@alex-rewards/i18n';

import { TelegramWebAppReady } from '../components/TelegramWebAppReady';
import { messagesFor } from '../i18n/messages';
import { AppProviders } from '../providers/AppProviders';

import './globals.css';

export const metadata: Metadata = {
  title: 'ALEx Rewards',
  description: 'ALEx Rewards Telegram Mini App',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const locale = defaultLocale;
  const messages = messagesFor(locale);

  return (
    <html lang={locale} dir={isRtlLocale(locale) ? 'rtl' : 'ltr'}>
      <body>
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
        <TelegramWebAppReady />
        <AppProviders locale={locale} messages={messages}>
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
