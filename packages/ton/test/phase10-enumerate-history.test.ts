import { describe, expect, it } from 'vitest';

import {
  FakeTonChainProvider,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  TonApiTestnetProvider,
  TonCenterTestnetProvider,
} from '../src/index.js';
import { ENUMERATE_HISTORY_MAX_PAGES } from '../src/outgoing-jetton-history.js';

const HOT = '0:1111111111111111111111111111111111111111111111111111111111111111';
const RECIPIENT = '0:2222222222222222222222222222222222222222222222222222222222222222';
const JETTON_WALLET = '0:3333333333333333333333333333333333333333333333333333333333333333';
const MASTER = '0:4444444444444444444444444444444444444444444444444444444444444444';
const OTHER_MASTER = '0:5555555555555555555555555555555555555555555555555555555555555555';
const OTHER_OWNER = '0:6666666666666666666666666666666666666666666666666666666666666666';

const WINDOW_START = '2024-01-01T00:00:00.000Z';
const WINDOW_END = '2024-01-02T00:00:00.000Z';
const WINDOW_START_UNIX = Math.floor(Date.parse(WINDOW_START) / 1000);
const WINDOW_END_UNIX = Math.floor(Date.parse(WINDOW_END) / 1000);

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

function baseEnumerateInput() {
  return {
    hotWalletAddress: HOT,
    hotWalletJettonWallet: JETTON_WALLET,
    jettonMaster: MASTER,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    pageSize: 2,
  };
}

function tonApiOperation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: 'transfer',
    utime: WINDOW_START_UNIX + 3600,
    lt: '1001',
    transaction_hash: 'abc111',
    query_id: '42',
    amount: '190000',
    source: { address: HOT },
    destination: { address: RECIPIENT },
    jetton: {
      address: MASTER,
      name: 'ALEx',
      symbol: 'ALEX',
      decimals: 9,
      verification: 'none',
      image: '',
      score: 0,
    },
    trace_id: 'trace-1',
    success: true,
    bounced: false,
    ...overrides,
  };
}

function tonCenterTransfer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query_id: '42',
    source: HOT,
    destination: RECIPIENT,
    amount: '190000',
    jetton_master: MASTER,
    jetton_wallet: JETTON_WALLET,
    transaction_hash: 'tc-hash-1',
    transaction_lt: '2001',
    transaction_now: WINDOW_START_UNIX + 3600,
    aborted: false,
    ...overrides,
  };
}

