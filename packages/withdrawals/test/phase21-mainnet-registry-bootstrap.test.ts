import { afterEach, describe, expect, it } from 'vitest';

import {
  runPhase21MainnetRegistryBootstrap,
  type Phase21MainnetRegistryBootstrapClient,
} from '../src/phase21-mainnet-registry-bootstrap.js';

type Row = Record<string, unknown>;

function mockEmptyClient(): Phase21MainnetRegistryBootstrapClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>() {
      return { rows: [] as unknown as T[] };
    },
  };
}

function mockConflictNetworkClient(): Phase21MainnetRegistryBootstrapClient {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string) {
      if (text.includes('FROM networks')) {
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              chain: 'TON',
              environment: 'TESTNET',
              global_chain_identifier: 'ton:testnet',
              status: 'ACTIVE',
            },
          ] as unknown as T[],
        };
      }
      return { rows: [] as unknown as T[] };
    },
  };
}

describe('phase21 mainnet registry bootstrap', () => {
  const prevApply = process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY;
  const prevCeremony = process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;

  afterEach(() => {
    if (prevApply === undefined) delete process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY;
    else process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY = prevApply;
    if (prevCeremony === undefined) delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    else process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED = prevCeremony;
  });

  it('defaults to DRY_RUN with CREATE plan when empty', async () => {
    delete process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    const result = await runPhase21MainnetRegistryBootstrap(mockEmptyClient(), {
      usdtJettonMaster: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
    });
    expect(result.mode).toBe('DRY_RUN');
    expect(result.applied).toBe(false);
    expect(
      result.items.some((i) => i.resource === 'networks:TON_MAINNET' && i.action === 'CREATE'),
    ).toBe(true);
    expect(result.items.some((i) => i.resource === 'hot_wallets:MAINNET_SLOT')).toBe(true);
    expect(result.items.find((i) => i.resource === 'hot_wallets:MAINNET_SLOT')?.action).toBe(
      'DOCUMENTED_ONLY',
    );
  });

  it('apply-off stays DRY_RUN even if apply env alone is set', async () => {
    process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY = '1';
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    const result = await runPhase21MainnetRegistryBootstrap(mockEmptyClient(), {
      usdtJettonMaster: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
    });
    expect(result.mode).toBe('DRY_RUN');
    expect(result.applied).toBe(false);
  });

  it('conflict refuses apply', async () => {
    const result = await runPhase21MainnetRegistryBootstrap(
      mockConflictNetworkClient(),
      { usdtJettonMaster: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw' },
      { forceApply: true },
    );
    expect(result.applied).toBe(false);
    expect(result.conflicts.some((c) => c.resource === 'networks:TON_MAINNET')).toBe(true);
  });

  it('rejects placeholder jetton master', async () => {
    await expect(
      runPhase21MainnetRegistryBootstrap(mockEmptyClient(), {
        usdtJettonMaster: 'LOCAL-PLACEHOLDER-USDT',
      }),
    ).rejects.toThrow(/PLACEHOLDER|LOCAL/);
  });
});
