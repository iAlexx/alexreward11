/**
 * Phase 17 Step 2 — pure public payout message renderer (no Telegram send).
 * Explorer URL is NOT embedded in text (button reserved for Step 3+).
 */

export type PublicPayoutIdentityMode = 'SHOW_USERNAME' | 'HIDE_IDENTITY';

export interface PublicPayoutMessageRenderInput {
  readonly identityMode: PublicPayoutIdentityMode;
  readonly usernameSnapshot: string | null;
  readonly amountFormatted: string;
  readonly assetSymbol: string;
  readonly networkLabel: string;
  readonly publicId: string;
  readonly confirmedDateUtc: string;
}

/** Typed delivery snapshot payload reserved for Step 3 sender. */
export interface PublicPayoutDeliverySnapshot {
  readonly messageText: string;
  readonly explorerUrl: string;
  readonly amountFormatted: string;
  readonly assetSymbol: string;
  readonly networkLabel: string;
  readonly publicId: string;
  readonly confirmedDateUtc: string;
  readonly identityMode: PublicPayoutIdentityMode;
  readonly usernameSnapshot: string | null;
}

export function renderPublicPayoutMessage(input: PublicPayoutMessageRenderInput): string {
  const userLine =
    input.identityMode === 'SHOW_USERNAME' &&
    input.usernameSnapshot !== null &&
    input.usernameSnapshot.trim() !== ''
      ? `User: @${input.usernameSnapshot.trim()}`
      : 'User: Anonymous User';

  return [
    '✅ Withdrawal Confirmed',
    userLine,
    `Amount: ${input.amountFormatted} ${input.assetSymbol}`,
    `Network: ${input.networkLabel}`,
    `Withdrawal: ${input.publicId}`,
    `Date: ${input.confirmedDateUtc}`,
  ].join('\n');
}
