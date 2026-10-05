import { useTranslations } from 'next-intl';

/** Simplified LOOTRA L mark + wordmark. Brand mark is non-directional (no RTL flip). */
export function LootraBrand({ size = 'md' }: { readonly size?: 'sm' | 'md' }) {
  const t = useTranslations('app');
  return (
    <div className={`lootra-brand lootra-brand--${size}`} aria-label={t('brand')}>
      <span className="lootra-brand__mark" aria-hidden="true" />
      <span className="lootra-brand__word">{t('brand')}</span>
    </div>
  );
}
