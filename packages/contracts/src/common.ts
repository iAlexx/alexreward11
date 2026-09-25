/**
 * Shared Mini App read-model vocabulary (Phase 12).
 *
 * The frontend holds no financial authority: every value it renders is produced by an API
 * read model declared here. A domain that cannot be read honestly says so with a status and
 * a reason code — it never degrades into a fabricated zero-value "success".
 */

export type LocaleCode = 'ar' | 'en' | 'ru';

export const SUPPORTED_LOCALE_CODES: readonly LocaleCode[] = ['ar', 'en', 'ru'];

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === 'string' && (SUPPORTED_LOCALE_CODES as readonly string[]).includes(value);
}

/**
 * Availability of one read-model domain.
 *
 * `LOADING` is client-only: the server never emits it, because a server response always
 * knows whether it could read the domain or not.
 */
export type DomainAvailability = 'READY' | 'EMPTY' | 'UNAVAILABLE' | 'LOADING';

/** The subset of {@link DomainAvailability} an API response may contain. */
export type ServerDomainAvailability = Exclude<DomainAvailability, 'LOADING'>;

/**
 * Why a domain is not READY.
 *
 * `ENGINE_NOT_ENABLED` is the honest answer for a product engine that has not been built
 * and approved yet; it is never used to hide a runtime failure, which is `READ_FAILED`.
 */
export type DomainReasonCode =
  'ENGINE_NOT_ENABLED' | 'READ_FAILED' | 'NOT_CONFIGURED' | 'NO_DATA' | 'MONETARY_BLOCKED';

/** One domain slot inside a composite response. */
export interface DomainEnvelope<TData> {
  readonly status: ServerDomainAvailability;
  readonly data: TData | null;
  readonly errorCode?: DomainReasonCode;
}
