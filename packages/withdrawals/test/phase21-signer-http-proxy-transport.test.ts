import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import {
  EnvHttpProxyAgent,
  ProxyAgent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from 'undici';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SignerHttpClient,
  createSignerHttpFetch,
  fetchTextWithDeadline,
  resolveSignerHttpProxyUrl,
} from '../src/index.js';

/** Target body size matching WD-000001 nginx evidence (~2780 bytes). */
const SYNTHETIC_BODY_TARGET_BYTES = 2780;

type StartedHttp = {
  readonly server: Server;
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
};

function buildSyntheticSignerSignBody(targetBytes: number): string {
  // Fake Signer-shaped payload — never calls a real signing endpoint.
  const base = {
    withdrawalAttemptId: '00000000-0000-4000-8000-0000000000aa',
    withdrawalId: '00000000-0000-4000-8000-0000000000bb',
    canonicalMessageHash: 'ab'.repeat(32),
    canonicalSigningHash: 'ab'.repeat(32),
    signedMessageHash: 'cd'.repeat(32),
    normalizedExternalMessageHash: 'cd'.repeat(32),
    publicKeyFingerprint: 'ef'.repeat(32),
    walletAddressRaw: `0:${'11'.repeat(32)}`,
    signatureBase64: Buffer.alloc(64, 7).toString('base64'),
    keySpec: 'synthetic-local-test',
    signingAlgorithm: 'ed25519',
    signedWalletRequestBocBase64: 'd2FsbGV0',
    externalMessageBocBase64: '',
    externalMessageCellHash: '22'.repeat(32),
    signatureFingerprintHash: '33'.repeat(32),
    syntheticPad: '',
  };
  let padLen = 0;
  for (;;) {
    base.syntheticPad = 'P'.repeat(padLen);
    base.externalMessageBocBase64 = Buffer.from(`synthetic-boc-${padLen}`).toString('base64');
    const json = JSON.stringify(base);
    if (json.length >= targetBytes) {
      return json;
    }
    padLen += Math.max(1, targetBytes - json.length);
  }
}

async function listen(server: Server): Promise<StartedHttp> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('expected TCP listen address');
  }
  return {
    server,
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    },
  };
}

async function startSyntheticOrigin(body: string): Promise<StartedHttp & { readonly hits: number }> {
  const state = { hits: 0 };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    // Intentionally NOT /v1/sign-withdrawal-attempt — synthetic only.
    if (req.method === 'POST' && req.url === '/v1/synthetic-signer-response') {
      state.hits += 1;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-synthetic-signer': '1',
        });
        res.end(body);
      });
      return;
    }
    res.writeHead(404);
    res.end('not-found');
  });
  const started = await listen(server);
  return {
    ...started,
    get hits() {
      return state.hits;
    },
  };
}

/**
 * Minimal absolute-form HTTP forward proxy (Tailscale outbound-http-proxy shape).
 * CONNECT returns 405 so forced tunneling fails fast.
 */
async function startForwardHttpProxy(): Promise<
  StartedHttp & { readonly forwarded: Array<{ method: string; url: string }> }
> {
  const forwarded: Array<{ method: string; url: string }> = [];
  const server = http.createServer((clientReq, clientRes) => {
    if (clientReq.method === 'CONNECT') {
      clientRes.writeHead(405, { connection: 'close' });
      clientRes.end('CONNECT not supported in synthetic proxy');
      return;
    }
    const targetUrl = clientReq.url ?? '';
    if (!/^https?:\/\//i.test(targetUrl)) {
      clientRes.writeHead(400);
      clientRes.end('expected absolute-form URL');
      return;
    }
    forwarded.push({ method: clientReq.method ?? 'GET', url: targetUrl });
    const upstream = new URL(targetUrl);
    const headers: http.OutgoingHttpHeaders = { ...clientReq.headers, host: upstream.host };
    delete headers['proxy-connection'];
    const uReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || 80,
        path: `${upstream.pathname}${upstream.search}`,
        method: clientReq.method,
        headers,
      },
      (uRes) => {
        clientRes.writeHead(uRes.statusCode ?? 502, uRes.headers);
        uRes.pipe(clientRes);
      },
    );
    uReq.on('error', (err) => {
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
      }
      clientRes.end(String(err));
    });
    clientReq.pipe(uReq);
  });
  const started = await listen(server);
  return Object.assign(started, { forwarded });
}

const cleanups: Array<() => Promise<void>> = [];
const dispatcherStack: ReturnType<typeof getGlobalDispatcher>[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
  while (dispatcherStack.length > 0) {
    const prev = dispatcherStack.pop();
    if (prev) setGlobalDispatcher(prev);
  }
}, 15_000);

