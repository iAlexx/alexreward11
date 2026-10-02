import { describe, expect, it, vi } from 'vitest';

import { TonapiMainnetReadonlyClient } from '../src/tonapi-mainnet-readonly.js';
import {
  parseToncenterV3JettonIndexedMetadata,
  ToncenterMainnetReadonlyClient,
} from '../src/toncenter-mainnet-readonly.js';

const MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';

describe('Toncenter Mainnet jetton metadata (v3 indexed)', () => {
  it('parses symbol+decimals from token_info / extra', () => {
    const parsed = parseToncenterV3JettonIndexedMetadata({
      jetton_masters: [{ address: MASTER, jetton_content: {} }],
      metadata: {
        [MASTER]: {
          is_indexed: true,
          token_info: [
            {
              valid: true,
              type: 'jetton_masters',
              symbol: 'USDT',
              extra: { decimals: '6' },
            },
          ],
        },
      },
    });
    expect(parsed.symbol).toBe('USDT');
    expect(parsed.decimals).toBe(6);
    expect(parsed.metadataSource).toMatch(/token_info/);
  });

  it('getJettonMetadata ok only with indexed source + get_jetton_data reachability', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v3/jetton/masters')) {
        return new Response(
          JSON.stringify({
            jetton_masters: [{ address: MASTER, jetton_content: { symbol: 'USDT', decimals: 6 } }],
            metadata: {
              [MASTER]: {
                token_info: [
                  {
                    valid: true,
                    type: 'jetton_masters',
                    symbol: 'USDT',
                    extra: { decimals: '6' },
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('runGetMethod') || init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              exit_code: 0,
              stack: [
                ['num', '0x1'],
                ['num', '0x0'],
                ['cell', { bytes: 'te6cckEBAQEAAgAAAA==' }],
                ['cell', { bytes: 'te6cckEBAQEAAgAAAA==' }],
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }) as unknown as typeof fetch;

    const client = new ToncenterMainnetReadonlyClient({
      baseUrl: 'https://toncenter.com/api/v2',
      fetchImpl,
    });
    const result = await client.getJettonMetadata(MASTER);
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe('USDT');
    expect(result.decimals).toBe(6);
    expect(result.observedJettonMaster).toBeTruthy();
    expect(result.metadataSource).toBeTruthy();
  });

  it('get_jetton_data alone is not ok=true', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/v3/jetton/masters')) {
        return new Response(JSON.stringify({ jetton_masters: [], metadata: {} }), {
          status: 200,
        });
      }
      if (url.includes('runGetMethod') || init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            result: {
              exit_code: 0,
              stack: [
                ['num', '0x1'],
                ['num', '0x0'],
                ['cell', { bytes: 'te6cckEBAQEAAgAAAA==' }],
                ['cell', { bytes: 'te6cckEBAQEAAgAAAA==' }],
              ],
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }) as unknown as typeof fetch;

    const client = new ToncenterMainnetReadonlyClient({
      baseUrl: 'https://toncenter.com/api/v2',
      fetchImpl,
    });
    const result = await client.getJettonMetadata(MASTER);
    expect(result.ok).toBe(false);
  });
});

describe('TonAPI Mainnet jetton metadata observed master', () => {
  it('returns observedJettonMaster from response', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          address: MASTER,
          metadata: { symbol: 'USDT', decimals: '6', address: MASTER },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    const result = await client.getJettonMetadata(MASTER);
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe('USDT');
    expect(result.decimals).toBe(6);
    expect(result.observedJettonMaster).toBeTruthy();
    expect(result.metadataSource).toMatch(/tonapi/);
  });
});
