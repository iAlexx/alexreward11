'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import {
  hasCompletedOnboarding,
  markOnboardingComplete,
} from '../lib/onboarding-preference';
import { LootraBrand } from './LootraBrand';
import { IconChevron } from './NavIcons';

const STEPS = [
  {
    asset: '/brand/lootra/rewards-hero.png',
    titleKey: 'step1Title' as const,
    bodyKey: 'step1Body' as const,
  },
  {
    asset: '/brand/lootra/tasks-hero.png',
    titleKey: 'step2Title' as const,
    bodyKey: 'step2Body' as const,
  },
  {
    asset: '/brand/lootra/wallet-hero.png',
    titleKey: 'step3Title' as const,
    bodyKey: 'step3Body' as const,
  },
] as const;

/**
 * PRESENTATION_ONLY_LOCAL onboarding after auth READY.
 * Completion is stored in localStorage key lootra:onboarding:v1 (non-sensitive).
 */
export function OnboardingGate({ children }: { readonly children: ReactNode }) {
  const t = useTranslations('onboarding');
  const [completed, setCompleted] = useState<boolean | null>(null);
  const [step, setStep] = useState(0);

  useEffect(() => {
    setCompleted(hasCompletedOnboarding());
  }, []);

  const finish = () => {
    markOnboardingComplete();
    setCompleted(true);
  };

  if (completed === null) {
    return <div className="lootra-onboarding-boot" aria-hidden="true" />;
  }

  if (completed) {
    return <>{children}</>;
  }

  const current = STEPS[step] ?? STEPS[0];
  const isLast = step >= STEPS.length - 1;

  return (
    <main className="lootra-onboarding" aria-label={t('ariaLabel')}>
      <div className="lootra-onboarding-top">
        <LootraBrand size="sm" />
        <button type="button" className="lootra-btn lootra-btn--ghost" onClick={finish}>
          {t('skip')}
        </button>
      </div>

      <section className={`lootra-onboarding-visual visual-${step}`} aria-hidden="true">
        <span className="lootra-scene-panel lootra-onboarding-panel" />
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
        <img
          className="lootra-onboarding-brand-art"
          src={current.asset}
          alt=""
          width={400}
          height={340}
        />
      </section>

      <section className="lootra-onboarding-copy">
        <p className="lootra-eyebrow">{t('eyebrow', { step: step + 1 })}</p>
        <h1 className="lootra-onboarding-title">{t(current.titleKey)}</h1>
        <p className="lootra-onboarding-body">{t(current.bodyKey)}</p>
      </section>

      <div className="lootra-onboarding-footer">
        <div className="lootra-onboarding-dots" aria-hidden="true">
          {STEPS.map((_, index) => (
            <span key={index} className={index === step ? 'is-active' : undefined} />
          ))}
        </div>
        <button
          type="button"
          className="lootra-btn lootra-btn--primary"
          onClick={() => {
            if (isLast) finish();
            else setStep((value) => value + 1);
          }}
        >
          {isLast ? t('getStarted') : t('next')}
          <span className="icon-directional" aria-hidden="true">
            <IconChevron size={18} />
          </span>
        </button>
      </div>
    </main>
  );
}
