import type { ControlCenterPermissionCode } from './permissions.js';

/** Database `environment_name` enum values used by telegram_destinations. */
export type ControlCenterEnvironment = 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';

/**
 * All 11 Control Center Forum Topic destination purposes.
 * Reports maps to CONTROL_CENTER_DAILY_REPORT (locked plan decision).
 */
export const CONTROL_CENTER_DESTINATION_PURPOSES = [
  'CONTROL_CENTER_APPROVALS',
  'CONTROL_CENTER_PAYOUTS',
  'CONTROL_CENTER_WARNINGS',
  'CONTROL_CENTER_CRITICAL',
  'CONTROL_CENTER_FRAUD',
  'CONTROL_CENTER_WALLET',
  'CONTROL_CENTER_ADS',
  'CONTROL_CENTER_DAILY_REPORT',
  'CONTROL_CENTER_SUPPORT',
  'CONTROL_CENTER_AUDIT',
  'CONTROL_CENTER_SYSTEM',
] as const;

export type ControlCenterDestinationPurpose = (typeof CONTROL_CENTER_DESTINATION_PURPOSES)[number];

export type ControlCenterTopicKey =
  | 'APPROVALS'
  | 'PAYOUTS'
  | 'WARNINGS'
  | 'CRITICAL'
  | 'FRAUD'
  | 'WALLET'
  | 'ADS'
  | 'REPORTS'
  | 'SUPPORT'
  | 'AUDIT'
  | 'SYSTEM';

export interface TelegramDestinationRow {
  readonly id: string;
  readonly environment: ControlCenterEnvironment;
  readonly purpose: ControlCenterDestinationPurpose;
  readonly chatId: string;
  readonly topicThreadId: string | null;
  readonly title: string | null;
  readonly enabled: boolean;
}

export interface AdminActionTokenRow {
  readonly id: string;
  readonly adminUserId: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly tokenHash: string;
  readonly source: 'TELEGRAM' | 'WEB' | 'API' | 'SYSTEM' | 'AUTO_POLICY';
  readonly requiresSecondConfirmation: boolean;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly confirmedAt: Date | null;
  readonly consumedAt: Date | null;
  readonly consumedByAdminId: string | null;
  readonly expectedState: string | null;
  readonly destinationId: string;
  readonly boundChatId: string;
  readonly boundTopicThreadId: string | null;
  readonly nonce: string;
  readonly confirmationOfTokenId: string | null;
}

export interface AuthorizeOwnerActionInput {
  readonly telegramUserId: string;
  readonly permissionCode: ControlCenterPermissionCode;
  readonly chatId: string;
  readonly topicThreadId: string | null;
  readonly environment: ControlCenterEnvironment;
}

export interface AuthorizedOwnerContext {
  readonly adminUserId: string;
  readonly telegramUserId: string;
  readonly permissionCode: ControlCenterPermissionCode;
}

export type WithdrawalTelegramDecision = 'APPROVE' | 'HOLD' | 'REJECT';

export const WITHDRAWAL_ACTION_TYPES = {
  APPROVE: 'withdrawal.decide.APPROVE',
  HOLD: 'withdrawal.decide.HOLD',
  REJECT: 'withdrawal.decide.REJECT',
} as const;

export type WithdrawalActionType =
  (typeof WITHDRAWAL_ACTION_TYPES)[keyof typeof WITHDRAWAL_ACTION_TYPES];

export interface ControlCenterCallbackUpdate {
  readonly callbackQueryId: string;
  readonly callbackData: string;
  readonly telegramUserId: string;
  readonly chatId: string;
  readonly topicThreadId: string | null;
  readonly messageId?: number;
}

export interface ControlCenterCallbackResult {
  readonly ok: boolean;
  readonly telegramText: string;
  readonly actionType?: string;
  readonly resourceId?: string | null;
  readonly alreadyProcessed?: boolean;
}
