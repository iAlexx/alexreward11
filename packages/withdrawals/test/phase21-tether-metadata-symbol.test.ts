import { describe, expect, it } from 'vitest';

import {
  normalizeOfficialTetherUsdMetadataSymbol,
  normalizeProviderHost,
  validateProviderIndependence,
  verifyMainnetUsdtWithTwoProviders,
  type MainnetIdentityProbeAdapter,
  type UsdtJettonMetadataProbeAdapter,
} from '../src/phase21-external-probes.js';

const MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const OTHER_MASTER = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const TETHER_BRANDED = 'USD₮';

function identityOk(globalId: number = -239): MainnetIdentityProbeAdapter {
  return {
    async probe(input) {
      return {
        ok: globalId === -239,
        networkGlobalId: globalId,
        message: globalId === -239 ? 'mainnet' : 'wrong network',
        providerHost: normalizeProviderHost(input.providerUrl),
      };
    },
  };
}

function metadata(opts: {
  primarySymbol: string | null;
  secondarySymbol: string | null;
  primaryDecimals?: number | null;
  secondaryDecimals?: number | null;
  primaryMaster?: string | null;
  secondaryMaster?: string | null;
  primaryOk?: boolean;
  secondaryOk?: boolean;
}): UsdtJettonMetadataProbeAdapter {
  return {
    async probe(input) {
      const isPrimary = input.providerKind === 'toncenter';
      const symbol = isPrimary ? opts.primarySymbol : opts.secondarySymbol;
      const decimals = isPrimary
        ? (opts.primaryDecimals === undefined ? 6 : opts.primaryDecimals)
        : (opts.secondaryDecimals === undefined ? 6 : opts.secondaryDecimals);
      const observed = isPrimary
        ? (opts.primaryMaster === undefined ? MASTER : opts.primaryMaster)
        : (opts.secondaryMaster === undefined ? MASTER : opts.secondaryMaster);
      const ok = isPrimary
        ? (opts.primaryOk === undefined ? true : opts.primaryOk)
        : (opts.secondaryOk === undefined ? true : opts.secondaryOk);
      return {
        ok,
        symbol,
        decimals,
        observedJettonMaster: observed,
        metadataSource: 'fixture',
        message: ok ? 'ok' : 'fail',
        providerHost: normalizeProviderHost(input.providerUrl),
      };
    },
  };
}

async function verify(meta: UsdtJettonMetadataProbeAdapter, identity: MainnetIdentityProbeAdapter = identityOk()) {
  return verifyMainnetUsdtWithTwoProviders({
    primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
    secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
    jettonMaster: MASTER,
    identityAdapter: identity,
    metadataAdapter: meta,
  });
}

