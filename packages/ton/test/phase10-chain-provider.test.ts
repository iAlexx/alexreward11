import { describe, expect, it } from 'vitest';

import {
  FakeTonChainProvider,
  HttpTonProvider,
  TON_MAINNET_NETWORK_GLOBAL_ID,
  TON_TESTNET_NETWORK_GLOBAL_ID,
  assertTestnetOnly,
} from '../src/index.js';

describe('Phase 10 chain provider', () => {
  it('FakeTonChainProvider is deterministic for seqno / sendBoc / observe', async () => {
    const fake = new FakeTonChainProvider();
    fake.seedSeqno('EQ_hot', 7);
    fake.seedJettonBalance('EQ_hot', 'EQ_master', '1000000');
    fake.seedTransfer({
      hotWallet: 'EQ_hot',
      jettonMaster: 'EQ_master',
      recipient: 'EQ_recv',
      amountAtomic: '190000',
      queryId: '42',
      success: true,
      bounced: false,
    });

    expect(await fake.getSeqno('EQ_hot')).toBe(7);
    expect((await fake.getJettonBalance('EQ_hot', 'EQ_master')).balanceAtomic).toBe('1000000');

    const sent = await fake.sendBoc('dGVzdA==');
    expect(sent.accepted).toBe(true);
    expect(fake.getSubmittedBocs()).toEqual(['dGVzdA==']);

    const evidence = await fake.observeJettonTransfer({
      hotWallet: 'EQ_hot',
      jettonMaster: 'EQ_master',
      queryId: '42',
    });
    expect(evidence?.amountAtomic).toBe('190000');
    expect(evidence?.success).toBe(true);
    expect(evidence?.bounced).toBe(false);

    const health = await fake.health();
    expect(health.ok).toBe(true);
    expect(health.networkGlobalId).toBe(TON_TESTNET_NETWORK_GLOBAL_ID);
  });

  it('rejects mainnet networkGlobalId at assert and HttpTonProvider construction', () => {
    expect(() => assertTestnetOnly(TON_MAINNET_NETWORK_GLOBAL_ID)).toThrow(/MAINNET rejected/);
    expect(
      () =>
        new HttpTonProvider({
          baseUrl: 'https://example.testnet.tonapi.local',
          networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
        }),
    ).toThrow(/MAINNET rejected/);
    expect(
      () =>
        new FakeTonChainProvider({
          networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
        }),
    ).toThrow(/MAINNET rejected/);
  });

  it('HttpTonProvider posts JSON-RPC without hardcoding secrets', async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const provider = new HttpTonProvider({
      baseUrl: 'https://ton-testnet.example/rpc',
      apiKey: 'test-key-not-for-prod',
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: String(init?.body ?? ''),
        });
        return new Response(JSON.stringify({ result: 3 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });

    expect(await provider.getSeqno('EQ_x')).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-api-key']).toBe('test-key-not-for-prod');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      jsonrpc: '2.0',
      method: 'getSeqno',
      params: { address: 'EQ_x' },
    });
  });
});
