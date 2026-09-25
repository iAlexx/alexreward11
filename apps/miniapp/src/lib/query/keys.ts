export const queryKeys = {
  home: ['me', 'home'] as const,
  balances: ['me', 'balances'] as const,
  settings: ['me', 'settings'] as const,
  membership: ['membership'] as const,
  entitlements: ['membership', 'entitlements'] as const,
  earnSummary: (provider: string) => ['ads', 'earn-summary', provider] as const,
  tasks: ['tasks'] as const,
  referrals: ['referrals', 'summary'] as const,
  wallets: ['wallets'] as const,
  withdrawals: ['withdrawals'] as const,
} as const;
