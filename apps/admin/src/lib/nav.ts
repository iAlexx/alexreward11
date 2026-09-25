/**
 * Admin navigation — every Phase 13 Owner Control Plane area.
 * Labels are English-primary (Owner ops V1).
 */

export type AdminNavItem = {
  readonly href: string;
  readonly id: string;
  readonly label: string;
  readonly group: 'core' | 'policy' | 'providers' | 'ops';
};

export const ADMIN_NAV: readonly AdminNavItem[] = [
  { id: 'overview', href: '/overview', label: 'Overview', group: 'core' },
  { id: 'users', href: '/users', label: 'Users', group: 'core' },
  { id: 'withdrawals', href: '/withdrawals', label: 'Withdrawals', group: 'core' },
  { id: 'hot-wallet', href: '/hot-wallet', label: 'Hot Wallet', group: 'core' },
  { id: 'ledger', href: '/ledger', label: 'Ledger', group: 'core' },
  { id: 'ads', href: '/ads', label: 'Ads', group: 'core' },
  { id: 'reward-engine', href: '/reward-engine', label: 'Reward Engine', group: 'core' },
  { id: 'fraud', href: '/fraud', label: 'Fraud', group: 'core' },
  { id: 'referral', href: '/referral', label: 'Referral', group: 'core' },
  { id: 'support', href: '/support', label: 'Support', group: 'core' },
  { id: 'notifications', href: '/notifications', label: 'Notifications', group: 'core' },
  { id: 'audit', href: '/audit', label: 'Audit', group: 'core' },
  { id: 'system', href: '/system', label: 'System', group: 'core' },
  { id: 'settings', href: '/settings', label: 'Settings', group: 'core' },
  {
    id: 'memberships',
    href: '/memberships',
    label: 'Memberships/Founders',
    group: 'policy',
  },
  { id: 'policy-center', href: '/policy-center', label: 'Policy Center', group: 'policy' },
  { id: 'providers', href: '/providers', label: 'Providers', group: 'providers' },
  {
    id: 'provider-contracts',
    href: '/provider-contracts',
    label: 'Provider Contracts',
    group: 'providers',
  },
  { id: 'capabilities', href: '/capabilities', label: 'Capabilities', group: 'providers' },
  { id: 'limits', href: '/limits', label: 'Limits', group: 'providers' },
  { id: 'certification', href: '/certification', label: 'Certification', group: 'providers' },
  { id: 'country-rules', href: '/country-rules', label: 'Country Rules', group: 'providers' },
  { id: 'settlement', href: '/settlement', label: 'Settlement', group: 'providers' },
  { id: 'economics', href: '/economics', label: 'Economics', group: 'ops' },
  { id: 'exposure', href: '/exposure', label: 'Exposure', group: 'ops' },
  { id: 'review-queue', href: '/review-queue', label: 'Review Queue', group: 'ops' },
  { id: 'feature-flags', href: '/feature-flags', label: 'Feature Flags', group: 'ops' },
  { id: 'missions', href: '/missions', label: 'Mission Admin', group: 'ops' },
  {
    id: 'notification-campaigns',
    href: '/notification-campaigns',
    label: 'Notification Campaigns',
    group: 'ops',
  },
] as const;

export const ADMIN_NAV_GROUPS: ReadonlyArray<{
  readonly id: AdminNavItem['group'];
  readonly label: string;
}> = [
  { id: 'core', label: 'Core' },
  { id: 'policy', label: 'Policy & Membership' },
  { id: 'providers', label: 'Providers' },
  { id: 'ops', label: 'Operations' },
];

/** Required nav labels for completeness tests (exact Spec / Owner list). */
export const REQUIRED_NAV_LABELS: readonly string[] = [
  'Overview',
  'Users',
  'Withdrawals',
  'Hot Wallet',
  'Ledger',
  'Ads',
  'Reward Engine',
  'Fraud',
  'Referral',
  'Support',
  'Notifications',
  'Audit',
  'System',
  'Settings',
  'Memberships/Founders',
  'Policy Center',
  'Providers',
  'Provider Contracts',
  'Capabilities',
  'Limits',
  'Certification',
  'Country Rules',
  'Settlement',
  'Economics',
  'Exposure',
  'Review Queue',
  'Feature Flags',
  'Mission Admin',
  'Notification Campaigns',
];
