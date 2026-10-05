'use client';

import { useTranslations } from 'next-intl';

type EngineVariant = 'tasks' | 'friends';

/**
 * Branded intentional unavailable state for product engines that are not enabled yet.
 * Distinct from network ERROR and from an empty READY list.
 * Presentation only — no backend logic, no fake CTAs.
 */
export function EngineUnavailableState({
  variant,
}: {
  readonly variant: EngineVariant;
}) {
  const t = useTranslations(variant);
  const accent =
    variant === 'tasks' ? '/brand/lootra/tasks-hero.png' : '/brand/lootra/l-accent.png';

  return (
    <section
      className="lootra-engine-unavailable"
      role="status"
      aria-labelledby={`lootra-engine-${variant}-title`}
    >
      <div className="lootra-engine-unavailable__visual" aria-hidden="true">
        <span className="lootra-engine-unavailable__orbit" />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand accent */}
        <img
          className="lootra-engine-unavailable__art"
          src={accent}
          alt=""
          width={120}
          height={120}
        />
      </div>
      <div className="lootra-engine-unavailable__copy">
        <h2 id={`lootra-engine-${variant}-title`} className="alex-title-sm">
          {t('engineTitle')}
        </h2>
        <p className="alex-muted">{t('engineBody')}</p>
        <p className="alex-meta">{t('comingSoon')}</p>
      </div>
    </section>
  );
}