describe('TonAPI enumerateOutgoingJettonTransfers', () => {
  it('completes a one-page outgoing history window', async () => {
    const calls: string[] = [];
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        expect(url).toContain(
          `/v2/accounts/${encodeURIComponent(HOT)}/jettons/${encodeURIComponent(MASTER)}/history`,
        );
        expect(url).toContain(`limit=2`);
        expect(url).toContain(`start_date=${WINDOW_START_UNIX}`);
        expect(url).toContain(`end_date=${WINDOW_END_UNIX}`);
        return response({
          operations: [tonApiOperation()],
          next_from: 0,
        });
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.providerKind).toBe('tonapi');
    expect(result.networkGlobalId).toBe(TON_TESTNET_NETWORK_GLOBAL_ID);
    expect(result.pagesFetched).toBe(1);
    expect(result.recordsSeen).toBe(1);
    expect(result.cursorExhausted).toBe(true);
    expect(result.windowFullyCovered).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      queryId: '42',
      amountAtomic: '190000',
      recipient: RECIPIENT,
      transferIdentity: '42',
      success: true,
      bounced: false,
      providerKind: 'tonapi',
    });
    expect(calls).toHaveLength(1);
  });

  it('paginates with before_lt across multiple pages', async () => {
    const beforeLts: Array<string | null> = [];
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async (input) => {
        const url = new URL(requestUrl(input));
        beforeLts.push(url.searchParams.get('before_lt'));
        if (beforeLts.length === 1) {
          return response({
            operations: [
              tonApiOperation({
                query_id: '2',
                utime: WINDOW_START_UNIX + 7200,
                lt: '3002',
                transaction_hash: 'h2',
              }),
            ],
            next_from: 3002,
          });
        }
        return response({
          operations: [
            tonApiOperation({
              query_id: '1',
              utime: WINDOW_START_UNIX + 100,
              lt: '3001',
              transaction_hash: 'h1',
            }),
          ],
          next_from: 0,
        });
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(beforeLts).toEqual([null, '3002']);
    expect(result.pagesFetched).toBe(2);
    expect(result.transfers.map((t) => t.queryId)).toEqual(['2', '1']);
    expect(result.windowFullyCovered).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('marks incomplete when before_lt cursor repeats', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () =>
        response({
          operations: [tonApiOperation({ utime: WINDOW_START_UNIX + 1000 })],
          next_from: 1001,
        }),
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.pagesFetched).toBe(2);
    expect(result.cursorExhausted).toBe(false);
    expect(result.windowFullyCovered).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.warnings.some((w) => /cursor repetition/i.test(w))).toBe(true);
  });

  it('marks incomplete when the page cap is hit', async () => {
    let page = 0;
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () => {
        page += 1;
        const lt = String(10_000 - page);
        return response({
          operations: [
            tonApiOperation({
              query_id: String(page),
              utime: WINDOW_START_UNIX + 500,
              lt,
              transaction_hash: `hash-${page}`,
            }),
          ],
          next_from: Number(lt),
        });
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers({
      ...baseEnumerateInput(),
      pageSize: 1,
    });
    expect(result.pagesFetched).toBe(ENUMERATE_HISTORY_MAX_PAGES);
    expect(result.windowFullyCovered).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.warnings.some((w) => /page cap/i.test(w))).toBe(true);
  });

  it('fails on malformed JettonOperations payload', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () => response({ next_from: 1 }),
    });
    await expect(provider.enumerateOutgoingJettonTransfers(baseEnumerateInput())).rejects.toThrow(
      /MALFORMED_RESPONSE/,
    );
  });

  it('ignores incoming transfers', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () =>
        response({
          operations: [
            tonApiOperation({
              source: { address: OTHER_OWNER },
              destination: { address: HOT },
              query_id: 'incoming',
            }),
            tonApiOperation({ query_id: 'outgoing' }),
          ],
          next_from: 0,
        }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers.map((t) => t.queryId)).toEqual(['outgoing']);
  });

  it('ignores wrong jetton masters', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () =>
        response({
          operations: [
            tonApiOperation({
              jetton: {
                address: OTHER_MASTER,
                name: 'X',
                symbol: 'X',
                decimals: 9,
                verification: 'none',
                image: '',
                score: 0,
              },
              query_id: 'wrong',
            }),
            tonApiOperation({ query_id: 'right' }),
          ],
          next_from: 0,
        }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers.map((t) => t.queryId)).toEqual(['right']);
  });

  it('ignores bounced and failed operations', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async () =>
        response({
          operations: [
            tonApiOperation({ query_id: 'bounced', bounced: true }),
            tonApiOperation({ query_id: 'failed', success: false }),
            tonApiOperation({ query_id: 'mint', operation: 'mint' }),
            tonApiOperation({ query_id: 'ok' }),
          ],
          next_from: 0,
        }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers.map((t) => t.queryId)).toEqual(['ok']);
  });
});

