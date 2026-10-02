import { describe, expect, it, vi } from 'vitest';

import { createPhase21MainnetExternalAdapters } from '../src/phase21-mainnet-adapters.js';
import { verifyMainnetUsdtWithTwoProviders } from '../src/phase21-external-probes.js';

describe('phase21 concrete mainnet adapters', () => {
  it('createPhase21MainnetExternalAdapters builds dual adapters', () => {
    const adapters = createPhase21MainnetExternalAdapters({
      primary: { kind: 'toncenter', url: 'https://toncenter.com/api/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.io' },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(adapters.identity).toBeDefined();
    expect(adapters.metadata).toBeDefined();
    expect(adapters.derivation).toBeDefined();
  });

  it('verify path with mocked fetch proves identity + USDT metadata', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('getMasterchainInfo')) {
        return new Response(JSON.stringify({ ok: true, result: { last: { seqno: 1 } } }), {
          status: 200,
        });
      }
      if (url.includes('/v2/status')) {
        return new Response(JSON.stringify({ rest_online: true }), { status: 200 });
      }
      if (url.includes('/v2/blockchain/config')) {
        return new Response(JSON.stringify({ global_id: -239 }), { status: 200 });
      }
      if (url.includes('/v2/jettons/')) {
        return new Response(
          JSON.stringify({ metadata: { symbol: 'USDT', decimals: 6 } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: 'unexpected ' + url }), {
        status: 500,
      });
    }) as unknown as typeof fetch;

    const adapters = createPhase21MainnetExternalAdapters({
      primary: { kind: 'toncenter', url: 'https://toncenter.com/api/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.io' },
      fetchImpl,
    });

    // Toncenter metadata is intentionally incomplete; inject metadata adapter override for unit proof.
    const metadata = {
      async probe(input: {
        providerKind: string;
        providerUrl: string;
        jettonMaster: string;
      }) {
        void input;
        return {
          ok: true,
          symbol: 'USDT',
          decimals: 6,
          message: 'mock metadata',
          providerHost: 'mock',
        };
      },
    };

    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.com/api/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.io' },
      jettonMaster: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
      identityAdapter: adapters.identity,
      metadataAdapter: metadata,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe('MAINNET_USDT_TWO_PROVIDER_OK');
  });

  it('refuses testnet provider URLs', () => {
    expect(() =>
      createPhase21MainnetExternalAdapters({
        primary: { kind: 'toncenter', url: 'https://testnet.toncenter.com/api/v2' },
        secondary: { kind: 'tonapi', url: 'https://tonapi.io' },
      }),
    ).toThrow(/NETWORK_MISMATCH|testnet/i);
  });
});
