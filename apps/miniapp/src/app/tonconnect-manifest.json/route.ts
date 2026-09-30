import { buildTonConnectManifest } from '../../lib/tonconnect-manifest';

/**
 * Public Ton Connect app manifest.
 * Origin is derived from the incoming request URL only — no client host params.
 */
export function GET(request: Request): Response {
  const origin = new URL(request.url).origin;
  const body = buildTonConnectManifest(origin);
  return Response.json(body, {
    status: 200,
    headers: {
      'Cache-Control': 'public, max-age=60, must-revalidate',
    },
  });
}