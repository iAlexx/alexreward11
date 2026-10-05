/**
 * User settings read/write contracts (Phase 12).
 *
 * Security notifications are reported but not switchable: the schema forbids disabling them.
 * Locale and public payout identity mode are the only user-writable fields on this surface.
 */

import type { LocaleCode } from './common.js';

export type PublicPayoutIdentityMode = 'SHOW_USERNAME' | 'HIDE_IDENTITY';

const PUBLIC_PAYOUT_IDENTITY_MODES: readonly PublicPayoutIdentityMode[] = [
  'SHOW_USERNAME',
  'HIDE_IDENTITY',
];

export function isPublicPayoutIdentityMode(value: unknown): value is PublicPayoutIdentityMode {
  return (
    typeof value === 'string' && (PUBLIC_PAYOUT_IDENTITY_MODES as readonly string[]).includes(value)
  );
}

export interface UserSettingsResponse {
  readonly preferredLocale: LocaleCode;
  readonly publicPayoutIdentityMode: PublicPayoutIdentityMode;
  readonly marketingNotificationsEnabled: boolean;
  readonly securityNotificationsEnabled: true;
}

export interface PatchUserSettingsRequest {
  readonly preferredLocale?: LocaleCode;
  readonly publicPayoutIdentityMode?: PublicPayoutIdentityMode;
}
