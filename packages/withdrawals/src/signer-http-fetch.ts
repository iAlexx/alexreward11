import { fetch as undiciFetch, ProxyAgent, type RequestInit as UndiciRequestInit } from 'undici';

export interface CreateSignerHttpFetchOptions {
  /**
   * Explicit HTTP proxy URL for Signer calls only.
   * - `undefined` → read `HTTP_PROXY` / `http_proxy` (Tailscale userspace).
   * - `null` / `''` → direct fetch (no proxy).
   */
  readonly proxyUrl?: string | null;
  /** Injected fetch (tests). When set, proxy wiring is skipped. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Resolve the loopback HTTP proxy used for Tailscale userspace Signer access.
 * Signer is HTTP over the encrypted Tailnet; HTTPS_PROXY is intentionally ignored.
 */
export function resolveSignerHttpProxyUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const proxy = env.HTTP_PROXY ?? env.http_proxy;
  if (typeof proxy !== 'string') {
    return null;
  }
  const trimmed = proxy.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Signer-scoped fetch that routes through an explicit Undici ProxyAgent when an
 * HTTP proxy is configured.
 *
 * Why not rely solely on Node `NODE_USE_ENV_PROXY` global fetch:
 * WD-000001 attempt #2 lost a completed Signer HTTP 200 (~2780 bytes) after
 * WireGuard delivery while env-proxy fetch never completed body consumption.
 * Explicit ProxyAgent + `proxyTunnel: false` keeps absolute-form HTTP forwarding
 * (required for Tailscale `--outbound-http-proxy-listen`) scoped only to Signer
 * calls — no global dispatcher mutation.
 */
export function createSignerHttpFetch(
  options: CreateSignerHttpFetchOptions = {},
): typeof fetch {
  if (options.fetchImpl !== undefined) {
    return options.fetchImpl;
  }

  const proxyUrl =
    options.proxyUrl !== undefined ? options.proxyUrl : resolveSignerHttpProxyUrl();
  if (proxyUrl === null || proxyUrl === '') {
    return globalThis.fetch.bind(globalThis);
  }

  const agent = new ProxyAgent({
    uri: proxyUrl,
    // Plain HTTP Signer targets must use absolute-form forwarding, not CONNECT.
    proxyTunnel: false,
  });

  const proxiedFetch: typeof fetch = async (input, init) => {
    const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(init as UndiciRequestInit | undefined),
      dispatcher: agent,
    });
    return response as unknown as Response;
  };

  return proxiedFetch;
}
