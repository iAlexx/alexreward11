import { Address } from '@ton/core';
import { describe, expect, it } from 'vitest';

import {
  FakeTonChainProvider,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  TonApiTestnetProvider,
  TonCenterTestnetProvider,
} from '../src/index.js';
import { ENUMERATE_HISTORY_MAX_PAGES } from '../src/outgoing-jetton-history.js';

// Matches packages/ton/test/fixtures/tonapi/responses.json address roles.
const HOT = '0:1111111111111111111111111111111111111111111111111111111111111111';
const RECIPIENT = '0:2222222222222222222222222222222222222222222222222222222222222222';
const JETTON_WALLET = '0:3333333333333333333333333333333333333333333333333333333333333333';
const MASTER = '0:4444444444444444444444444444444444444444444444444444444444444444';
const RECIPIENT_JETTON_WALLET =
  '0:5555555555555555555555555555555555555555555555555555555555555555';
const OTHER_OWNER = '0:6666666666666666666666666666666666666666666666666666666666666666';
const WRONG_JETTON_WALLET = '0:7777777777777777777777777777777777777777777777777777777777777777';

// Reused from fixtures/tonapi/responses.json (transfer / internal_transfer raw_body).
const TRANSFER_RAW_BODY =
  'b5ee9c724101010100560000a80f8a7ea5000000000000002a302e630800444444444444444444444444444444444444444444444444444444444444444500044444444444444444444444444444444444444444444444444444444444444442029b293b36';
const INTERNAL_TRANSFER_RAW_BODY =
  'b5ee9c724101010100560000a7178d4519000000000000002a302e63080022222222222222222222222222222222222222222222222222222222222222230004444444444444444444444444444444444444444444444444444444444444444405d4832c57';
/** internal_transfer with from-owner = RECIPIENT (not HOT) — must be refused. */
const INTERNAL_TRANSFER_WRONG_FROM_RAW_BODY =
  'b5ee9c724101010100550000a6178d4519000000000000002a302e63080044444444444444444444444444444444444444444444444444444444444444450011111111111111111111111111111111111111111111111111111111111111110064620450';

const WINDOW_START = '2024-01-01T00:00:00.000Z';
const WINDOW_END = '2024-01-02T00:00:00.000Z';
const WINDOW_START_UNIX = Math.floor(Date.parse(WINDOW_START) / 1000);

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

function jettonBalanceBody(walletAddress: string): Record<string, unknown> {
  return {
    balance: '190000',
    wallet_address: { address: walletAddress, is_scam: false, is_wallet: true },
    jetton: {
      address: MASTER,
      name: 'Testnet Reward',
      symbol: 'TST',
      decimals: 9,
      verification: 'none',
    },
  };
}

function succeededPhases(): Record<string, unknown> {
  return {
    success: true,
    aborted: false,
    compute_phase: { skipped: false, success: true, exit_code: 0 },
    action_phase: { success: true, result_code: 0 },
  };
}

/** Authoritative raw TEP-74 outgoing transfer on the hot-wallet jetton wallet account. */
function rawOutgoingJettonTx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    lt: 50000000002,
    utime: WINDOW_START_UNIX + 3600,
    account: { address: JETTON_WALLET, is_scam: false, is_wallet: false },
    ...succeededPhases(),
    in_msg: {
      msg_type: 'int_msg',
      source: { address: HOT, is_scam: false, is_wallet: true },
      destination: { address: JETTON_WALLET, is_scam: false, is_wallet: false },
      bounced: false,
      raw_body: TRANSFER_RAW_BODY,
    },
    out_msgs: [
      {
        msg_type: 'int_msg',
        source: { address: JETTON_WALLET, is_scam: false, is_wallet: false },
        destination: { address: RECIPIENT_JETTON_WALLET, is_scam: false, is_wallet: false },
        bounced: false,
        raw_body: INTERNAL_TRANSFER_RAW_BODY,
      },
    ],
    ...overrides,
  };
}

/**
 * Discovery-only history shape (events/actions/next_from).
 * Actions alone must never produce PROVIDER transfers without raw proof.
 */
function tonApiEventsHistory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    events: [
      {
        event_id: 'event-claimed-1',
        timestamp: WINDOW_START_UNIX + 3600,
        actions: [
          {
            type: 'JettonTransfer',
            status: 'ok',
            transaction_hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          },
        ],
      },
    ],
    next_from: 0,
    ...overrides,
  };
}

