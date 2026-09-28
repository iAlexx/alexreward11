'use client';

import type { CSSProperties } from 'react';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import {
  BOTTOM_NAV_ITEMS,
  isPrimaryNavActive,
  resolvePrimaryNavActiveIndex,
} from '../lib/bottom-nav-routes';
import { AppLink } from './AppLink';
import { IconEarn, IconFriends, IconHome, IconTasks, IconWallet } from './NavIcons';

const ICONS = {
  home: IconHome,
  earn: IconEarn,
  tasks: IconTasks,
  friends: IconFriends,
  wallet: IconWallet,
} as const;

export function BottomNav() {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const a11y = useTranslations('a11y');

  const activeIndex = resolvePrimaryNavActiveIndex(pathname);

  return (
    <nav
      className="lootra-bottom-nav"
      aria-label={a11y('primaryNav')}
      style={
        activeIndex === null
          ? undefined
          : ({ '--active-index': activeIndex } as CSSProperties)
      }
      data-active-index={activeIndex === null ? undefined : String(activeIndex)}
    >
      {activeIndex !== null ? (
        <span className="lootra-nav-indicator" aria-hidden="true" />
      ) : null}
      {BOTTOM_NAV_ITEMS.map((item) => {
        const active = isPrimaryNavActive(pathname, item.href);
        const Icon = ICONS[item.key];
        return (
          <AppLink
            key={item.href}
            href={item.href}
            className={active ? 'lootra-bottom-nav__item is-active' : 'lootra-bottom-nav__item'}
            aria-current={active ? 'page' : undefined}
          >
            <span className="lootra-bottom-nav__icon">
              <Icon size={20} />
            </span>
            <span className="lootra-bottom-nav__label">{t(item.key)}</span>
          </AppLink>
        );
      })}
    </nav>
  );
}
