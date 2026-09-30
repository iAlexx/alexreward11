/**
 * Pure Ton Connect manifest builder (presentation metadata only).
 * Origin must come from the request URL — never from client-supplied hosts.
 * Does NOT authorize ton_proof; WALLET_TON_PROOF_DOMAIN remains server authority.
 */

export const TONCONNECT_MANIFEST_NAME = 'LOOTRA';
export const TONCONNECT_MANIFEST_ICON_PATH = '/brand/lootra/l-accent.png';

export interface TonConnectManifest {
  readonly url: string;
  readonly name: string;
  readonly iconUrl: string;
}

/**
 * Build a Ton Connect manifest for the given Mini App origin.
 * `origin` must already be a valid absolute origin (scheme + host[+port]), no path.
 */
export function buildTonConnectManifest(origin: string): TonConnectManifest {
  const parsed = new URL(origin);
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('Ton Connect manifest origin must not include credentials');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('Ton Connect manifest origin must not include a path');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('Ton Connect manifest origin must not include query or hash');
  }

  const canonicalOrigin = parsed.origin;
  const iconUrl = new URL(TONCONNECT_MANIFEST_ICON_PATH, `${canonicalOrigin}/`).href;

  return {
    url: canonicalOrigin,
    name: TONCONNECT_MANIFEST_NAME,
    iconUrl,
  };
}