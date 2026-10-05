import { buildTonConnectManifest } from '../../lib/tonconnect-manifest';

const MANIFEST_ENV = 'NEXT_PUBLIC_TONCONNECT_MANIFEST_URL';

/**
 * Public Ton Connect app manifest.
 *
 * Railway terminates TLS before Next.js, so `request.url` may contain the
 * container bind address (for example https://0.0.0.0:3000). The manifest
 * authority must therefore come from the server-controlled public manifest
 * URL, never from forwarded/client Host headers.
 */
export function GET(_request: Request): Response {
  const configuredManifestUrl = process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL?.trim();

  if (configuredManifestUrl === undefined || configuredManifestUrl === '') {
    return manifestUnavailable(`${MANIFEST_ENV} is not configured`);
  }

  try {
    const configuredUrl = new URL(configuredManifestUrl);
    if (configuredUrl.protocol !== 'https:' && configuredUrl.protocol !== 'http:') {
      return manifestUnavailable(`${MANIFEST_ENV} must use http(s)`);
    }

    const body = buildTonConnectManifest(configuredUrl.origin);
    return Response.json(body, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=60, must-revalidate',
      },
    });
  } catch {
    return manifestUnavailable(`${MANIFEST_ENV} is invalid`);
  }
}

function manifestUnavailable(reason: string): Response {
  return Response.json(
    { error: 'TONCONNECT_MANIFEST_UNAVAILABLE', message: reason },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );
}
