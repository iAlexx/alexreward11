import { loadWebConfig } from '@alex-rewards/config';

export const webConfig = loadWebConfig({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_TONCONNECT_MANIFEST_URL: process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL,
  NEXT_PUBLIC_TERMS_URL: process.env.NEXT_PUBLIC_TERMS_URL,
  NEXT_PUBLIC_PRIVACY_URL: process.env.NEXT_PUBLIC_PRIVACY_URL,
});

/**
 * Public TonConnect manifest URL, or null when unset.
 * Never invents a production/default URL — absence degrades the Wallet connect UI.
 */
export function tonConnectManifestUrl(): string | null {
  return optionalPublicUrl(webConfig.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL);
}

/**
 * Public Terms of Service URL, or null when unset.
 * Never invents a legal destination — Profile degrades honestly when absent.
 */
export function termsOfServiceUrl(): string | null {
  return optionalPublicUrl(webConfig.NEXT_PUBLIC_TERMS_URL);
}

/**
 * Public Privacy Policy URL, or null when unset.
 * Never invents a legal destination — Profile degrades honestly when absent.
 */
export function privacyPolicyUrl(): string | null {
  return optionalPublicUrl(webConfig.NEXT_PUBLIC_PRIVACY_URL);
}

function optionalPublicUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
