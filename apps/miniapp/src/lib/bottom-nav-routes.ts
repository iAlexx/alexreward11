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

/** Exact match for Home; prefix match for other primary sections. */
export function isPrimaryNavActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Index of the matching primary tab, or `null` on secondary routes
 * (`/profile`, `/notifications`, `/activity`, …) so no Home indicator is fabricated.
 */
export function resolvePrimaryNavActiveIndex(pathname: string): number | null {
  const index = BOTTOM_NAV_ITEMS.findIndex((item) => isPrimaryNavActive(pathname, item.href));
  return index >= 0 ? index : null;
}
