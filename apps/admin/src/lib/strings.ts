/**
 * English-primary Owner Admin copy (V1). Spec focuses on Owner ops.
 * `@alex-rewards/i18n` is a workspace dependency for future catalog alignment;
 * Admin V1 does not ship multi-locale UI.
 */
import { defaultLocale } from '@alex-rewards/i18n';

export const ADMIN_UI_LOCALE = defaultLocale;

export const strings = {
  appName: 'ALEx Rewards Admin',
  skipToMain: 'Skip to main content',
  loading: 'Loading…',
  error: 'Something went wrong.',
  empty: 'No records.',
  unavailable: 'This domain is not available yet.',
  degraded: 'Partial data — some fields could not be loaded.',
  retry: 'Retry',
  reasonCode: 'Reason',
  signIn: 'Sign in',
  signOut: 'Sign out',
  webauthnPrimary: 'Sign in with passkey',
  webauthnHint: 'Primary authentication. Use a registered Owner passkey.',
  passwordFallback: 'Password + TOTP fallback',
  recoveryPath: 'Recovery code',
  email: 'Email',
  password: 'Password',
  totp: 'TOTP code',
  recoveryCode: 'Recovery code',
  reauthTitle: 'Reauthenticate',
  reauthBody: 'This high-impact action requires recent reauthentication.',
  confirmCeremony: 'Confirm change',
  reasonRequired: 'Reason (required)',
  secondConfirmLabel: 'Type the exact confirmation phrase to proceed',
  oldValue: 'Current',
  newValue: 'Proposed',
  filter: 'Filter',
  search: 'Search',
  previous: 'Previous',
  next: 'Next',
  page: 'Page',
  noBalanceEditor:
    'Balances are ledger-derived. Direct balance mutation controls are not provided on this surface.',
  adsgramBlocked: 'AdsGram production monetary status: BLOCKED',
  adsgramApproveDisabled:
    'APPROVED is disabled pending provider security/correlation clarification.',
  payoutPauseWarning: 'PAYOUT_DISPATCH_PAUSE is active. Dispatch will not send.',
  payoutPauseCeremony:
    'Changing PAYOUT_DISPATCH_PAUSE requires the full high-impact ceremony. It cannot be toggled silently.',
  estimated: 'ESTIMATED',
  settled: 'SETTLED',
  estimatedNotProfit: 'Estimated margin is not settled profit.',
  hotWalletPublicOnly: 'Public Hot Wallet fields only. Private keys and seeds are never shown.',
  navLandmark: 'Admin navigation',
  mainLandmark: 'Admin main content',
} as const;

export type AdminStringKey = keyof typeof strings;
