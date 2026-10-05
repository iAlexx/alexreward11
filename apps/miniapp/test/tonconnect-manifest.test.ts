import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { GET } from '../src/app/tonconnect-manifest.json/route';
import {
  TONCONNECT_MANIFEST_ICON_PATH,
  TONCONNECT_MANIFEST_NAME,
  buildTonConnectManifest,
} from '../src/lib/tonconnect-manifest';

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const previousManifestUrl = process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL;

afterEach(() => {
  if (previousManifestUrl === undefined) {
    delete process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL;
  } else {
    process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL = previousManifestUrl;
  }
});

describe('buildTonConnectManifest', () => {
  it('returns LOOTRA name with origin url and same-origin absolute iconUrl', () => {
    const origin = 'https://miniapp-staging-production.up.railway.app';
    const manifest = buildTonConnectManifest(origin);
    expect(manifest.name).toBe('LOOTRA');
    expect(manifest.name).toBe(TONCONNECT_MANIFEST_NAME);
    expect(manifest.url).toBe(origin);
    expect(manifest.iconUrl).toBe(`${origin}${TONCONNECT_MANIFEST_ICON_PATH}`);
    expect(manifest.iconUrl.startsWith(origin)).toBe(true);
    expect(new URL(manifest.iconUrl).origin).toBe(origin);
  });

  it('does not embed API domain, secrets, or wallet addresses', () => {
    const manifest = buildTonConnectManifest('https://miniapp.example');
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toMatch(/api[-.]/i);
    expect(serialized).not.toMatch(/railway\.internal/i);
    expect(serialized).not.toMatch(/BOT_TOKEN|TELEGRAM|SECRET|PASSWORD/i);
    expect(serialized).not.toMatch(/EQ[A-Za-z0-9_-]{40,}/);
    expect(serialized).not.toMatch(/0:[a-f0-9]{64}/i);
  });

  it('rejects origins that carry path/query/credentials', () => {
    expect(() => buildTonConnectManifest('https://miniapp.example/app')).toThrow(/path/i);
    expect(() => buildTonConnectManifest('https://miniapp.example?x=1')).toThrow(/query/i);
    expect(() => buildTonConnectManifest('https://user:pass@miniapp.example')).toThrow(
      /credentials/i,
    );
  });
});

describe('GET /tonconnect-manifest.json', () => {
  it('uses configured public manifest origin instead of Railway/container request origin', async () => {
    process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL =
      'https://miniapp-staging-production.up.railway.app/tonconnect-manifest.json';

    const response = GET(new Request('https://0.0.0.0:3000/tonconnect-manifest.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/);

    const body = (await response.json()) as {
      url: string;
      name: string;
      iconUrl: string;
    };
    expect(body.name).toBe('LOOTRA');
    expect(body.url).toBe('https://miniapp-staging-production.up.railway.app');
    expect(body.iconUrl).toBe(
      'https://miniapp-staging-production.up.railway.app/brand/lootra/l-accent.png',
    );
    expect(body.url).not.toContain('0.0.0.0');
    expect(JSON.stringify(body)).not.toMatch(/BOT_TOKEN|SECRET|PASSWORD/i);
  });

  it('fails closed when public manifest URL is missing', async () => {
    delete process.env.NEXT_PUBLIC_TONCONNECT_MANIFEST_URL;
    const response = GET(new Request('https://0.0.0.0:3000/tonconnect-manifest.json'));
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps wallet fail-closed on missing NEXT_PUBLIC_TONCONNECT_MANIFEST_URL', async () => {
    const env = await readFile(join(srcRoot, 'lib/env.ts'), 'utf8');
    const screen = await readFile(join(srcRoot, 'components/WalletScreen.tsx'), 'utf8');
    expect(env).toMatch(/tonConnectManifestUrl/);
    expect(env).toMatch(/Never invents a production/);
    expect(screen).toMatch(/manifestUrl === null/);
    expect(screen).toMatch(/connectUnavailableTitle/);
    expect(screen).not.toMatch(/tonconnect-manifest\.json(?!["`])/);
  });
});
