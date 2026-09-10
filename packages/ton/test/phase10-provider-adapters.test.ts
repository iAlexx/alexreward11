import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  TON_TESTNET_NETWORK_GLOBAL_ID,
  TonApiTestnetProvider,
  TonCenterTestnetProvider,
  TonProviderHttpError,
  createTonChainProvider,
  isTonProviderRateLimit,
} from '../src/index.js';

const toncenter = JSON.parse(
  readFileSync(new URL('./fixtures/toncenter/responses.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const tonapi = JSON.parse(
  readFileSync(new URL('./fixtures/tonapi/responses.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

const OWNER = '0:1111111111111111111111111111111111111111111111111111111111111111';
const RECIPIENT = '0:2222222222222222222222222222222222222222222222222222222222222222';
const MASTER = '0:4444444444444444444444444444444444444444444444444444444444444444';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request body');
  return init.body;
}

function tonCenterFetch(calls: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.includes('/getAddressBalance')) return response(toncenter.accountBalance);
    if (url.includes('/sendBocReturnHash')) return response(toncenter.sendBoc);
    if (url.includes('/getTransactions')) return response(toncenter.transactions);
    if (url.includes('/getMasterchainInfo')) return response(toncenter.health);
    if (url.includes('/runGetMethod')) {
      const payload = JSON.parse(requestBody(init)) as { method: string };
      if (payload.method === 'seqno') return response(toncenter.seqno);
      if (payload.method === 'get_wallet_address') return response(toncenter.walletAddress);
      if (payload.method === 'get_wallet_data') return response(toncenter.walletData);
    }
    throw new Error(`Unexpected TonCenter fixture request: ${url}`);
  };
}

function tonApiFetch(
  calls: Array<{ url: string; init?: RequestInit }> = [],
  events: unknown = tonapi.events,
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.includes('/wallet/') && url.endsWith('/seqno')) return response(tonapi.seqno);
    if (url.includes('/jettons/')) return response(tonapi.jettonBalance);
    if (url.includes('/events?')) return response(events);
    if (url.endsWith('/v2/status')) return response(tonapi.status);
    if (url.endsWith('/v2/blockchain/message')) return new Response(null, { status: 200 });
    if (url.includes('/v2/accounts/')) return response(tonapi.account);
    throw new Error(`Unexpected TonAPI fixture request: ${url}`);
  };
}

describe('TonCenter Testnet adapter', () => {
  it('maps seqno, account balance, and Jetton balance to documented v2 calls', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      apiKey: 'fixture-key',
      fetchImpl: tonCenterFetch(calls),
    });

    expect(await provider.getSeqno(OWNER)).toBe(7);
    expect(await provider.getAccountBalance(OWNER)).toEqual({
      address: OWNER,
      balanceNanotons: '2500000000',
    });
    expect(await provider.getJettonBalance(OWNER, MASTER)).toEqual({
      ownerAddress: OWNER,
      jettonMaster: MASTER,
      balanceAtomic: '190000',
    });
    expect(JSON.parse(requestBody(calls[0]!.init))).toEqual({
      address: OWNER,
      method: 'seqno',
      stack: [],
    });
    expect(calls[1]!.url).toContain('/getAddressBalance?address=');
    expect(JSON.parse(requestBody(calls[2]!.init))).toMatchObject({
      address: MASTER,
      method: 'get_wallet_address',
    });
    expect(JSON.parse(requestBody(calls[3]!.init))).toMatchObject({
      method: 'get_wallet_data',
      stack: [],
    });
    expect((calls[0]!.init?.headers as Record<string, string>)['X-API-Key']).toBe('fixture-key');
  });

  it('maps sendBocReturnHash success without broadcasting a real message', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: tonCenterFetch(),
    });
    await expect(provider.sendBoc('fixture-boc')).resolves.toEqual({
      accepted: true,
      messageHash: 'ZmFrZS10ZXN0bmV0LW1lc3NhZ2UtaGFzaA==',
      providerReference: 'ZmFrZS10ZXN0bmV0LW1lc3NhZ2UtaGFzaA==',
    });
  });

  it('extracts Jetton transfer evidence from documented raw out-message BOC', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: tonCenterFetch(),
    });
    const result = await provider.findTransactionsByQueryId({
      hotWallet: OWNER,
      jettonMaster: MASTER,
      queryId: '42',
      recipient: RECIPIENT,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      hotWallet: OWNER,
      jettonMaster: MASTER,
      amountAtomic: '190000',
      queryId: '42',
      success: true,
      bounced: false,
      providerKind: 'toncenter',
      networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
    });
  });

  it('uses getMasterchainInfo for health', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: tonCenterFetch(),
    });
    expect(await provider.health()).toMatchObject({ ok: true, networkGlobalId: -3 });
  });
});

