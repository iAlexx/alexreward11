import { beginCell, Address } from '@ton/core';
import { describe, expect, it, vi } from 'vitest';

import { tonAddressesEqual } from '../src/address.js';
import {
  extractTonapiDecodedJettonWalletAddress,
  extractTonapiStackJettonWalletAddress,
  TonapiMainnetReadonlyClient,
} from '../src/tonapi-mainnet-readonly.js';
const MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const OWNER = 'EQD4NWgFbqCOIGQL9k0SDIP8onQH9cj_MxDcBr3N7DYLy8Lf';
const DERIVED = 'EQBmOtaP1QggnfmeyNtywTphoJqZ56h7O0wBDnpkqxdKN8vV';
const OTHER_DERIVED = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const API_KEY = 'super-secret-tonapi-key-should-never-leak';

function addressCellBocBase64(address: string): string {
  return beginCell().storeAddress(Address.parse(address)).endCell().toBoc().toString('base64');
}

describe('TonAPI Mainnet getJettonWalletAddress via get_wallet_address', () => {
  it('A/B derives for never-indexed owner and does not call account jettons balance endpoint', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      expect(url).not.toMatch(/\/v2\/accounts\/[^/]+\/jettons\//);
      expect(url).toContain('/v2/blockchain/accounts/');
      expect(url).toContain('/methods/get_wallet_address');
      expect(url).toContain('args=');
      return new Response(
        JSON.stringify({
          success: true,
          exit_code: 0,
          stack: [],
          decoded: { jetton_wallet_address: DERIVED },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      apiKey: API_KEY,
      fetchImpl,
    });
    const result = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/get_wallet_address/);
    expect(tonAddressesEqual(result.jettonWalletAddress ?? '', DERIVED)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledUrl = String(vi.mocked(fetchImpl).mock.calls[0]![0]);
    expect(calledUrl).not.toContain(API_KEY);
  });

  it('C accepts TonAPI derived address equal to Toncenter-equivalent', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          exit_code: 0,
          decoded: { jettonWalletAddress: DERIVED },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    const result = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(result.ok).toBe(true);
    expect(tonAddressesEqual(result.jettonWalletAddress ?? '', DERIVED)).toBe(true);
  });

  it('D TonAPI derived address is stable/canonical for dual-provider equality checks', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          exit_code: 0,
          decoded: { jetton_wallet_address: DERIVED },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    const a = await client.getJettonWalletAddress(MASTER, OWNER);
    const b = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(a.ok && b.ok).toBe(true);
    expect(tonAddressesEqual(a.jettonWalletAddress ?? '', b.jettonWalletAddress ?? '')).toBe(true);
    expect(tonAddressesEqual(a.jettonWalletAddress ?? '', OTHER_DERIVED)).toBe(false);
  });

  it('E malformed/missing get-method output fails closed', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ success: true, exit_code: 0, stack: [], decoded: {} }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    const result = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(result.ok).toBe(false);
    expect(result.jettonWalletAddress).toBeNull();
  });

  it('F non-zero/failed method execution fails closed', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: false,
          exit_code: 11,
          decoded: { jetton_wallet_address: DERIVED },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    const result = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/success=false|exit_code/i);
  });

  it('G API keys never appear in errors/output', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`upstream failed api_key=${API_KEY} Authorization=Bearer ${API_KEY}`);
    }) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      apiKey: API_KEY,
      fetchImpl,
    });
    const result = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it('H never introduces send/broadcast endpoints', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      expect(method).toBe('GET');
      expect(url).not.toMatch(/send|broadcast|emulat|message/i);
      return new Response(
        JSON.stringify({
          success: true,
          exit_code: 0,
          decoded: { jetton_wallet_address: DERIVED },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    await client.getJettonWalletAddress(MASTER, OWNER);
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('parses stack cell fallback when decoded absent', async () => {
    const boc = addressCellBocBase64(DERIVED);
    expect(extractTonapiDecodedJettonWalletAddress({})).toBeNull();
    expect(
      extractTonapiStackJettonWalletAddress([{ type: 'cell', cell: boc }]),
    ).not.toBeNull();
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          exit_code: 0,
          stack: [{ type: 'cell', cell: boc }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    const result = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(result.ok).toBe(true);
    expect(tonAddressesEqual(result.jettonWalletAddress ?? '', DERIVED)).toBe(true);
  });

  it('exit_code non-zero fails even if decoded present', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          exit_code: 2,
          decoded: { jetton_wallet_address: DERIVED },
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const client = new TonapiMainnetReadonlyClient({
      baseUrl: 'https://tonapi.io',
      fetchImpl,
    });
    const result = await client.getJettonWalletAddress(MASTER, OWNER);
    expect(result.ok).toBe(false);
  });
});
