/**
 * Mainnet-only HTTP helpers for Phase 21 read-only probes.
 * Never use assertTestnetProviderUrl here. Never expose sendBoc.
 * Redact API keys from errors — hostname only.
 * Ceremony URLs: https only, no credentials, no query/fragment, host allowlist, no RFC1918.
 */
import { TON_MAINNET_NETWORK_GLOBAL_ID } from './chain-provider.js';
import { TonProviderHttpError, asRecord, fetchJson, fetchOk } from './provider-http.js';

const BODY_SNIPPET_LENGTH = 500;

/** Built-in Mainnet provider host allowlist (plus PHASE21_PROVIDER_HOST_ALLOWLIST). */
export const PHASE21_DEFAULT_PROVIDER_HOST_ALLOWLIST = [
  'toncenter.com',
  'www.toncenter.com',
  'tonapi.io',
  'www.tonapi.io',
  'mainnet.tonapi.io',
] as const;

export type MainnetProviderVerificationClass =
  | 'VERIFIED_PROVIDER_MAINNET_ENDPOINT'
  | 'PROVEN_FROM_CHAIN_RESPONSE'
  | 'INCOMPLETE';

export function normalizeMainnetProviderHost(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) return '';
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    try {
      return new URL(`https://${trimmed}`).hostname.toLowerCase();
    } catch {
      return '';
    }
  }
}

/** Strip credentials / query from error messages; keep hostname. */
export function redactProviderErrorMessage(message: string, providerUrl: string): string {
  const host = normalizeMainnetProviderHost(providerUrl) || 'provider';
  let out = message;
  try {
    const parsed = new URL(providerUrl);
    if (parsed.username) {
      out = out.split(parsed.username).join('[REDACTED]');
    }
    if (parsed.password) {
      out = out.split(parsed.password).join('[REDACTED]');
    }
    if (parsed.search) {
      out = out.split(parsed.search).join('');
    }
  } catch {
    // ignore
  }
  out = out.replace(/([?&](api_key|apikey|api-key|token|key)=)[^&\s]+/gi, '$1[REDACTED]');
  if (out.includes(providerUrl)) {
    out = out.split(providerUrl).join(host);
  }
  return out;
}

function isIpv4Literal(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

function isBlockedIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true;
  return false;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === 'localhost.' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '[::1]' ||
    host === '0.0.0.0'
  ) {
    return true;
  }
  if (host.includes('testnet')) return true;
  if (isIpv4Literal(host) && isBlockedIpv4(host)) return true;
  // IPv6 literals / bracketed forms — refuse for ceremony (no public Mainnet provider uses raw IPv6 URL).
  if (host.includes(':')) return true;
  return false;
}

function hostOnAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  for (const entry of allowlist) {
    const allowed = entry.trim().toLowerCase();
    if (allowed.length === 0) continue;
    if (host === allowed) return true;
    if (host.endsWith(`.${allowed}`)) return true;
  }
  return false;
}

export function resolvePhase21ProviderHostAllowlist(): readonly string[] {
  const fromEnv = process.env.PHASE21_PROVIDER_HOST_ALLOWLIST;
  const extras =
    fromEnv === undefined || fromEnv === null || fromEnv.trim() === ''
      ? []
      : fromEnv
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter((s) => s.length > 0);
  return [...PHASE21_DEFAULT_PROVIDER_HOST_ALLOWLIST, ...extras];
}

/**
 * Assert URL is a safe Mainnet ceremony provider endpoint.
 * - https only
 * - no username/password
 * - no query string / fragment (API keys must be headers/config, never URL)
 * - forbid localhost / loopback / link-local / RFC1918
 * - host must be on default allowlist or PHASE21_PROVIDER_HOST_ALLOWLIST
 * Does NOT alone prove networkGlobalId=-239 from chain response.
 */
export function assertMainnetProviderUrl(baseUrl: string, provider: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) {
    throw new Error(`${provider} requires a non-empty baseUrl`);
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${provider} requires a valid baseUrl`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`PROVIDER_URL_REJECTED: ${provider} requires https (got ${parsed.protocol})`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error(
      `PROVIDER_URL_REJECTED: ${provider} must not include username/password in URL`,
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(
      `PROVIDER_URL_REJECTED: ${provider} must not include query string or fragment (API keys via header/config only)`,
    );
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) {
    throw new Error(
      `PROVIDER_URL_REJECTED: ${provider} host=${hostname} is forbidden (localhost/private/testnet)`,
    );
  }
  const knownTestnetHost =
    hostname === 'testnet.toncenter.com' ||
    hostname === 'testnet.tonapi.io' ||
    hostname.startsWith('testnet.');
  if (knownTestnetHost || hostname.includes('testnet')) {
    throw new Error(`NETWORK_MISMATCH: ${provider} testnet host ${hostname} is forbidden`);
  }
  const allowlist = resolvePhase21ProviderHostAllowlist();
  if (!hostOnAllowlist(hostname, allowlist)) {
    throw new Error(
      `PROVIDER_URL_REJECTED: ${provider} host=${hostname} is not on Phase 21 provider allowlist`,
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * @deprecated Prefer X-API-Key / Authorization headers. Kept for non-ceremony callers;
 * ceremony assertMainnetProviderUrl rejects query on base URLs.
 */
export function appendApiKey(url: string, apiKey: string | null | undefined): string {
  if (apiKey === null || apiKey === undefined || apiKey.trim() === '') return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has('api_key')) {
    parsed.searchParams.set('api_key', apiKey.trim());
  }
  return parsed.toString();
}

export async function mainnetFetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: string,
  providerUrlForRedaction: string,
): Promise<unknown> {
  try {
    return await fetchJson(fetchImpl, url, init, context);
  } catch (error: unknown) {
    if (error instanceof TonProviderHttpError) {
      throw new TonProviderHttpError(
        error.status,
        redactProviderErrorMessage(error.bodySnippet, providerUrlForRedaction).slice(
          0,
          BODY_SNIPPET_LENGTH,
        ),
        `${context}@${normalizeMainnetProviderHost(providerUrlForRedaction)}`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactProviderErrorMessage(message, providerUrlForRedaction), {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export async function mainnetFetchOk(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: string,
  providerUrlForRedaction: string,
): Promise<Response> {
  try {
    return await fetchOk(fetchImpl, url, init, context);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(redactProviderErrorMessage(message, providerUrlForRedaction), {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export function resolveExpectedMainnetGlobalId(
  expectedNetworkGlobalId: number | null | undefined,
): number | null {
  if (expectedNetworkGlobalId === undefined || expectedNetworkGlobalId === null) return null;
  if (expectedNetworkGlobalId !== TON_MAINNET_NETWORK_GLOBAL_ID) return null;
  return TON_MAINNET_NETWORK_GLOBAL_ID;
}

export { asRecord, TonProviderHttpError };