describe('TonAPI Testnet adapter', () => {
  it('maps seqno, account balance, and Jetton balance to documented v2 routes', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      apiKey: 'fixture-key',
      fetchImpl: tonApiFetch(calls),
    });
    expect(await provider.getSeqno(OWNER)).toBe(7);
    expect((await provider.getAccountBalance(OWNER)).balanceNanotons).toBe('2500000000');
    expect((await provider.getJettonBalance(OWNER, MASTER)).balanceAtomic).toBe('190000');
    expect(calls[0]!.url).toContain('/v2/wallet/0%3A1111');
    expect(calls[1]!.url).toContain('/v2/accounts/0%3A1111');
    expect(calls[2]!.url).toContain('/jettons/0%3A4444');
    expect((calls[0]!.init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer fixture-key',
    );
  });

  it('accepts a 200 response from the documented blockchain message route', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetch(calls),
    });
    expect((await provider.sendBoc('fixture-boc')).accepted).toBe(true);
    expect(JSON.parse(requestBody(calls[0]!.init))).toEqual({ boc: 'fixture-boc' });
  });

  it('requires concrete fields when normalizing JettonTransfer actions', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetch(),
    });
    const result = await provider.findTransactionsByQueryId({
      hotWallet: OWNER,
      jettonMaster: MASTER,
      queryId: '42',
      recipient: RECIPIENT,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      recipient: RECIPIENT,
      amountAtomic: '190000',
      queryId: '42',
      senderJettonWallet: '0:3333333333333333333333333333333333333333333333333333333333333333',
      providerKind: 'tonapi',
      success: true,
    });
  });

  it('uses TonAPI status health and pins networkGlobalId to Testnet', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetch(),
    });
    expect(await provider.health()).toMatchObject({ ok: true, networkGlobalId: -3 });
  });
});

describe('provider failure handling and selection', () => {
  it('normalizes send timeout errors with TIMEOUT for submit classification', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () => {
        throw new DOMException('request aborted', 'AbortError');
      },
    });
    await expect(provider.sendBoc('fixture-boc')).rejects.toThrow(/TIMEOUT/);
  });

  it('rejects malformed provider responses', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async () => response({ ok: true, result: { stack: [] } }),
    });
    await expect(provider.getSeqno(OWNER)).rejects.toThrow(/MALFORMED|exit_code/);
  });

  it('preserves HTTP 500 status and body snippet', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () => response({ error: 'upstream unavailable' }, 500),
    });
    const error = await provider.getSeqno(OWNER).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TonProviderHttpError);
    expect(error).toMatchObject({ status: 500 });
    expect((error as TonProviderHttpError).bodySnippet).toContain('upstream unavailable');
  });

  it('detects provider rate limits from HTTP 429', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async () => response({ error: 'too many requests' }, 429),
    });
    const error = await provider.getSeqno(OWNER).catch((caught: unknown) => caught);
    expect(isTonProviderRateLimit(error)).toBe(true);
    expect(error).toBeInstanceOf(TonProviderHttpError);
  });

  it('rejects known mainnet provider URLs during construction', () => {
    expect(() => new TonCenterTestnetProvider({ baseUrl: 'https://toncenter.com/api/v2' })).toThrow(
      /NETWORK_MISMATCH/,
    );
    expect(() => new TonApiTestnetProvider({ baseUrl: 'https://tonapi.io' })).toThrow(
      /NETWORK_MISMATCH/,
    );
  });

  it('creates explicit adapters and refuses factory-created fakes', () => {
    expect(
      createTonChainProvider({
        kind: 'toncenter',
        baseUrl: 'https://testnet.toncenter.com/api/v2',
        fetchImpl: tonCenterFetch(),
      }),
    ).toBeInstanceOf(TonCenterTestnetProvider);
    expect(() => createTonChainProvider({ kind: 'fake', baseUrl: 'test-only' })).toThrow(
      /test-only/,
    );
  });

  it('makes primary/secondary evidence disagreement detectable', async () => {
    const disagreeingEvents = structuredClone(tonapi.events) as {
      events: Array<{ actions: Array<{ JettonTransfer: { amount: string } }> }>;
    };
    disagreeingEvents.events[0]!.actions[0]!.JettonTransfer.amount = '190001';
    const primary = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: tonCenterFetch(),
    });
    const secondary = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetch([], disagreeingEvents),
    });
    const query = { hotWallet: OWNER, jettonMaster: MASTER, queryId: '42' };
    const [left, right] = await Promise.all([
      primary.findTransactionsByQueryId(query),
      secondary.findTransactionsByQueryId(query),
    ]);
    expect(left[0]!.queryId).toBe(right[0]!.queryId);
    expect(left[0]!.amountAtomic).not.toBe(right[0]!.amountAtomic);
  });
});
