'use client';

import { useEffect } from 'react';

/** Initialize official Telegram WebApp SDK once the script is present. */
export function TelegramWebAppReady() {
  useEffect(() => {
    const webApp = window.Telegram?.WebApp;
    if (!webApp) return;
    webApp.ready();
    webApp.expand();
  }, []);
  return null;
}
