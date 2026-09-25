'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { ADMIN_NAV, ADMIN_NAV_GROUPS } from '../lib/nav';
import { strings } from '../lib/strings';
import { useAdminSession } from '../providers/AdminSessionProvider';

export function AppShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const { session, logout } = useAdminSession();
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  return (
    <div className="admin-shell">
      <a href="#admin-main" className="admin-skip">
        {strings.skipToMain}
      </a>
      <header className="admin-topbar">
        <button
          type="button"
          className="admin-button admin-button--ghost admin-nav-toggle"
          aria-expanded={navOpen}
          aria-controls="admin-nav"
          onClick={() => setNavOpen((v) => !v)}
        >
          Menu
        </button>
        <p className="admin-brand">{strings.appName}</p>
        <div className="admin-topbar__user">
          <span className="admin-meta">
            {session?.displayName ?? session?.email ?? 'Owner'}
          </span>
          <button type="button" className="admin-button admin-button--ghost" onClick={() => void logout()}>
            {strings.signOut}
          </button>
        </div>
      </header>
      <div className="admin-body">
        <nav
          id="admin-nav"
          className={`admin-nav${navOpen ? ' is-open' : ''}`}
          aria-label={strings.navLandmark}
        >
          {ADMIN_NAV_GROUPS.map((group) => (
            <div key={group.id} className="admin-nav__group">
              <p className="admin-nav__group-label">{group.label}</p>
              <ul>
                {ADMIN_NAV.filter((item) => item.group === group.id).map((item) => {
                  const active =
                    pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <li key={item.id}>
                      <Link
                        href={item.href}
                        className={active ? 'is-active' : undefined}
                        aria-current={active ? 'page' : undefined}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <main id="admin-main" className="admin-main" aria-label={strings.mainLandmark} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
