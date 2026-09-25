'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

const NAV_ITEMS = [
  { href: '/', key: 'home' as const },
  { href: '/earn', key: 'earn' as const },
  { href: '/tasks', key: 'tasks' as const },
  { href: '/friends', key: 'friends' as const },
  { href: '/wallet', key: 'wallet' as const },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomNav() {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const a11y = useTranslations('a11y');

  return (
    <nav className="alex-bottom-nav" aria-label={a11y('primaryNav')}>
      {NAV_ITEMS.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={active ? 'alex-bottom-nav__item is-active' : 'alex-bottom-nav__item'}
            aria-current={active ? 'page' : undefined}
          >
            <span>{t(item.key)}</span>
          </Link>
        );
      })}
    </nav>
  );
}
