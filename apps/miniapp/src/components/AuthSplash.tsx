'use client';

import { useTranslations } from 'next-intl';

/**
 * Presentation-only splash while auth status === LOADING.
 * Does not delay, gate, or fake authentication.
 */
export function AuthSplash() {
  const t = useTranslations('auth');
  const app = useTranslations('app');

  return (
    <div className="lootra-splash" role="status" aria-live="polite" aria-label={t('loading')}>
      <span className="lootra-cosmic-particle lootra-particle-one" aria-hidden="true" />
      <span className="lootra-cosmic-particle lootra-particle-two" aria-hidden="true" />
      <span className="lootra-cosmic-particle lootra-particle-three" aria-hidden="true" />
      <span className="lootra-scene-panel lootra-panel-left" aria-hidden="true" />
      <span className="lootra-scene-panel lootra-panel-right" aria-hidden="true" />
      <div className="lootra-splash-orbit">
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img
          className="lootra-splash-brand-art"
          src="/brand/lootra/rewards-hero.png"
          alt=""
          aria-hidden="true"
          width={390}
          height={330}
        />
      </div>
      <h1 className="lootra-splash-wordmark">{app('brand')}</h1>
      <p className="lootra-splash-tagline">{app('tagline')}</p>
    </div>
  );
}
