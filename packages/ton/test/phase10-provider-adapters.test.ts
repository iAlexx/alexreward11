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
const SENDER_WALLET = '0:3333333333333333333333333333333333333333333333333333333333333333';
const MASTER = '0:4444444444444444444444444444444444444444444444444444444444444444';
const EXTERNAL_HASH = 'aa'.repeat(32);

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
  let walletDataCalls = 0;
  let transactionCalls = 0;
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.includes('/getAddressBalance')) return response(toncenter.accountBalance);
    if (url.includes('/sendBocReturnHash')) return response(toncenter.sendBoc);
    if (url.includes('/getTransactions')) {
      transactionCalls += 1;
      return response(
        transactionCalls === 1
          ? toncenter.transactions
          : transactionCalls === 2
            ? toncenter.senderTransactions
            : toncenter.recipientTransactions,
      );
    }
    if (url.includes('/getMasterchainInfo')) return response(toncenter.health);
    if (url.includes('/runGetMethod')) {
      const payload = JSON.parse(requestBody(init)) as { method: string };
      if (payload.method === 'seqno') return response(toncenter.seqno);
      if (payload.method === 'get_wallet_address') {
        return response(
          requestBody(init).includes(
            'te6cckEBAQEAJAAAQ4AERERERERERERERERERERERERERERERERERERERERERFCbtg2B',
          )
            ? toncenter.recipientWalletAddress
            : toncenter.walletAddress,
        );
      }
      if (payload.method === 'get_wallet_data') {
        walletDataCalls += 1;
        return response(walletDataCalls > 1 ? toncenter.recipientWalletData : toncenter.walletData);
      }
    }
    throw new Error(`Unexpected TonCenter fixture request: ${url}`);
  };
}

function tonApiFetch(
  calls: Array<{ url: string; init?: RequestInit }> = [],
  trace: unknown = tonapi.trace,
): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    calls.push({ url, ...(init === undefined ? {} : { init }) });
    if (url.includes('/wallet/') && url.endsWith('/seqno')) return response(tonapi.seqno);
    if (url.includes('/jettons/'))
      return response(
        url.includes(encodeURIComponent(RECIPIENT))
          ? tonapi.recipientJettonBalance
          : tonapi.jettonBalance,
      );
    if (url.includes('/v2/blockchain/messages/')) return response(tonapi.transactionByMessageHash);
    if (url.includes('/v2/traces/')) return response(trace);
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

  it('proves the complete TEP-74 chain through both Jetton wallets', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: tonCenterFetch(),
    });
    const result = await provider.findTransactionsByQueryId({
      hotWallet: OWNER,
      jettonMaster: MASTER,
      queryId: '42',
      recipient: RECIPIENT,
      amountAtomic: '190000',
      senderJettonWallet: SENDER_WALLET,
      normalizedExternalMessageHash: EXTERNAL_HASH,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      hotWallet: OWNER,
      jettonMaster: MASTER,
      amountAtomic: '190000',
      queryId: '42',
      success: true,
      bounced: false,
      proofStage: 'COMPLETE',
      senderJettonWallet: SENDER_WALLET,
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

  it('looks up normalized hash and proves low-level trace messages without events', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetch(calls),
    });
    const result = await provider.findTransactionsByQueryId({
      hotWallet: OWNER,
      jettonMaster: MASTER,
      queryId: '42',
      recipient: RECIPIENT,
      amountAtomic: '190000',
      senderJettonWallet: SENDER_WALLET,
      normalizedExternalMessageHash: EXTERNAL_HASH,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      recipient: RECIPIENT,
      amountAtomic: '190000',
      queryId: '42',
      senderJettonWallet: '0:3333333333333333333333333333333333333333333333333333333333333333',
      providerKind: 'tonapi',
      success: true,
      proofStage: 'COMPLETE',
    });
    expect(calls.some((call) => call.url.includes(`/messages/${EXTERNAL_HASH}/transaction`))).toBe(
      true,
    );
    expect(calls.some((call) => call.url.includes('/v2/traces/'))).toBe(true);
    expect(calls.every((call) => !call.url.includes('/events'))).toBe(true);
  });

  it('does not confirm a bounced or failed Jetton-wallet trace', async () => {
    const failingTrace = structuredClone(tonapi.trace) as {
      children: Array<{ transaction: { aborted: boolean } }>;
    };
    failingTrace.children[0]!.transaction.aborted = true;
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetch([], failingTrace),
    });
    await expect(
      provider.observeJettonTransfer({
        hotWallet: OWNER,
        jettonMaster: MASTER,
        queryId: '42',
        recipient: RECIPIENT,
        amountAtomic: '190000',
        senderJettonWallet: SENDER_WALLET,
        normalizedExternalMessageHash: EXTERNAL_HASH,
      }),
    ).resolves.toBeNull();
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

  it('makes primary/secondary low-level evidence disagreement detectable', async () => {
    const failingTrace = structuredClone(tonapi.trace) as {
      children: Array<{ transaction: { success: boolean } }>;
    };
    failingTrace.children[0]!.transaction.success = false;
    const primary = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: tonCenterFetch(),
    });
    const secondary = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetch([], failingTrace),
    });
    const query = {
      hotWallet: OWNER,
      jettonMaster: MASTER,
      queryId: '42',
      recipient: RECIPIENT,
      amountAtomic: '190000',
      senderJettonWallet: SENDER_WALLET,
      normalizedExternalMessageHash: EXTERNAL_HASH,
    };
    const [left, right] = await Promise.all([
      primary.observeJettonTransfer(query),
      secondary.observeJettonTransfer(query),
    ]);
    expect(left?.proofStage).toBe('COMPLETE');
    expect(right).toBeNull();
  });
});
