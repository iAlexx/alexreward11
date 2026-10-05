/**
 * Pure parser for Telegram Mini App `start_param` referral transport.
 *
 * Spec transport prefix is `ref_<code>`. Production code alphabet/length remains
 * OWNER_POLICY_REQUIRED — this parser does not generate or normalize codes.
 */

export const REFERRAL_START_PREFIX = 'ref_' as const;

export type ReferralStartParamParseResult =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'INVALID_REFERRAL_START_PARAM' }
  | { readonly kind: 'REFERRAL_CODE'; readonly code: string };

/**
 * Parse a HMAC-validated Telegram `start_param`.
 * Does not trim, case-fold, or otherwise mutate the opaque code after the prefix.
 */
export function parseReferralStartParam(
  startParam: string | null | undefined,
): ReferralStartParamParseResult {
  if (startParam === null || startParam === undefined || startParam === '') {
    return { kind: 'NONE' };
  }
  if (!startParam.startsWith(REFERRAL_START_PREFIX)) {
    return { kind: 'NONE' };
  }
  const code = startParam.slice(REFERRAL_START_PREFIX.length);
  if (code === '') {
    return { kind: 'INVALID_REFERRAL_START_PARAM' };
  }
  return { kind: 'REFERRAL_CODE', code };
}