describe('official Tether USD metadata symbol normalization', () => {
  it('normalizes exact allowlisted variants only', () => {
    expect(normalizeOfficialTetherUsdMetadataSymbol('USDT')).toBe('USDT');
    expect(normalizeOfficialTetherUsdMetadataSymbol(TETHER_BRANDED)).toBe('USDT');
    expect(normalizeOfficialTetherUsdMetadataSymbol('USDt')).toBe('USDT');
    expect(normalizeOfficialTetherUsdMetadataSymbol(' USDT ')).toBe('USDT');
    expect(normalizeOfficialTetherUsdMetadataSymbol('USDC')).toBeNull();
    expect(normalizeOfficialTetherUsdMetadataSymbol('USD')).toBeNull();
    expect(normalizeOfficialTetherUsdMetadataSymbol('usdt')).toBeNull();
    expect(normalizeOfficialTetherUsdMetadataSymbol('USD T')).toBeNull();
    expect(normalizeOfficialTetherUsdMetadataSymbol('USD₮T')).toBeNull();
    expect(normalizeOfficialTetherUsdMetadataSymbol(null)).toBeNull();
  });

  it('1 primary branded + secondary branded decimals 6 exact master -> PASS', async () => {
    const result = await verify(
      metadata({ primarySymbol: TETHER_BRANDED, secondarySymbol: TETHER_BRANDED }),
    );
    expect(result.ok).toBe(true);
    expect(result.code).toBe('MAINNET_USDT_TWO_PROVIDER_OK');
    expect(result.symbol).toBe('USDT');
    expect(result.decimals).toBe(6);
    expect(result.primaryObservedSymbol).toBe(TETHER_BRANDED);
    expect(result.secondaryObservedSymbol).toBe(TETHER_BRANDED);
  });

  it('2 primary USDT + secondary USDT decimals 6 -> PASS', async () => {
    const result = await verify(metadata({ primarySymbol: 'USDT', secondarySymbol: 'USDT' }));
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe('USDT');
    expect(result.decimals).toBe(6);
  });

  it('3 branded + ASCII USDT agree via canonical normalization -> PASS', async () => {
    const result = await verify(
      metadata({ primarySymbol: TETHER_BRANDED, secondarySymbol: 'USDT' }),
    );
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe('USDT');
    expect(result.primaryObservedSymbol).toBe(TETHER_BRANDED);
    expect(result.secondaryObservedSymbol).toBe('USDT');
  });

  it('4 USDt ASCII fallback accepted -> PASS', async () => {
    const result = await verify(metadata({ primarySymbol: 'USDt', secondarySymbol: 'USDt' }));
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe('USDT');
  });

  it('5 unknown symbol fails closed', async () => {
    const result = await verify(
      metadata({ primarySymbol: 'TETHERUSD', secondarySymbol: 'TETHERUSD' }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('USDT_METADATA_MISMATCH');
  });

  it('6 USDC fails', async () => {
    const result = await verify(metadata({ primarySymbol: 'USDC', secondarySymbol: 'USDC' }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('USDT_METADATA_MISMATCH');
  });

  it('7 USD fails', async () => {
    const result = await verify(metadata({ primarySymbol: 'USD', secondarySymbol: 'USD' }));
    expect(result.ok).toBe(false);
  });

  it('8 decimals 9 fails', async () => {
    const result = await verify(
      metadata({
        primarySymbol: TETHER_BRANDED,
        secondarySymbol: TETHER_BRANDED,
        primaryDecimals: 9,
        secondaryDecimals: 9,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('USDT_METADATA_MISMATCH');
  });

  it('9 decimals null fails', async () => {
    const result = await verify(
      metadata({
        primarySymbol: TETHER_BRANDED,
        secondarySymbol: TETHER_BRANDED,
        primaryDecimals: null,
        secondaryDecimals: null,
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('10 primary master mismatch fails', async () => {
    const result = await verify(
      metadata({
        primarySymbol: TETHER_BRANDED,
        secondarySymbol: TETHER_BRANDED,
        primaryMaster: OTHER_MASTER,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('OBSERVED_JETTON_MASTER_MISMATCH');
  });

  it('11 secondary master mismatch fails', async () => {
    const result = await verify(
      metadata({
        primarySymbol: 'USDT',
        secondarySymbol: 'USDT',
        secondaryMaster: OTHER_MASTER,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('OBSERVED_JETTON_MASTER_MISMATCH');
  });

  it('12 unrecognized symbol disagreement fails', async () => {
    const result = await verify(
      metadata({ primarySymbol: 'FOO', secondarySymbol: 'BAR' }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/USDT_METADATA|PROVIDER_METADATA/);
  });

  it('13 network identity != -239 fails', async () => {
    const result = await verify(
      metadata({ primarySymbol: TETHER_BRANDED, secondarySymbol: TETHER_BRANDED }),
      identityOk(0),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MAINNET_IDENTITY_FAILED');
  });

  it('14 provider independence failure fails', async () => {
    const indep = validateProviderIndependence(
      { kind: 'toncenter', url: 'https://shared.example/v2' },
      { kind: 'tonapi', url: 'https://shared.example/v2' },
    );
    expect(indep.ok).toBe(false);
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://shared.example/v2' },
      secondary: { kind: 'tonapi', url: 'https://shared.example/v2' },
      jettonMaster: MASTER,
      identityAdapter: identityOk(),
      metadataAdapter: metadata({
        primarySymbol: TETHER_BRANDED,
        secondarySymbol: TETHER_BRANDED,
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.code).toMatch(/INDEPENDENT|PROVIDER/);
  });

  it('15 successful normalized verification returns internal USDT decimals 6', async () => {
    const result = await verify(
      metadata({ primarySymbol: TETHER_BRANDED, secondarySymbol: 'USDt' }),
    );
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe('USDT');
    expect(result.decimals).toBe(6);
    expect(result.networkGlobalId).toBe(-239);
    expect(result.jettonMaster).toBe(MASTER);
  });

  it('16 normalized PASS keeps internal USDT for trust/registry boundary', async () => {
    const result = await verify(
      metadata({ primarySymbol: TETHER_BRANDED, secondarySymbol: TETHER_BRANDED }),
    );
    expect(result.ok).toBe(true);
    expect(result.symbol).toBe('USDT');
    // Registry/trust code consumes result.symbol as internal USDT — never provider display.
    expect(result.symbol).not.toBe(TETHER_BRANDED);
    expect(result.notes?.some((n) => n.includes('primaryObservedSymbol=' + TETHER_BRANDED))).toBe(
      true,
    );
  });

});
