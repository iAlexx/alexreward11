import { loadWebConfig } from '@alex-rewards/config';

export const webConfig = loadWebConfig({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_TONCONNECT_MANIFEST_URL: process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL,
});

/**
 * Public TonConnect manifest URL, or null when unset.
 * Never invents a production/default URL — absence degrades the Wallet connect UI.
 */
export function tonConnectManifestUrl(): string | null {
  const value = webConfig.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
