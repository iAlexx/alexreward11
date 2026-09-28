/** Canonical bottom-nav routes — keep in sync with BottomNav icons/labels. */
export const BOTTOM_NAV_ROUTES = ['/', '/earn', '/tasks', '/friends', '/wallet'] as const;

export type BottomNavHref = (typeof BOTTOM_NAV_ROUTES)[number];

export const BOTTOM_NAV_ITEMS = [
  { href: '/', key: 'home' as const },
  { href: '/earn', key: 'earn' as const },
  { href: '/tasks', key: 'tasks' as const },
  { href: '/friends', key: 'friends' as const },
  { href: '/wallet', key: 'wallet' as const },
] as const;
