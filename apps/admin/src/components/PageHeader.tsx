'use client';

import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly actions?: ReactNode | undefined;
}) {
  return (
    <header className="admin-page-header">
      <div>
        <h1 className="admin-title">{title}</h1>
        {description !== undefined ? <p className="admin-muted">{description}</p> : null}
      </div>
      {actions !== undefined ? <div className="admin-page-header__actions">{actions}</div> : null}
    </header>
  );
}