describe('phase21 Signer HTTP proxy transport (synthetic, no live signer)', () => {
  it('builds a synthetic Signer-shaped body near 2780 bytes', () => {
    const body = buildSyntheticSignerSignBody(SYNTHETIC_BODY_TARGET_BYTES);
    expect(body.length).toBeGreaterThanOrEqual(SYNTHETIC_BODY_TARGET_BYTES);
    expect(body.length).toBeLessThan(SYNTHETIC_BODY_TARGET_BYTES + 64);
    expect(body).toContain('synthetic-local-test');
    expect(body).not.toContain('sign-withdrawal-attempt');
  });

  it('resolveSignerHttpProxyUrl reads HTTP_PROXY only', () => {
    expect(resolveSignerHttpProxyUrl({ HTTP_PROXY: 'http://127.0.0.1:1055' })).toBe(
      'http://127.0.0.1:1055',
    );
    expect(resolveSignerHttpProxyUrl({ http_proxy: 'http://127.0.0.1:1055' })).toBe(
      'http://127.0.0.1:1055',
    );
    expect(resolveSignerHttpProxyUrl({ HTTPS_PROXY: 'http://127.0.0.1:1055' })).toBeNull();
    expect(resolveSignerHttpProxyUrl({})).toBeNull();
  });

  it('REPRODUCTION A: ProxyAgent+proxyTunnel:false consumes ~2780B via HTTP proxy', { timeout: 15_000 }, async () => {
    const body = buildSyntheticSignerSignBody(SYNTHETIC_BODY_TARGET_BYTES);
    const origin = await startSyntheticOrigin(body);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());

    const target = `${origin.baseUrl}/v1/synthetic-signer-response`;
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const agentFetch = createSignerHttpFetch({ proxyUrl });
    const viaAgent = await fetchTextWithDeadline(
      agentFetch,
      target,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"probe":1}' },
      5_000,
    );
    expect(viaAgent.response.status).toBe(200);
    expect(viaAgent.text.length).toBe(body.length);
    expect(viaAgent.text).toBe(body);
    expect(proxy.forwarded.some((f) => f.method === 'POST')).toBe(true);
    expect(origin.hits).toBe(1);
  });

  it('REPRODUCTION B: EnvHttpProxyAgent stalls on absolute-form HTTP proxy (documents failure mode)', { timeout: 10_000 }, async () => {
    const body = buildSyntheticSignerSignBody(SYNTHETIC_BODY_TARGET_BYTES);
    const origin = await startSyntheticOrigin(body);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());

    const target = `${origin.baseUrl}/v1/synthetic-signer-response`;
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const prevHttp = process.env.HTTP_PROXY;
    const prevHttpLower = process.env.http_proxy;
    process.env.HTTP_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    try {
      const envAgent = new EnvHttpProxyAgent();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1_500);
      try {
        await expect(
          undiciFetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"probe":2}',
            dispatcher: envAgent,
            signal: ctrl.signal,
          }).then((r) => r.text()),
        ).rejects.toMatchObject({ name: 'AbortError' });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      if (prevHttp === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prevHttp;
      if (prevHttpLower === undefined) delete process.env.http_proxy;
      else process.env.http_proxy = prevHttpLower;
    }
  });

  it('REPRODUCTION C: global EnvHttpProxyAgent stalls (NODE_USE_ENV_PROXY failure mode)', { timeout: 10_000 }, async () => {
    const body = buildSyntheticSignerSignBody(SYNTHETIC_BODY_TARGET_BYTES);
    const origin = await startSyntheticOrigin(body);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());

    const target = `${origin.baseUrl}/v1/synthetic-signer-response`;
    const proxyUrl = `http://127.0.0.1:${proxy.port}`;
    const prevHttp = process.env.HTTP_PROXY;
    const prevHttpLower = process.env.http_proxy;
    const prevDispatcher = getGlobalDispatcher();
    process.env.HTTP_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    setGlobalDispatcher(new EnvHttpProxyAgent());
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1_500);
      try {
        await expect(
          undiciFetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"probe":3}',
            signal: ctrl.signal,
          }).then((r) => r.text()),
        ).rejects.toMatchObject({ name: 'AbortError' });
      } finally {
        clearTimeout(timer);
      }
    } finally {
      setGlobalDispatcher(prevDispatcher);
      if (prevHttp === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prevHttp;
      if (prevHttpLower === undefined) delete process.env.http_proxy;
      else process.env.http_proxy = prevHttpLower;
    }
  });

  it('forced CONNECT tunneling fails against absolute-form-only proxy', { timeout: 10_000 }, async () => {
    const body = buildSyntheticSignerSignBody(SYNTHETIC_BODY_TARGET_BYTES);
    const origin = await startSyntheticOrigin(body);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());

    const tunnelAgent = new ProxyAgent({
      uri: `http://127.0.0.1:${proxy.port}`,
      proxyTunnel: true,
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1_500);
    try {
      await expect(
        undiciFetch(`${origin.baseUrl}/v1/synthetic-signer-response`, {
          method: 'POST',
          body: '{}',
          dispatcher: tunnelAgent,
          signal: ctrl.signal,
        }),
      ).rejects.toBeTruthy();
    } finally {
      clearTimeout(timer);
    }
  });

  it('createSignerHttpFetch completes synthetic body through proxy under deadline', async () => {
    const body = buildSyntheticSignerSignBody(SYNTHETIC_BODY_TARGET_BYTES);
    const origin = await startSyntheticOrigin(body);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());

    const fetchImpl = createSignerHttpFetch({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });
    const { response, text } = await fetchTextWithDeadline(
      fetchImpl,
      `${origin.baseUrl}/v1/synthetic-signer-response`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer a-secure-local-token-that-is-long-enough',
        },
        body: JSON.stringify({ withdrawalAttemptId: '00000000-0000-4000-8000-0000000000aa' }),
      },
      5_000,
    );
    expect(response.status).toBe(200);
    expect(text.length).toBe(body.length);
    const parsed = JSON.parse(text) as { keySpec: string; externalMessageBocBase64: string };
    expect(parsed.keySpec).toBe('synthetic-local-test');
    expect(parsed.externalMessageBocBase64.length).toBeGreaterThan(0);
  });

  it('consumes complete bodies under concurrent proxied requests', async () => {
    const body = buildSyntheticSignerSignBody(SYNTHETIC_BODY_TARGET_BYTES);
    const origin = await startSyntheticOrigin(body);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());
    const fetchImpl = createSignerHttpFetch({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        fetchTextWithDeadline(
          fetchImpl,
          `${origin.baseUrl}/v1/synthetic-signer-response`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ n: i }),
          },
          5_000,
        ),
      ),
    );
    for (const r of results) {
      expect(r.response.status).toBe(200);
      expect(r.text.length).toBe(body.length);
    }
    expect(origin.hits).toBe(8);
  });

  it('cancels in-flight proxied Signer HTTP via upstream AbortSignal', async () => {
    const originServer = http.createServer((_req, _res) => {
      /* hang */
    });
    const origin = await listen(originServer);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());

    const fetchImpl = createSignerHttpFetch({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });
    const upstream = new AbortController();
    const pending = fetchTextWithDeadline(
      fetchImpl,
      `${origin.baseUrl}/v1/synthetic-signer-response`,
      { method: 'POST', body: '{}', signal: upstream.signal },
      10_000,
    );
    upstream.abort();
    await expect(pending).rejects.toMatchObject({
      publicMessage: expect.stringContaining('SIGNER_HTTP_CANCELLED'),
    });
  });

  it('reports HEADERS_TIMEOUT when proxied origin never responds', { timeout: 15_000 }, async () => {
    const originServer = http.createServer((_req, _res) => {
      /* never respond */
    });
    const origin = await listen(originServer);
    const proxy = await startForwardHttpProxy();
    cleanups.push(() => origin.close(), () => proxy.close());
    const fetchImpl = createSignerHttpFetch({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });
    await expect(
      fetchTextWithDeadline(
        fetchImpl,
        `${origin.baseUrl}/v1/synthetic-signer-response`,
        { method: 'POST', body: '{}' },
        80,
      ),
    ).rejects.toMatchObject({
      publicMessage: expect.stringContaining('SIGNER_HTTP_HEADERS_TIMEOUT'),
      details: expect.objectContaining({ phase: 'HEADERS_TIMEOUT' }),
    });
  });

  it('reports BODY_TIMEOUT when headers arrive but body stalls (injected fetch)', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const stream = new Readable({
        read() {
          /* never push */
        },
      });
      init?.signal?.addEventListener(
        'abort',
        () => {
          stream.destroy(new DOMException('The operation was aborted.', 'AbortError'));
        },
        { once: true },
      );
      return new Response(Readable.toWeb(stream) as never, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchTextWithDeadline(
        fetchImpl,
        'http://127.0.0.1:9/v1/synthetic-signer-response',
        { method: 'POST', body: '{}' },
        60,
      ),
    ).rejects.toMatchObject({
      publicMessage: expect.stringContaining('SIGNER_HTTP_BODY_TIMEOUT'),
      details: expect.objectContaining({ phase: 'BODY_TIMEOUT', headersReceived: true }),
    });
  });

  it('does not alter SignerHttpClient safety parsing for a normal injected response', async () => {
    const payload = {
      withdrawalAttemptId: '00000000-0000-4000-8000-000000000001',
      withdrawalId: '00000000-0000-4000-8000-000000000002',
      canonicalMessageHash: 'aa'.repeat(32),
      canonicalSigningHash: 'aa'.repeat(32),
      signedMessageHash: 'bb'.repeat(32),
      normalizedExternalMessageHash: 'bb'.repeat(32),
      publicKeyFingerprint: 'cc'.repeat(32),
      walletAddressRaw: '0:' + 'dd'.repeat(32),
      signatureBase64: 'c2ln',
      keySpec: 'local',
      signingAlgorithm: 'ed25519',
      signedWalletRequestBocBase64: 'd2FsbGV0',
      externalMessageBocBase64: 'ZXh0',
      externalMessageCellHash: 'ee'.repeat(32),
    };
    const client = new SignerHttpClient({
      baseUrl: 'http://127.0.0.1:3999',
      serviceToken: 'a-secure-local-token-that-is-long-enough',
      fetchImpl: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });
    const signed = await client.signWithdrawalAttempt(payload.withdrawalAttemptId, {
      validUntil: new Date(Date.now() + 120_000),
    });
    expect(signed.externalMessageBocBase64).toBe('ZXh0');
  });
});