function addressInUrl(url: string, rawAddress: string): boolean {
  if (url.includes(encodeURIComponent(rawAddress)) || url.includes(rawAddress)) return true;
  try {
    const friendly = Address.parse(rawAddress).toString();
    return url.includes(encodeURIComponent(friendly)) || url.includes(friendly);
  } catch {
    return false;
  }
}

function tonApiFetchRouter(handler: (url: string) => Response | null): typeof fetch {
  return async (input) => {
    const url = requestUrl(input);
    if (
      url.includes(`/jettons/`) &&
      url.includes(encodeURIComponent(MASTER)) &&
      !url.includes('/history')
    ) {
      if (addressInUrl(url, RECIPIENT)) {
        return response(jettonBalanceBody(RECIPIENT_JETTON_WALLET));
      }
      if (addressInUrl(url, HOT)) {
        return response(jettonBalanceBody(JETTON_WALLET));
      }
      return response(jettonBalanceBody(JETTON_WALLET));
    }
    if (url.includes('/history')) {
      // Default: empty discovery so primary raw pagination tests stay focused.
      return response({ events: [], operations: [], next_from: 0 });
    }
    const handled = handler(url);
    if (handled !== null) return handled;
    throw new Error(`Unexpected TonAPI fixture request: ${url}`);
  };
}

function tonCenterTransfer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    query_id: '42',
    source: HOT,
    destination: RECIPIENT,
    amount: '190000',
    jetton_master: MASTER,
    source_wallet: JETTON_WALLET,
    transaction_hash: 'tc-hash-1',
    transaction_lt: '2001',
    transaction_now: WINDOW_START_UNIX + 3600,
    transaction_aborted: false,
    trace_id: 'trace-tc-1',
    ...overrides,
  };
}

