import { describe, expect, it, vi } from 'vitest';

import { PHASE21_FEE_ESTIMATE_CANDIDATE_ATTACHED_GRAM_ATOMIC } from '../src/jetton-transfer-body.js';
import { ToncenterMainnetFeeProvider } from '../src/toncenter-mainnet-fee-provider.js';

const MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const OWNER = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
const JETTON_WALLET = 'EQBynBO23ywHy_CgarY9NK9FTz0yDsG82PtcbSTQgGoXwiuA';

describe('ToncenterMainnetFeeProvider Step3C', () => {
  it('uses jetton master + amount in unsigned body; fee != attached', async () => {
    let estimateBody: string | null = null;
    let estimateAddress: string | null = null;
    let sawRunGetMethod = false;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getMasterchainInfo')) {
        return new Response(JSON.stringify({ ok: true, result: { last: { seqno: 1 } } }), {
          status: 200,
        });
      }
      const payload =
        typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (
        payload.method === 'runGetMethod' ||
        (typeof payload.method === 'string' && String(payload.method).includes('get_wallet'))
      ) {
        sawRunGetMethod = true;
        return new Response(JSON.stringify({ ok: false, error: 'unexpected derivation' }), {
          status: 500,
        });
      }
      if (url.includes('estimateFee') || payload.address !== undefined) {
        estimateBody = typeof payload.body === 'string' ? payload.body : null;
        estimateAddress = typeof payload.address === 'string' ? payload.address : null;
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
      estimateAddress: OWNER,
      estimateJettonWalletAddress: JETTON_WALLET,
    });

    const cases = [
      { net: 190_000n, label: '0.19 USDT' },
      { net: 5_000_000n, label: '5 USDT' },
    ] as const;

    for (const c of cases) {
      estimateBody = null;
      estimateAddress = null;
      const result = await provider.estimate({
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
        jettonMasterIdentity: MASTER,
        netAmountAtomic: c.net,
        forwardTonAtomic: 1n,
        destinationAddress: OWNER,
        responseDestination: OWNER,
      });
      expect(estimateBody, c.label).toBeTruthy();
      expect((estimateBody ?? '').length, c.label).toBeGreaterThan(10);
      expect(estimateAddress, c.label).toBe(JETTON_WALLET);
      expect(result.jettonMaster).toBe(MASTER);
      expect(result.jettonWalletAddress).toBe(JETTON_WALLET);
      expect(result.netAmountAtomic).toBe(c.net);
      expect(result.estimatedNetworkFeeAtomic).toBe(10000n);
      expect(result.candidateAttachedGramAtomic).toBe(
        PHASE21_FEE_ESTIMATE_CANDIDATE_ATTACHED_GRAM_ATOMIC,
      );
      expect(result.forwardGramAtomic).toBe(1n);
      expect(result.estimatedTotalNativeExposureAtomic).toBe(
        PHASE21_FEE_ESTIMATE_CANDIDATE_ATTACHED_GRAM_ATOMIC + 1n,
      );
      expect(result.estimatedNetworkFeeAtomic).not.toBe(result.candidateAttachedGramAtomic);
      expect(result.estimatedTotalNativeExposureAtomic).not.toBe(
        (result.candidateAttachedGramAtomic ?? 0n) +
          (result.forwardGramAtomic ?? 0n) +
          (result.estimatedNetworkFeeAtomic ?? 0n),
      );
      expect(result.broadcast).toBe(false);
      expect(result.attachedGramLifecycle).toBe('OWNER_APPROVED');
      expect(result.emulationMethod).toMatch(/estimateFee/);
    }
    expect(sawRunGetMethod).toBe(false);
  });

  it('refuses empty jetton master (cannot void/ignore)', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true, result: { last: {} } }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new ToncenterMainnetFeeProvider({
      baseUrl: 'https://toncenter.com/api/v2',
      fetchImpl,
      estimateAddress: OWNER,
      estimateJettonWalletAddress: JETTON_WALLET,
    });
    await expect(
      provider.estimate({
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
        jettonMasterIdentity: '   ',
        netAmountAtomic: 190_000n,
      }),
    ).rejects.toThrow(/jettonMasterIdentity required/);
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
        jettonMasterIdentity: MASTER,
        netAmountAtomic: 1n,
      }),
    ).rejects.toThrow(/UNAVAILABLE|estimateAddress/);
  });
});
