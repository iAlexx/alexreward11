/**
 * Mainnet-only HTTP helpers for Phase 21 read-only probes.
 * Never use assertTestnetProviderUrl here. Never expose sendBoc.
 * Redact API keys from errors ? hostname only.
 */
import { TON_MAINNET_NETWORK_GLOBAL_ID } from './chain-provider.js';
import { TonProviderHttpError, asRecord, fetchJson, fetchOk } from './provider-http.js';

const BODY_SNIPPET_LENGTH = 500;

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

/**
 * Assert URL identifies Mainnet (not Testnet).
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
  const hostname = parsed.hostname.toLowerCase();
  if (hostname.includes('testnet')) {
    throw new Error(
      `NETWORK_MISMATCH: ${provider} must use Mainnet; testnet URL host=${hostname} is forbidden`,
    );
  }
  const knownTestnetHost =
    hostname === 'testnet.toncenter.com' ||
    hostname === 'testnet.tonapi.io' ||
    hostname.startsWith('testnet.');
  if (knownTestnetHost) {
    throw new Error(`NETWORK_MISMATCH: ${provider} testnet host ${hostname} is forbidden`);
  }
  return trimmed.replace(/\/+$/, '');
}

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
