import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  validateProviderIndependence,
  verifyMainnetUsdtWithTwoProviders,
  type MainnetIdentityProbeAdapter,
  type Phase21TwoProviderVerificationResult,
  type UsdtJettonMetadataProbeAdapter,
} from '../src/phase21-external-probes.js';
import { applyPhase21MainnetRegistryBootstrap } from '../src/phase21-mainnet-registry-bootstrap.js';
import { verifyPhase21MainnetRegistryBootstrapReadOnly } from '../src/phase21-mainnet-registry-post-apply-verify.js';
import {
  assertAuthenticatedPhase21MainnetRegistryVerification,
  mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass,
  Phase21MainnetRegistryVerificationError,
} from '../src/phase21-mainnet-registry-verification-trust.js';
import { __phase21TestSetApplyEnv } from '../src/phase21-ceremony-apply-gates.js';
import { __mintPhase21MainnetRegistryApplyConfirmationForTests } from '../src/phase21-ceremony-confirmations.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';
import { mintAuthenticatedPhase21MainnetRegistryVerificationForTests } from '../src/test-only/phase21-mainnet-registry-verification-test-hooks.js';

const MASTER = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const DB = 'alex_rewards_phase21_test';

function enableCeremonyHooks(): void {
  process.env.NODE_ENV = 'test';
  process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
  process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
}

function identityAdapter(globalId: number | null): MainnetIdentityProbeAdapter {
  return {
    async probe(input) {
      return {
        ok: globalId === -239,
        networkGlobalId: globalId,
        providerHost: new URL(input.providerUrl).hostname,
        message: globalId === -239 ? 'mainnet' : 'not mainnet',
      };
    },
  };
}

function metadataAdapter(opts?: {
  symbol?: string;
  decimals?: number;
  observed?: string | null;
}): UsdtJettonMetadataProbeAdapter {
  const symbol = opts?.symbol ?? 'USDT';
  const decimals = opts?.decimals ?? 6;
  const observed = opts?.observed === undefined ? MASTER : opts.observed;
  return {
    async probe(input) {
      return {
        ok: symbol === 'USDT' && decimals === 6 && observed !== null,
        symbol,
        decimals,
        observedJettonMaster: observed,
        providerHost: new URL(input.providerUrl).hostname,
        message: 'ok',
      };
    },
  };
}

function passResult(
  overrides?: Partial<Phase21TwoProviderVerificationResult>,
): Phase21TwoProviderVerificationResult {
  return {
    ok: true,
    code: 'MAINNET_USDT_TWO_PROVIDER_OK',
    message: 'pass',
    independence: {
      ok: true,
      code: 'PROVIDERS_INDEPENDENT',
      message: 'independent',
    },
    primary: {
      providerKind: 'toncenter',
      providerHost: 'toncenter.example.test',
      networkIdentity: '-239',
      observedAt: '2026-10-03T00:00:00.000Z',
      resource: 'jetton_metadata',
      verificationMethod: 'two_provider_orchestrated',
      ok: true,
    },
    secondary: {
      providerKind: 'tonapi',
      providerHost: 'tonapi.example.test',
      networkIdentity: '-239',
      observedAt: '2026-10-03T00:00:00.000Z',
      resource: 'jetton_metadata',
      verificationMethod: 'two_provider_orchestrated',
      ok: true,
    },
    networkCode: 'TON_MAINNET',
    networkGlobalId: -239,
    jettonMaster: MASTER,
    primaryObservedJettonMaster: MASTER,
    secondaryObservedJettonMaster: MASTER,
    symbol: 'USDT',
    decimals: 6,
    verifiedAt: '2026-10-03T00:00:00.000Z',
    notes: [],
    ...overrides,
  };
}

