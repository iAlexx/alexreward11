import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Phase21TwoProviderVerificationResult } from '../src/phase21-external-probes.js';
import { applyPhase21MainnetRegistryBootstrap } from '../src/phase21-mainnet-registry-bootstrap.js';
import {
  PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_SECONDS,
  assertPhase21MainnetRegistryVerificationFresh,
  runLivePhase21MainnetRegistryVerificationAndMintTrust,
  __runSimulatedLivePhase21MainnetRegistryVerificationAndMintTrustForTests,
} from '../src/phase21-mainnet-registry-live-verify-mint.js';
import {
  assertAuthenticatedPhase21MainnetRegistryVerification,
  Phase21MainnetRegistryVerificationError,
} from '../src/phase21-mainnet-registry-verification-trust.js';
import { __phase21TestSetApplyEnv } from '../src/phase21-ceremony-apply-gates.js';
import { __mintPhase21MainnetRegistryApplyConfirmationForTests } from '../src/phase21-ceremony-confirmations.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';
import { mintAuthenticatedPhase21MainnetRegistryVerificationForTests } from '../src/test-only/phase21-mainnet-registry-verification-test-hooks.js';

const MASTER = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const DB = 'alex_rewards_phase21_test';

function enableAllTestGates(): void {
  process.env.NODE_ENV = 'test';
  process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  process.env.ALEX_OWNER_BOOTSTRAP_TEST_HOOKS = '1';
  process.env.ALEX_OWNER_BOOTSTRAP_DISPOSABLE_PRODUCTION_SIM = '1';
}

function fakeFullPass(): Phase21TwoProviderVerificationResult {
  return {
    ok: true,
    code: 'MAINNET_USDT_TWO_PROVIDER_OK',
    message: 'forged diagnostic pass',
    independence: {
      ok: true,
      code: 'PROVIDERS_INDEPENDENT',
      message: 'independent',
    },
    primary: {
      providerKind: 'toncenter',
      providerHost: 'toncenter.forged.test',
      networkIdentity: '-239',
      observedAt: new Date().toISOString(),
      resource: 'jetton_metadata',
      verificationMethod: 'forged',
      ok: true,
    },
    secondary: {
      providerKind: 'tonapi',
      providerHost: 'tonapi.forged.test',
      networkIdentity: '-239',
      observedAt: new Date().toISOString(),
      resource: 'jetton_metadata',
      verificationMethod: 'forged',
      ok: true,
    },
    networkCode: 'TON_MAINNET',
    networkGlobalId: -239,
    jettonMaster: MASTER,
    primaryObservedJettonMaster: MASTER,
    secondaryObservedJettonMaster: MASTER,
    symbol: 'USDT',
    decimals: 6,
    verifiedAt: new Date().toISOString(),
    notes: ['FORGED'],
  };
}

