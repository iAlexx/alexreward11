/**
 * User settings read/write contracts (Phase 12).
 *
 * Security notifications are reported but not switchable: the schema forbids disabling them.
 */

import type { LocaleCode } from './common.js';

export type PublicPayoutIdentityMode = 'SHOW_USERNAME' | 'HIDE_IDENTITY';

export interface UserSettingsResponse {
  readonly preferredLocale: LocaleCode;
  readonly publicPayoutIdentityMode: PublicPayoutIdentityMode;
  readonly marketingNotificationsEnabled: boolean;
  readonly securityNotificationsEnabled: true;
}

export interface PatchUserSettingsRequest {
  readonly preferredLocale?: LocaleCode;
}
