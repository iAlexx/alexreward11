/** Permission codes seeded by migration 0019 (OWNER role only in V1). */
export const CONTROL_CENTER_PERMISSIONS = {
  WITHDRAWAL_REVIEW_DECIDE: 'withdrawal.review.decide',
  REVIEW_QUEUE_OPERATE: 'review_queue.operate',
  FOUNDER_SEARCH: 'founder.search',
  FOUNDER_GRANT: 'founder.grant',
  FOUNDER_CLAIM_CODE_ISSUE: 'founder.claim_code.issue',
  FOUNDER_HISTORY_VIEW: 'founder.history.view',
  ADMIN_ACTION_CONFIRM_HIGH_IMPACT: 'admin.action.confirm_high_impact',
} as const;

export type ControlCenterPermissionCode =
  (typeof CONTROL_CENTER_PERMISSIONS)[keyof typeof CONTROL_CENTER_PERMISSIONS];

export const ALL_CONTROL_CENTER_PERMISSION_CODES: readonly ControlCenterPermissionCode[] =
  Object.values(CONTROL_CENTER_PERMISSIONS);