describe('TonCenter enumerateOutgoingJettonTransfers', () => {
  it('completes a one-page outgoing history window via api/v3', async () => {
    const calls: string[] = [];
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async (input) => {
        const url = requestUrl(input);
        calls.push(url);
        expect(url).toContain('https://testnet.toncenter.com/api/v3/jetton/transfers');
        expect(url).toContain(`owner_address=${encodeURIComponent(HOT)}`);
        expect(url).toContain(`jetton_master=${encodeURIComponent(MASTER)}`);
        expect(url).toContain('direction=out');
        expect(url).toContain('sort=desc');
        return response({ jetton_transfers: [tonCenterTransfer()] });
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.providerKind).toBe('toncenter');
    expect(result.pagesFetched).toBe(1);
    expect(result.cursorExhausted).toBe(true);
    expect(result.windowFullyCovered).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]).toMatchObject({
      queryId: '42',
      amountAtomic: '190000',
      recipient: RECIPIENT,
      providerKind: 'toncenter',
      transferIdentity: '42',
    });
    expect(calls).toHaveLength(1);
  });

  it('paginates with offset across multiple pages', async () => {
    const offsets: string[] = [];
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async (input) => {
        const url = new URL(requestUrl(input));
        offsets.push(url.searchParams.get('offset') ?? '');
        if (offsets.length === 1) {
          return response({
            jetton_transfers: [
              tonCenterTransfer({
                query_id: '2',
                transaction_now: WINDOW_START_UNIX + 7000,
                transaction_lt: '9',
              }),
              tonCenterTransfer({
                query_id: '1',
                transaction_now: WINDOW_START_UNIX + 6000,
                transaction_lt: '8',
              }),
            ],
          });
        }
        return response({
          jetton_transfers: [
            tonCenterTransfer({
              query_id: '0',
              transaction_now: WINDOW_START_UNIX + 100,
              transaction_lt: '7',
            }),
          ],
        });
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(offsets).toEqual(['0', '2']);
    expect(result.pagesFetched).toBe(2);
    expect(result.transfers.map((t) => t.queryId)).toEqual(['2', '1', '0']);
    expect(result.windowFullyCovered).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('marks incomplete when pagination cannot cover the window', async () => {
    let page = 0;
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async () => {
        page += 1;
        return response({
          jetton_transfers: [
            tonCenterTransfer({
              query_id: String(page),
              transaction_now: WINDOW_START_UNIX + 1000,
              transaction_lt: String(page),
              transaction_hash: `tc-${page}`,
            }),
          ],
        });
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers({
      ...baseEnumerateInput(),
      pageSize: 1,
    });
    expect(result.pagesFetched).toBe(ENUMERATE_HISTORY_MAX_PAGES);
    expect(result.windowFullyCovered).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.cursorExhausted).toBe(false);
  });

  it('ignores aborted transfers and wrong direction client-side', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async () =>
        response({
          jetton_transfers: [
            tonCenterTransfer({ query_id: 'aborted', aborted: true }),
            tonCenterTransfer({
              query_id: 'incoming',
              source: OTHER_OWNER,
              destination: HOT,
              jetton_wallet: '0:7777777777777777777777777777777777777777777777777777777777777777',
            }),
            tonCenterTransfer({ query_id: 'ok' }),
          ],
        }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers({
      ...baseEnumerateInput(),
      pageSize: 10,
    });
    expect(result.pagesFetched).toBe(1);
    expect(result.cursorExhausted).toBe(true);
    expect(result.transfers.map((t) => t.queryId)).toEqual(['ok']);
  });
});

describe('FakeTonChainProvider enumerateOutgoingJettonTransfers', () => {
  it('filters seeded enumerated transfers by window and wallets', async () => {
    const fake = new FakeTonChainProvider();
    fake.seedEnumeratedOutgoingTransfer({
      providerKind: 'fake',
      networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
      hotWalletAddress: HOT,
      senderJettonWallet: JETTON_WALLET,
      jettonMaster: MASTER,
      transactionHash: 'h1',
      transactionLt: '1',
      queryId: 'in-window',
      amountAtomic: '1',
      recipient: RECIPIENT,
      timestamp: '2024-01-01T12:00:00.000Z',
      success: true,
      bounced: false,
      transferIdentity: 'in-window',
    });
    fake.seedEnumeratedOutgoingTransfer({
      providerKind: 'fake',
      networkGlobalId: TON_TESTNET_NETWORK_GLOBAL_ID,
      hotWalletAddress: HOT,
      senderJettonWallet: JETTON_WALLET,
      jettonMaster: MASTER,
      transactionHash: 'h2',
      transactionLt: '2',
      queryId: 'out-of-window',
      amountAtomic: '1',
      recipient: RECIPIENT,
      timestamp: '2024-01-03T00:00:00.000Z',
      success: true,
      bounced: false,
      transferIdentity: 'out-of-window',
    });

    const result = await fake.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.windowFullyCovered).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.cursorExhausted).toBe(true);
    expect(result.transfers.map((t) => t.queryId)).toEqual(['in-window']);
  });
});