describe('TonAPI enumerateOutgoingJettonTransfers', () => {
  it('completes a one-page outgoing history window via raw blockchain txs', async () => {
    const calls: string[] = [];
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        calls.push(url);
        if (
          url.includes(`/v2/blockchain/accounts/${encodeURIComponent(JETTON_WALLET)}/transactions`)
        ) {
          expect(url).toContain('limit=2');
          expect(url).toContain('sort_order=desc');
          expect(url).not.toContain('start_date=');
          return response({ transactions: [rawOutgoingJettonTx()] });
        }
        return null;
      }),
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
      transferIdentity: '42',
      success: true,
      bounced: false,
      providerKind: 'tonapi',
      senderJettonWallet: JETTON_WALLET,
    });
    expect(calls.some((u) => u.includes('/transactions'))).toBe(true);
  });

  it('paginates with before_lt across multiple pages', async () => {
    const beforeLts: Array<string | null> = [];
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        const parsed = new URL(url);
        beforeLts.push(parsed.searchParams.get('before_lt'));
        if (beforeLts.length === 1) {
          return response({
            transactions: [
              rawOutgoingJettonTx({
                hash: 'h2',
                lt: 3002,
                utime: WINDOW_START_UNIX + 7200,
              }),
            ],
          });
        }
        if (beforeLts.length === 2) {
          return response({
            transactions: [
              rawOutgoingJettonTx({
                hash: 'h1',
                lt: 3001,
                utime: WINDOW_START_UNIX + 100,
              }),
            ],
          });
        }
        return response({ transactions: [] });
      }),
    });

    const result = await provider.enumerateOutgoingJettonTransfers({
      ...baseEnumerateInput(),
      pageSize: 1,
    });
    expect(beforeLts).toEqual([null, '3002', '3001']);
    expect(result.pagesFetched).toBe(3);
    expect(result.transfers.map((t) => t.transactionHash)).toEqual(['h2', 'h1']);
    expect(result.cursorExhausted).toBe(true);
    expect(result.windowFullyCovered).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('marks incomplete when before_lt cursor repeats', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        return response({
          // Full page so pagination continues with before_lt from oldest lt.
          transactions: [
            rawOutgoingJettonTx({ utime: WINDOW_START_UNIX + 1000, lt: 1001, hash: 'a' }),
            rawOutgoingJettonTx({ utime: WINDOW_START_UNIX + 900, lt: 1001, hash: 'b' }),
          ],
        });
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
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        page += 1;
        const lt = String(10_000 - page);
        return response({
          transactions: [
            rawOutgoingJettonTx({
              hash: `hash-${page}`,
              lt: Number(lt),
              utime: WINDOW_START_UNIX + 500,
            }),
          ],
        });
      }),
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

  it('fails on malformed transactions payload', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        return response({ next_from: 1 });
      }),
    });
    await expect(provider.enumerateOutgoingJettonTransfers(baseEnumerateInput())).rejects.toThrow(
      /MALFORMED_RESPONSE/,
    );
  });

  it('ignores incoming transfers (wrong in_msg source)', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        return response({
          transactions: [
            rawOutgoingJettonTx({
              hash: 'incoming',
              in_msg: {
                msg_type: 'int_msg',
                source: { address: OTHER_OWNER },
                destination: { address: JETTON_WALLET },
                bounced: false,
                raw_body: TRANSFER_RAW_BODY,
              },
            }),
            rawOutgoingJettonTx({ hash: 'outgoing' }),
          ],
        });
      }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers({
      ...baseEnumerateInput(),
      pageSize: 10,
    });
    expect(result.transfers.map((t) => t.transactionHash)).toEqual(['outgoing']);
  });

  it('refuses transfers when resolveJettonWallet returns a different wallet', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async (input) => {
        const url = requestUrl(input);
        if (url.includes(`/jettons/${encodeURIComponent(MASTER)}`) && !url.includes('/history')) {
          // Wrong jetton wallet for the hot owner — binding fails closed.
          return response(jettonBalanceBody(WRONG_JETTON_WALLET));
        }
        if (url.includes('/history')) {
          return response({ events: [], operations: [], next_from: 0 });
        }
        if (url.includes('/transactions')) {
          return response({ transactions: [rawOutgoingJettonTx()] });
        }
        throw new Error(`Unexpected TonAPI fixture request: ${url}`);
      },
    });
    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers).toHaveLength(0);
    expect(result.warnings.some((w) => /does not equal hotWalletJettonWallet/i.test(w))).toBe(true);
  });

  it('skips transfer when resolveJettonWallet(recipient) fails', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async (input) => {
        const url = requestUrl(input);
        if (
          url.includes(`/jettons/`) &&
          url.includes(encodeURIComponent(MASTER)) &&
          !url.includes('/history')
        ) {
          if (addressInUrl(url, RECIPIENT)) {
            return response({ error: 'jetton wallet missing' }, 404);
          }
          return response(jettonBalanceBody(JETTON_WALLET));
        }
        if (url.includes('/history')) {
          return response({ events: [], operations: [], next_from: 0 });
        }
        if (url.includes('/transactions')) {
          return response({ transactions: [rawOutgoingJettonTx()] });
        }
        throw new Error(`Unexpected TonAPI fixture request: ${url}`);
      },
    });
    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers).toHaveLength(0);
    expect(result.warnings.some((w) => /resolveJettonWallet\(recipient\) failed/i.test(w))).toBe(
      true,
    );
  });

  it('skips transfer when internal_transfer from-owner is not hot wallet', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        return response({
          transactions: [
            rawOutgoingJettonTx({
              hash: 'wrong-from',
              out_msgs: [
                {
                  msg_type: 'int_msg',
                  source: { address: JETTON_WALLET, is_scam: false, is_wallet: false },
                  destination: {
                    address: RECIPIENT_JETTON_WALLET,
                    is_scam: false,
                    is_wallet: false,
                  },
                  bounced: false,
                  raw_body: INTERNAL_TRANSFER_WRONG_FROM_RAW_BODY,
                },
              ],
            }),
          ],
        });
      }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers).toHaveLength(0);
  });

  it('skips transfer when recipient jetton wallet destination mismatches derived wallet', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        return response({
          transactions: [
            rawOutgoingJettonTx({
              hash: 'wrong-dest',
              out_msgs: [
                {
                  msg_type: 'int_msg',
                  source: { address: JETTON_WALLET, is_scam: false, is_wallet: false },
                  destination: { address: WRONG_JETTON_WALLET, is_scam: false, is_wallet: false },
                  bounced: false,
                  raw_body: INTERNAL_TRANSFER_RAW_BODY,
                },
              ],
            }),
          ],
        });
      }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers).toHaveLength(0);
    expect(result.warnings.some((w) => /recipient jetton wallet mismatch/i.test(w))).toBe(true);
  });

  it('ignores bounced and failed transactions', async () => {
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: tonApiFetchRouter((url) => {
        if (!url.includes('/transactions')) return null;
        return response({
          transactions: [
            rawOutgoingJettonTx({
              hash: 'bounced',
              in_msg: {
                msg_type: 'int_msg',
                source: { address: HOT },
                destination: { address: JETTON_WALLET },
                bounced: true,
                raw_body: TRANSFER_RAW_BODY,
              },
            }),
            rawOutgoingJettonTx({
              hash: 'failed',
              success: false,
              aborted: true,
              compute_phase: { skipped: false, success: false, exit_code: 1 },
            }),
            rawOutgoingJettonTx({ hash: 'ok' }),
          ],
        });
      }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers({
      ...baseEnumerateInput(),
      pageSize: 10,
    });
    expect(result.transfers.map((t) => t.transactionHash)).toEqual(['ok']);
  });

  it('documents events/actions discovery shape but actions alone cannot produce transfers', async () => {
    const eventsOnly = tonApiEventsHistory();
    expect(eventsOnly).toMatchObject({
      events: [
        {
          actions: [{ type: 'JettonTransfer', status: 'ok' }],
        },
      ],
      next_from: 0,
    });

    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async (input) => {
        const url = requestUrl(input);
        if (url.includes(`/jettons/${encodeURIComponent(MASTER)}`) && !url.includes('/history')) {
          return response(jettonBalanceBody(JETTON_WALLET));
        }
        if (url.includes('/history')) {
          return response(eventsOnly);
        }
        if (url.includes('/transactions')) {
          // Empty raw window — discovery will try the action hash next.
          return response({ transactions: [] });
        }
        if (url.includes('/v2/blockchain/transactions/')) {
          // Action claims transfer but raw messages disagree (no TEP-74 proof).
          return response({
            hash: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            lt: 1,
            utime: WINDOW_START_UNIX + 3600,
            account: { address: JETTON_WALLET },
            ...succeededPhases(),
            in_msg: {
              msg_type: 'int_msg',
              source: { address: HOT },
              destination: { address: JETTON_WALLET },
              bounced: false,
              raw_body: '00',
            },
            out_msgs: [],
          });
        }
        throw new Error(`Unexpected TonAPI fixture request: ${url}`);
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers).toHaveLength(0);
    expect(
      result.warnings.some((w) => /action claimed JettonTransfer but raw proof failed/i.test(w)),
    ).toBe(true);
  });

  it('action claims transfer but raw messages disagree → not included', async () => {
    const claimedHash = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async (input) => {
        const url = requestUrl(input);
        if (
          url.includes(`/jettons/`) &&
          url.includes(encodeURIComponent(MASTER)) &&
          !url.includes('/history')
        ) {
          if (addressInUrl(url, RECIPIENT)) {
            return response(jettonBalanceBody(RECIPIENT_JETTON_WALLET));
          }
          return response(jettonBalanceBody(JETTON_WALLET));
        }
        if (url.includes('/history')) {
          return response(
            tonApiEventsHistory({
              events: [
                {
                  event_id: claimedHash,
                  timestamp: WINDOW_START_UNIX + 3600,
                  actions: [
                    {
                      type: 'JettonTransfer',
                      status: 'ok',
                      transaction_hash: claimedHash,
                    },
                  ],
                },
              ],
            }),
          );
        }
        if (
          url.includes(`/v2/blockchain/accounts/${encodeURIComponent(JETTON_WALLET)}/transactions`)
        ) {
          return response({ transactions: [] });
        }
        if (url.includes(`/v2/blockchain/transactions/${claimedHash}`)) {
          return response({
            hash: claimedHash,
            lt: 9,
            utime: WINDOW_START_UNIX + 3600,
            account: { address: JETTON_WALLET },
            ...succeededPhases(),
            in_msg: {
              msg_type: 'ext_in_msg',
              destination: { address: JETTON_WALLET },
              bounced: false,
            },
            out_msgs: [],
          });
        }
        throw new Error(`Unexpected TonAPI fixture request: ${url}`);
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers).toHaveLength(0);
    expect(
      result.warnings.some((w) => /action claimed JettonTransfer but raw proof failed/i.test(w)),
    ).toBe(true);
  });

  it('raw proves → included (including when discovery also surfaces the hash)', async () => {
    const hash = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
    const provider = new TonApiTestnetProvider({
      baseUrl: 'https://testnet.tonapi.io',
      fetchImpl: async (input) => {
        const url = requestUrl(input);
        if (
          url.includes(`/jettons/`) &&
          url.includes(encodeURIComponent(MASTER)) &&
          !url.includes('/history')
        ) {
          if (addressInUrl(url, RECIPIENT)) {
            return response(jettonBalanceBody(RECIPIENT_JETTON_WALLET));
          }
          return response(jettonBalanceBody(JETTON_WALLET));
        }
        if (url.includes('/history')) {
          return response(
            tonApiEventsHistory({
              events: [
                {
                  event_id: hash,
                  timestamp: WINDOW_START_UNIX + 3600,
                  actions: [{ type: 'JettonTransfer', status: 'ok', transaction_hash: hash }],
                },
              ],
            }),
          );
        }
        if (
          url.includes(`/v2/blockchain/accounts/${encodeURIComponent(JETTON_WALLET)}/transactions`)
        ) {
          return response({ transactions: [rawOutgoingJettonTx({ hash })] });
        }
        throw new Error(`Unexpected TonAPI fixture request: ${url}`);
      },
    });

    const result = await provider.enumerateOutgoingJettonTransfers(baseEnumerateInput());
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0]?.queryId).toBe('42');
    expect(result.transfers[0]?.amountAtomic).toBe('190000');
    expect(result.transfers[0]?.transactionHash).toBe(hash);
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
      senderJettonWallet: JETTON_WALLET,
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

  it('ignores transaction_aborted true and missing aborted; never treats aborted as success', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async () =>
        response({
          jetton_transfers: [
            tonCenterTransfer({ query_id: 'aborted', transaction_aborted: true }),
            tonCenterTransfer({ query_id: 'missing-aborted', transaction_aborted: undefined }),
            // Legacy alternate fields must not authorize inclusion.
            {
              query_id: 'legacy-success',
              source: HOT,
              destination: RECIPIENT,
              amount: '190000',
              jetton_master: MASTER,
              source_wallet: JETTON_WALLET,
              transaction_hash: 'legacy',
              transaction_lt: '1',
              transaction_now: WINDOW_START_UNIX + 3600,
              aborted: false,
              success: true,
            },
            tonCenterTransfer({
              query_id: 'incoming',
              source: OTHER_OWNER,
              destination: HOT,
              source_wallet: WRONG_JETTON_WALLET,
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
    expect(result.transfers.every((t) => t.success === true)).toBe(true);
  });

  it('requires both source and source_wallet; never falls back on missing/mismatched wallet', async () => {
    const provider = new TonCenterTestnetProvider({
      baseUrl: 'https://testnet.toncenter.com/api/v2',
      fetchImpl: async () =>
        response({
          jetton_transfers: [
            tonCenterTransfer({
              query_id: 'missing-wallet',
              source_wallet: undefined,
            }),
            tonCenterTransfer({
              query_id: 'empty-wallet',
              source_wallet: '',
            }),
            tonCenterTransfer({
              query_id: 'wrong-wallet',
              source_wallet: WRONG_JETTON_WALLET,
            }),
            tonCenterTransfer({
              query_id: 'owner-only',
              source: HOT,
              source_wallet: WRONG_JETTON_WALLET,
            }),
            tonCenterTransfer({
              query_id: 'wallet-only',
              source: OTHER_OWNER,
              source_wallet: JETTON_WALLET,
            }),
            tonCenterTransfer({ query_id: 'ok-both' }),
          ],
        }),
    });
    const result = await provider.enumerateOutgoingJettonTransfers({
      ...baseEnumerateInput(),
      pageSize: 10,
    });
    expect(result.transfers.map((t) => t.queryId)).toEqual(['ok-both']);
    expect(result.transfers[0]?.senderJettonWallet).toBe(JETTON_WALLET);
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