describe('phase21 step4c3 mainnet trust-mint forgery closure', () => {
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

  it('FULL_FAKE_PASS_WITH_LIVE_ENV cannot mint via public API', async () => {
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    const root = await import('../src/index.js');
    expect(
      Object.prototype.hasOwnProperty.call(
        root,
        'mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass',
      ),
    ).toBe(false);
    expect(
      (root as Record<string, unknown>).mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass,
    ).toBeUndefined();
    expect(
      (root as Record<string, unknown>).runLivePhase21MainnetRegistryVerificationAndMintTrust,
    ).toBeUndefined();

    const fake = fakeFullPass();
    // There is no public production function that accepts this object.
    expect(typeof (root as Record<string, unknown>).mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass).toBe(
      'undefined',
    );
    void fake;
  });

  it('forged trust-shaped object refused by WeakSet assert', () => {
    expect(() =>
      assertAuthenticatedPhase21MainnetRegistryVerification({
        brand: 'AuthenticatedPhase21MainnetRegistryVerification',
        trustClass: 'AuthenticatedPhase21MainnetRegistryVerification',
        networkCode: 'TON_MAINNET',
        networkGlobalId: -239,
        jettonMaster: MASTER,
        symbol: 'USDT',
        decimals: 6,
        primary: {
          providerKind: 'toncenter',
          providerHost: 'a.test',
          networkIdentity: '-239',
          observedJettonMaster: MASTER,
          verificationMethod: 'forged',
        },
        secondary: {
          providerKind: 'tonapi',
          providerHost: 'b.test',
          networkIdentity: '-239',
          observedJettonMaster: MASTER,
          verificationMethod: 'forged',
        },
        providersIndependent: true,
        verifiedAt: new Date().toISOString(),
        witnessModel: 'LIVE_TWO_PROVIDER_MAINNET',
      }),
    ).toThrow(Phase21MainnetRegistryVerificationError);
  });

  it('raw fake result is not APPLY authority', async () => {
    enableAllTestGates();
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
    const result = await applyPhase21MainnetRegistryBootstrap(client as never, {
      usdtJettonMaster: MASTER,
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: OWNER_ID,
        currentDatabase: DB,
        systemIdentifier: '1',
      }),
      applyConfirmation: __mintPhase21MainnetRegistryApplyConfirmationForTests(),
      mainnetVerification: fakeFullPass() as never,
    });
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toMatch(/MAINNET_VERIFICATION|TRUST|CONFIRMATION/);
  });

  it('stale branded verification refused before APPLY', () => {
    enableAllTestGates();
    const trust = mintAuthenticatedPhase21MainnetRegistryVerificationForTests({
      jettonMaster: MASTER,
      verifiedAt: new Date(Date.now() - (PHASE21_MAINNET_REGISTRY_VERIFICATION_MAX_AGE_SECONDS + 30) * 1000).toISOString(),
      simulationDatabaseName: DB,
    });
    expect(() => assertPhase21MainnetRegistryVerificationFresh(trust)).toThrow(
      /older than 120s|STALE|MAINNET_VERIFICATION_STALE/,
    );
  });

  it('test-only simulated live adapter injection requires all gates', async () => {
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    process.env.NODE_ENV = 'production';
    delete process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS;
    const fetchImpl = (async (_input?: string | URL | Request) => new Response('{}')) as typeof fetch;
    await expect(
      __runSimulatedLivePhase21MainnetRegistryVerificationAndMintTrustForTests({
        jettonMaster: MASTER,
        primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
        secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
        fetchImpl,
      }),
    ).rejects.toThrow(/NODE_ENV=test|FORBIDDEN/);
  });

  it('production live verify+mint rejects missing live env and does not accept precomputed result', async () => {
    delete process.env.PHASE21_EXTERNAL_PROBE_LIVE;
    await expect(
      runLivePhase21MainnetRegistryVerificationAndMintTrust({
        jettonMaster: MASTER,
        primary: { kind: 'toncenter', url: 'https://toncenter.example/v2' },
        secondary: { kind: 'tonapi', url: 'https://tonapi.example/v2' },
      }),
    ).rejects.toThrow(/LIVE_PROBE_REQUIRED|PHASE21_EXTERNAL_PROBE_LIVE/);

    // Type/runtime: production function has no verification/adapters parameters.
    expect(runLivePhase21MainnetRegistryVerificationAndMintTrust.length).toBe(1);
  });

  it('fake diagnostic JSON cannot be reloaded as APPLY authority', async () => {
    enableAllTestGates();
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    const reloaded = JSON.parse(JSON.stringify(fakeFullPass())) as Phase21TwoProviderVerificationResult;
    expect(reloaded.ok).toBe(true);
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
    const result = await applyPhase21MainnetRegistryBootstrap(client as never, {
      usdtJettonMaster: MASTER,
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: OWNER_ID,
        currentDatabase: DB,
        systemIdentifier: '1',
      }),
      applyConfirmation: __mintPhase21MainnetRegistryApplyConfirmationForTests(),
      mainnetVerification: reloaded as never,
    });
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toMatch(/MAINNET_VERIFICATION|TRUST|CONFIRMATION/);
  });

  it('test-only controlled HTTP simulation can mint under gates', async () => {
    process.env.PHASE21_EXTERNAL_PROBE_LIVE = '1';
    enableAllTestGates();

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('getMasterchainInfo')) {
        return new Response(
          JSON.stringify({ ok: true, result: { last: { seqno: 1 } } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
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
          { status: 200, headers: { 'content-type': 'application/json' } },
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
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/v2/status')) {
        return new Response(JSON.stringify({ rest_online: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v2/blockchain/config')) {
        return new Response(JSON.stringify({ global_id: -239 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/v2/jettons/')) {
        return new Response(
          JSON.stringify({
            address: MASTER,
            metadata: { symbol: 'USDT', decimals: 6 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ ok: false, error: 'unexpected ' + url }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const minted = await __runSimulatedLivePhase21MainnetRegistryVerificationAndMintTrustForTests({
      jettonMaster: MASTER,
      primary: { kind: 'toncenter', url: 'https://toncenter.com/api/v2' },
      secondary: { kind: 'tonapi', url: 'https://tonapi.io' },
      fetchImpl,
    });
    expect(minted.trust.networkGlobalId).toBe(-239);
    expect(minted.trust.symbol).toBe('USDT');
    expect(minted.trust.decimals).toBe(6);
    expect(minted.diagnostic.ok).toBe(true);
    assertAuthenticatedPhase21MainnetRegistryVerification(minted.trust);
    assertPhase21MainnetRegistryVerificationFresh(minted.trust);
  });


  it('CLI source uses internal live verify+mint, not public raw-result mint', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const cli = fs.readFileSync(
      path.join(__dirname, '../src/cli/phase21-ops.ts'),
      'utf8',
    );
    expect(cli).toContain('runLivePhase21MainnetRegistryVerificationAndMintTrust');
    expect(cli).not.toContain('mintAuthenticatedPhase21MainnetRegistryVerificationFromLiveTwoProviderPass');
  });
});
