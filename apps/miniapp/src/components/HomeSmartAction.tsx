'use client';

import { useTranslations } from 'next-intl';

import type { HomeSmartActionModel } from '../lib/home/home-smart-action';
import { AppLink } from './AppLink';
import { IconChevron } from './NavIcons';

export function HomeSmartAction({ action }: { readonly action: HomeSmartActionModel }) {
  const t = useTranslations('home');

  const title = t(action.titleKey);
  const body =
    action.kind === 'active_withdrawal'
      ? t(action.bodyKey, {
          state: t('withdrawalStateLabel', { state: action.withdrawalState ?? '' }),
        })
      : t(action.bodyKey);

  return (
    <AppLink href={action.href} className="lootra-smart-action" aria-label={title}>
      <div className="lootra-smart-action__copy">
        <p className="lootra-smart-action__title">{title}</p>
        <p className="lootra-smart-action__body">{body}</p>
      </div>
      <span className="lootra-smart-action__chevron icon-directional" aria-hidden="true">
        <IconChevron size={18} />
      </span>
    </AppLink>
  );
}
