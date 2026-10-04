import { describe, expect, it } from 'vitest';

import {
  normalizeProviderHost,
  runOptionalMainnetProviderReachabilityProbe,
  validateMainnetJettonMasterAddress,
  validateProviderIndependence,
  verifyMainnetUsdtWithTwoProviders,
  type JettonWalletDerivationProbeAdapter,
  type MainnetIdentityProbeAdapter,
  type UsdtJettonMetadataProbeAdapter,
} from '../src/phase21-external-probes.js';

const VALID_MASTER = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';

describe('phase21 external probes (read-only)', () => {
  it('rejects empty and forbidden Jetton master placeholders', () => {
    expect(validateMainnetJettonMasterAddress(null).ok).toBe(false);
    expect(
      validateMainnetJettonMasterAddress('LOCAL-TESTONLY-PLACEHOLDER-USDT-JETTON-MASTER').ok,
    ).toBe(false);
    expect(validateMainnetJettonMasterAddress('EQ_owner_approved_testnet_jetton_master').ok).toBe(
      false,
    );
  });

  it('validates parseable non-placeholder Jetton master shape', () => {
    const result = validateMainnetJettonMasterAddress(VALID_MASTER);
    expect(result.ok).toBe(true);
  });

  it('normalizeProviderHost strips credentials and query', () => {
    expect(normalizeProviderHost('https://user:pass@toncenter.example/api?key=secret')).toBe(
      'toncenter.example',
    );
    expect(normalizeProviderHost('https://TONAPI.EXAMPLE/v2')).toBe('tonapi.example');
  });

  it('requires different vendor kind AND different hostname', () => {
    expect(
      validateProviderIndependence(
        { kind: 'toncenter', url: 'https://a.example/x' },
        { kind: 'toncenter', url: 'https://b.example/y' },
      ).ok,
    ).toBe(false);
    expect(
      validateProviderIndependence(
        { kind: 'toncenter', url: 'https://mainnet.example/a' },
        { kind: 'tonapi', url: 'https://mainnet.example/b' },
      ).ok,
    ).toBe(false);
    expect(
      validateProviderIndependence(
        { kind: 'toncenter', url: 'https://toncenter.example/a' },
        { kind: 'tonapi', url: 'https://api.toncenter.example/b' },
      ).ok,
    ).toBe(false);
    expect(
      validateProviderIndependence(
        { kind: 'toncenter', url: 'https://toncenter.example/a' },
        { kind: 'tonapi', url: 'https://tonapi.example/b' },
      ).ok,
    ).toBe(true);
  });

  it('skips live provider probe unless PHASE21_EXTERNAL_PROBE_LIVE=1', async () => {
    const prior = process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    const skipped = await runOptionalMainnetProviderReachabilityProbe({
      providerUrl: 'https://example.com',
    });
    expect(skipped.ok).toBe(false);
    expect(skipped.message).toMatch(/skipped/i);
    if (prior === undefined) delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    else process.env.PHASE21_EXTERNAL_PROBE_LIVE = prior;
  });

  it('bare HTTP 200 is never Mainnet identity', async () => {
    const prior = process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    const result = await runOptionalMainnetProviderReachabilityProbe({
      providerUrl: 'https://example.com',
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
        }) as Response) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(result.message).toMatch(/insufficient|not proven/i);
    if (prior === undefined) delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    else process.env.PHASE21_EXTERNAL_PROBE_LIVE = prior;
  });

  it('identity adapter can prove Mainnet on reachability probe', async () => {
    const prior = process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    const identityAdapter: MainnetIdentityProbeAdapter = {
      async probe() {
        return {
          ok: true,
          networkGlobalId: -239,
          message: 'mainnet',
          providerHost: 'toncenter.example',
        };
      },
    };
    const result = await runOptionalMainnetProviderReachabilityProbe({
      providerUrl: 'https://toncenter.example',
      providerKind: 'toncenter',
      identityAdapter,
    });
    expect(result.ok).toBe(true);
    expect(result.provenance?.networkIdentity).toBe('-239');
    if (prior === undefined) delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    else process.env.PHASE21_EXTERNAL_PROBE_LIVE = prior;
  });

  it('verifyMainnetUsdtWithTwoProviders fails closed on identity mismatch', async () => {
    const identityAdapter: MainnetIdentityProbeAdapter = {
      async probe(input) {
        return {
          ok: input.providerKind === 'toncenter',
          networkGlobalId: input.providerKind === 'toncenter' ? -239 : -3,
          message: 'mixed',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const metadataAdapter: UsdtJettonMetadataProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          symbol: 'USDT',
          decimals: 6,
          observedJettonMaster: VALID_MASTER,
          metadataSource: 'fixture',
          message: 'ok',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example' },
      jettonMaster: VALID_MASTER,
      identityAdapter,
      metadataAdapter,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('MAINNET_IDENTITY_FAILED');
  });

  it('verifyMainnetUsdtWithTwoProviders passes when identity+metadata agree', async () => {
    const identityAdapter: MainnetIdentityProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          networkGlobalId: -239,
          message: 'mainnet',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const metadataAdapter: UsdtJettonMetadataProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          symbol: 'USDT',
          decimals: 6,
          observedJettonMaster: VALID_MASTER,
          metadataSource: 'fixture',
          message: 'ok',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const walletDerivationAdapter: JettonWalletDerivationProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          jettonWalletAddress: '0:' + 'ab'.repeat(32),
          message: 'derived',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example' },
      jettonMaster: VALID_MASTER,
      ownerAddress: '0:' + 'cd'.repeat(32),
      identityAdapter,
      metadataAdapter,
      walletDerivationAdapter,
    });
    expect(result.ok).toBe(true);
    expect(result.code).toBe('MAINNET_USDT_TWO_PROVIDER_OK');
    expect(result.primary?.networkIdentity).toBe('-239');
    expect(result.secondary?.ok).toBe(true);
  });

  it('verifyMainnetUsdtWithTwoProviders fails on metadata disagreement', async () => {
    const identityAdapter: MainnetIdentityProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          networkGlobalId: -239,
          message: 'mainnet',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const metadataAdapter: UsdtJettonMetadataProbeAdapter = {
      async probe(input) {
        if (input.providerKind === 'tonapi') {
          return {
            ok: true,
            symbol: 'USDT',
            decimals: 9,
            observedJettonMaster: VALID_MASTER,
            metadataSource: 'fixture',
            message: 'wrong decimals',
            providerHost: normalizeProviderHost(input.providerUrl),
          };
        }
        return {
          ok: true,
          symbol: 'USDT',
          decimals: 6,
          observedJettonMaster: VALID_MASTER,
          metadataSource: 'fixture',
          message: 'ok',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example' },
      jettonMaster: VALID_MASTER,
      identityAdapter,
      metadataAdapter,
    });
    expect(result.ok).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(result.code).toBe('USDT_METADATA_INCOMPLETE');
  });

  it('verifyMainnetUsdtWithTwoProviders incomplete when only one metadata trustworthy', async () => {
    const identityAdapter: MainnetIdentityProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          networkGlobalId: -239,
          message: 'mainnet',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const metadataAdapter: UsdtJettonMetadataProbeAdapter = {
      async probe(input) {
        if (input.providerKind === 'tonapi') {
          return {
            ok: false,
            symbol: null,
            decimals: null,
            observedJettonMaster: null,
            message: 'down',
            providerHost: normalizeProviderHost(input.providerUrl),
          };
        }
        return {
          ok: true,
          symbol: 'USDT',
          decimals: 6,
          observedJettonMaster: VALID_MASTER,
          metadataSource: 'fixture',
          message: 'ok',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example' },
      jettonMaster: VALID_MASTER,
      identityAdapter,
      metadataAdapter,
    });
    expect(result.ok).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(result.code).toBe('USDT_METADATA_INCOMPLETE');
  });

  it('verifyMainnetUsdtWithTwoProviders fails on observed master mismatch', async () => {
    const identityAdapter: MainnetIdentityProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          networkGlobalId: -239,
          message: 'mainnet',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const other = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
    const metadataAdapter: UsdtJettonMetadataProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          symbol: 'USDT',
          decimals: 6,
          observedJettonMaster: input.providerKind === 'tonapi' ? other : VALID_MASTER,
          metadataSource: 'fixture',
          message: 'ok',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example' },
      jettonMaster: VALID_MASTER,
      identityAdapter,
      metadataAdapter,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('OBSERVED_JETTON_MASTER_MISMATCH');
  });


  it('verifyMainnetUsdtWithTwoProviders fails on Jetton wallet derivation disagreement', async () => {
    const identityAdapter: MainnetIdentityProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          networkGlobalId: -239,
          message: 'mainnet',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const metadataAdapter: UsdtJettonMetadataProbeAdapter = {
      async probe() {
        return {
          ok: true,
          symbol: 'USDT',
          decimals: 6,
          observedJettonMaster: VALID_MASTER,
          metadataSource: 'fixture',
          message: 'ok',
          providerHost: 'fixture',
        };
      },
    };
    const walletDerivationAdapter: JettonWalletDerivationProbeAdapter = {
      async probe(input) {
        return {
          ok: true,
          jettonWalletAddress:
            input.providerKind === 'toncenter'
              ? '0:' + 'ab'.repeat(32)
              : '0:' + 'cd'.repeat(32),
          message: 'derived',
          providerHost: normalizeProviderHost(input.providerUrl),
        };
      },
    };
    const result = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example' },
      jettonMaster: VALID_MASTER,
      ownerAddress: '0:' + '11'.repeat(32),
      identityAdapter,
      metadataAdapter,
      walletDerivationAdapter,
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe('JETTON_WALLET_DERIVATION_DISAGREE');
  });

});
