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

  it('rejects mainnet networkGlobalId at assert and fake construction', () => {
    expect(() => assertTestnetOnly(TON_MAINNET_NETWORK_GLOBAL_ID)).toThrow(/MAINNET rejected/);
    expect(
      () =>
        new FakeTonChainProvider({
          networkGlobalId: TON_MAINNET_NETWORK_GLOBAL_ID,
        }),
    ).toThrow(/MAINNET rejected/);
  });

  it('deprecated HttpTonProvider directs callers to documented adapters', () => {
    expect(
      () => new HttpTonProvider({ baseUrl: 'https://testnet.toncenter.com/api/v2' }),
    ).toThrow(/TonCenterTestnetProvider or TonApiTestnetProvider/);
  });
});
