import type { DomainEnvelope, HomeSummaryResponse } from '@alex-rewards/contracts';

const FUTURE_ENGINE_KEYS = new Set(['missions', 'referrals'] as const);

function isEnvelope(value: unknown): value is DomainEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof (value as DomainEnvelope<unknown>).status === 'string'
  );
}

/**
 * True when UNAVAILABLE is an intentional not-yet-enabled product engine
 * (ENGINE_NOT_ENABLED), not a scary home-wide failure.
 */
export function isIntentionalEngineUnavailable(
  key: string,
  envelope: DomainEnvelope<unknown>,
): boolean {
  return (
    FUTURE_ENGINE_KEYS.has(key as 'missions' | 'referrals') &&
    envelope.status === 'UNAVAILABLE' &&
    envelope.errorCode === 'ENGINE_NOT_ENABLED'
  );
}

/**
 * Global Home surface state. ENGINE_NOT_ENABLED on missions/referrals must not
 * mark the whole Home as degraded. Real READ_FAILED / other UNAVAILABLE domains do.
 */
export function deriveHomeSurfaceState(home: HomeSummaryResponse): 'READY' | 'DEGRADED' {
  const entries: ReadonlyArray<readonly [string, DomainEnvelope<unknown>]> = [
    ['balances', home.balances],
    ['todayAds', home.todayAds],
    ['missions', home.missions],
    ['referrals', home.referrals],
    ['latestWithdrawal', home.latestWithdrawal],
    ['announcement', home.announcement],
    ['membershipBrief', home.membershipBrief],
  ];

  for (const [key, envelope] of entries) {
    if (!isEnvelope(envelope)) continue;
    if (envelope.status !== 'UNAVAILABLE') continue;
    if (isIntentionalEngineUnavailable(key, envelope)) continue;
    return 'DEGRADED';
  }
  return 'READY';
}
