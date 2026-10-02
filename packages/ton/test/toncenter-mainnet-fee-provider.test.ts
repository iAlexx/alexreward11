import { describe, expect, it, vi } from 'vitest';

import { ToncenterMainnetFeeProvider } from '../src/toncenter-mainnet-fee-provider.js';

describe('ToncenterMainnetFeeProvider', () => {
  it('returns LIVE estimate when estimateFee healthy', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getMasterchainInfo')) {
        return new Response(JSON.stringify({ ok: true, result: { last: { seqno: 1 } } }), {
          status: 200,
        });
      }
      if (url.includes('estimateFee') || (init?.method === 'POST' && url.includes('estimateFee'))) {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              source_fees: {
                in_fwd_fee: 1000,
                storage_fee: 2000,
                gas_fee: 3000,
                fwd_fee: 4000,
              },
            },
          }),
          { status: 200 },
        );
      }
      // POST body path: toncenter uses /estimateFee
      if (init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              source_fees: {
                in_fwd_fee: 1000,
                storage_fee: 2000,
                gas_fee: 3000,
                fwd_fee: 4000,
              },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }) as unknown as typeof fetch;

    const provider = new ToncenterMainnetFeeProvider({
      baseUrl: 'https://toncenter.com/api/v2',
      fetchImpl,
      estimateAddress: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
    });
    const result = await provider.estimate({
      networkCode: 'TON_MAINNET',
      networkGlobalId: -239,
      jettonMasterIdentity: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
      netAmountAtomic: 1_000_000n,
      forwardTonAtomic: 1n,
    });
    expect(result.networkIdentity).toBe('-239');
    expect(result.attachedTonAtomicEstimated).toBe(10000n);
    expect(result.estimateMethod).toBe('estimateFee');
  });

  it('throws UNAVAILABLE when estimateAddress missing', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { last: {} } }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ToncenterMainnetFeeProvider({
      baseUrl: 'https://toncenter.com/api/v2',
      fetchImpl,
    });
    await expect(
      provider.estimate({
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
        jettonMasterIdentity: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
        netAmountAtomic: 1n,
      }),
    ).rejects.toThrow(/UNAVAILABLE|estimateAddress/);
  });
});
