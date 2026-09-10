import {
  assertTestnetOnly,
  TON_TESTNET_NETWORK_GLOBAL_ID,
} from './chain-provider.js';

const BODY_SNIPPET_LENGTH = 500;

export class TonProviderHttpError extends Error {
  readonly status: number;
  readonly bodySnippet: string;

  constructor(status: number, body: string, context: string) {
    const snippet = body.slice(0, BODY_SNIPPET_LENGTH);
    super(
      `TON provider HTTP ${status}${status === 429 ? ' RATE_LIMIT' : ''} for ${context}` +
        (snippet === '' ? '' : `: ${snippet}`),
    );
    this.name = 'TonProviderHttpError';
    this.status = status;
    this.bodySnippet = snippet;
  }
}

export function isTonProviderRateLimit(error: unknown): boolean {
  return error instanceof TonProviderHttpError && error.status === 429;
}

export function assertTestnetProviderUrl(baseUrl: string, provider: string): string {
  assertTestnetOnly(TON_TESTNET_NETWORK_GLOBAL_ID);
  const trimmed = baseUrl.trim();
  if (trimmed === '') {
    throw new Error(`${provider} requires a non-empty baseUrl`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${provider} requires a valid baseUrl`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const knownMainnetHost =
    (hostname === 'toncenter.com' || hostname === 'www.toncenter.com') ||
    (hostname === 'tonapi.io' || hostname === 'www.tonapi.io');
  if (knownMainnetHost || hostname.includes('mainnet')) {
    throw new Error(
      `NETWORK_MISMATCH: ${provider} must use Testnet; mainnet URL ${parsed.origin} is forbidden`,
    );
  }
  if (
    (hostname.endsWith('.toncenter.com') || hostname.endsWith('.tonapi.io')) &&
    !hostname.includes('testnet')
  ) {
    throw new Error(`NETWORK_MISMATCH: ${provider} URL does not identify Testnet`);
  }
  return trimmed.replace(/\/+$/, '');
}

export function assertTestnetResponse(value: unknown, context: string): void {
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const network = record.network ?? record.networkGlobalId ?? record.global_id;
  if (
    network === -239 ||
    (typeof network === 'string' && /mainnet|-239/i.test(network))
  ) {
    throw new Error(`NETWORK_MISMATCH: ${context} returned mainnet data`);
  }
}

export function assertOkTonCenterBody(
  body: unknown,
  context: string,
): asserts body is { ok: true; result: unknown } {
  if (body === null || typeof body !== 'object') {
    throw new Error(`MALFORMED_RESPONSE: ${context} did not return an object`);
  }
  assertTestnetResponse(body, context);
  const record = body as Record<string, unknown>;
  if (record.ok !== true || !('result' in record)) {
    const message =
      typeof record.error === 'string'
        ? record.error
        : typeof record.description === 'string'
          ? record.description
          : 'ok/result missing';
    throw new Error(`TONCENTER_ERROR: ${context}: ${message}`);
  }
}

export function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`MALFORMED_RESPONSE: ${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function decimalString(value: unknown, context: string): string {
  if (
    (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
    !/^\d+$/.test(String(value))
  ) {
    throw new Error(`MALFORMED_RESPONSE: ${context} must be an unsigned decimal integer`);
  }
  return String(value);
}

export function parseStackNumber(value: unknown, context: string): string {
  let raw = value;
  if (Array.isArray(value)) raw = value[1];
  if (raw !== null && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    raw = record.value ?? record.number;
  }
  if (typeof raw === 'number' || typeof raw === 'bigint') return String(raw);
  if (typeof raw !== 'string') {
    throw new Error(`MALFORMED_RESPONSE: ${context} stack number missing`);
  }
  try {
    return BigInt(raw).toString(10);
  } catch {
    throw new Error(`MALFORMED_RESPONSE: ${context} has invalid stack number`);
  }
}

export async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: string,
): Promise<unknown> {
  const response = await fetchOk(fetchImpl, url, init, context);
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`MALFORMED_RESPONSE: ${context} returned invalid JSON`);
  }
}

export async function fetchOk(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  context: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/timeout|timed?\s*out|abort/i.test(message) || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error(`TIMEOUT: TON provider request failed for ${context}: ${message}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!response.ok) {
    const text = await response.text();
    throw new TonProviderHttpError(response.status, text, context);
  }
  return response;
}