describe('phase21 step4c2 mainnet registry verification hardening', () => {
  const prev: Record<string, string | undefined> = {};
  const keys = [
    'PHASE21_EXTERNAL_PROBE_LIVE',
    'ALEX_PHASE21_CEREMONY_TEST_HOOKS',
    'ALEX_OWNER_BOOTSTRAP_TEST_HOOKS',
    'ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM',
    'NODE_ENV',
    'DEPLOYMENT_ENV',
    'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
    'PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY',
    'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
    'PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
  ] as const;

  beforeEach(() => {
    for (const k of keys) prev[k] = process.env[k];
  });

  afterEach(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it('forged Mainnet verification trust refused', () => {
    expect(() =>
      assertAuthenticatedPhase21MainnetRegistryVerification({
        ok: true,
        networkGlobalId: -239,
        symbol: 'USDT',
        decimals: 6,
        jettonMaster: MASTER,
      }),
    ).toThrow(Phase21MainnetRegistryVerificationError);
  });

  it('raw successful verification result refused without live mint gate', () => {
    delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    expect(() =>
      mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass({
        verification: passResult(),
        requestedJettonMaster: MASTER,
      }),
    ).toThrow(/LIVE_PROBE_REQUIRED|PHASE21_EXTERNAL_PROBE_LIVE/);
  });

  it('incomplete / mock verification cannot mint trust', () => {
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    expect(() =>
      mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass({
        verification: passResult({
          incomplete: true,
          ok: false,
          code: 'USDT_METADATA_INCOMPLETE',
        }),
        requestedJettonMaster: MASTER,
      }),
    ).toThrow(/INCOMPLETE|NOT_PASS|incomplete/i);
    expect(() =>
      mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass({
        verification: passResult({ ok: false, code: 'MOCK' }),
        requestedJettonMaster: MASTER,
      }),
    ).toThrow(/full PASS|NOT_PASS|MOCK/i);
  });

  it('same provider kind / same host refused; wrong global id refused', async () => {
    const sameKind = validateProviderIndependence(
      { kind: 'toncenter', url: 'https://a.example/v2' },
      { kind: 'toncenter', url: 'https://b.example/v2' },
    );
    expect(sameKind.ok).toBe(false);

    const sameHost = validateProviderIndependence(
      { kind: 'toncenter', url: 'https://shared.example/v2' },
      { kind: 'tonapi', url: 'https://shared.example/v2' },
    );
    expect(sameHost.ok).toBe(false);

    const badId = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
      jettonMaster: MASTER,
      identityAdapter: identityAdapter(0),
      metadataAdapter: metadataAdapter(),
    });
    expect(badId.ok).toBe(false);
    expect(badId.code).toMatch(/MAINNET_IDENTITY/);
  });

  it('symbol / decimals / observed master mismatch refused', async () => {
    const badSymbol = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
      jettonMaster: MASTER,
      identityAdapter: identityAdapter(-239),
      metadataAdapter: metadataAdapter({ symbol: 'NOTUSDT' }),
    });
    expect(badSymbol.ok).toBe(false);

    const badDecimals = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
      jettonMaster: MASTER,
      identityAdapter: identityAdapter(-239),
      metadataAdapter: metadataAdapter({ decimals: 9 }),
    });
    expect(badDecimals.ok).toBe(false);

    const badMaster = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
      jettonMaster: MASTER,
      identityAdapter: identityAdapter(-239),
      metadataAdapter: metadataAdapter({
        observed: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
      }),
    });
    expect(badMaster.ok).toBe(false);
    expect(badMaster.code).toMatch(/OBSERVED_JETTON_MASTER/);
  });

  it('live PASS mints branded trust; APPLY requires branded verification + exact master', async () => {
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    enableCeremonyHooks();
    const live = await verifyMainnetUsdtWithTwoProviders({
      primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
      jettonMaster: MASTER,
      identityAdapter: identityAdapter(-239),
      metadataAdapter: metadataAdapter(),
    });
    expect(live.ok).toBe(true);
    const branded = mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass({
      verification: live,
      requestedJettonMaster: MASTER,
    });
    expect(branded.networkGlobalId).toBe(-239);
    expect(branded.symbol).toBe('USDT');
    expect(branded.decimals).toBe(6);
    expect(branded.providersIndependent).toBe(true);

    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: DB,
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) return { rows: [{ name: DB }] };
        if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
        return { rows: [] };
      },
    };
    const missing = await applyPhase21MainnetRegistryBootstrap(client as never, {
      usdtJettonMaster: MASTER,
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: OWNER_ID,
        currentDatabase: DB,
        systemIdentifier: '1',
      }),
      applyConfirmation: __mintPhase21MainnetRegistryApplyConfirmationForTests(),
    } as never);
    expect(missing.applied).toBe(false);
    expect(missing.refuseCode).toMatch(/MAINNET_VERIFICATION|CONFIRMATION|TRUST/);

    const wrongMaster = mintAuthenticatedPhase21MainnetRegistryVerificationForTests({
      jettonMaster: 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
      simulationDatabaseName: DB,
    });
    const mismatch = await applyPhase21MainnetRegistryBootstrap(client as never, {
      usdtJettonMaster: MASTER,
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: OWNER_ID,
        currentDatabase: DB,
        systemIdentifier: '1',
      }),
      applyConfirmation: __mintPhase21MainnetRegistryApplyConfirmationForTests(),
      mainnetVerification: wrongMaster,
    });
    expect(mismatch.applied).toBe(false);
    expect(mismatch.refuseCode).toBe('REGISTRY_VERIFIED_MASTER_MISMATCH');
  });

  it('post-registry verifier is READ ONLY and refuses missing audit', async () => {
    enableCeremonyHooks();
    const verification = mintAuthenticatedPhase21MainnetRegistryVerificationForTests({
      jettonMaster: MASTER,
      simulationDatabaseName: DB,
    });
    let beganReadOnly = false;
    const client = {
      async query(text: string) {
        if (text === 'BEGIN READ ONLY') {
          beganReadOnly = true;
          return { rows: [] };
        }
        if (text.includes('SHOW transaction_read_only')) {
          return { rows: [{ transaction_read_only: 'on' }] };
        }
        if (text.includes('FROM networks')) {
          return {
            rows: [
              {
                id: OWNER_ID,
                code: 'TON_MAINNET',
                chain: 'TON',
                environment: 'MAINNET',
                status: 'ACTIVE',
              },
            ],
          };
        }
        if (text.includes("symbol = 'USDT'")) {
          return {
            rows: [
              {
                id: OWNER_ID,
                symbol: 'USDT',
                decimals: 6,
                is_native: false,
                contract_identity: MASTER,
                status: 'ACTIVE',
              },
            ],
          };
        }
        if (text.includes("symbol = 'GRAM'")) {
          return {
            rows: [
              {
                id: OWNER_ID,
                symbol: 'GRAM',
                decimals: 9,
                is_native: true,
                contract_identity: null,
                status: 'ACTIVE',
              },
            ],
          };
        }
        if (text.includes('withdrawal_fee_rules')) {
          return { rows: [{ fixed_fee_atomic: '10000' }] };
        }
        if (text.includes('withdrawal_limit_rules')) {
          return {
            rows: [
              {
                min_withdrawal_atomic: '200000',
                max_single_withdrawal_atomic: '5000000',
              },
            ],
          };
        }
        if (text.includes('FROM audit_logs')) {
          return { rows: [{ c: 0 }] };
        }
        if (text.includes('FROM hot_wallets')) {
          return { rows: [{ c: 0 }] };
        }
        if (text === 'ROLLBACK') return { rows: [] };
        return { rows: [] };
      },
    };
    await expect(
      verifyPhase21MainnetRegistryBootstrapReadOnly(client as never, {
        mainnetVerification: verification,
        adminUserId: OWNER_ID,
      }),
    ).rejects.toThrow(/REGISTRY_AUDIT_MISSING|audit/);
    expect(beganReadOnly).toBe(true);
  });
});
