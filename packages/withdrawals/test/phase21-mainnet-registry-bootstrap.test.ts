import { afterEach, describe, expect, it } from 'vitest';

import {
  planPhase21MainnetRegistryBootstrap,
  runPhase21MainnetRegistryBootstrap,
  type Phase21MainnetRegistryBootstrapClient,
} from '../src/phase21-mainnet-registry-bootstrap.js';

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

  it('plans CREATE for network+assets+rules when empty (one-pass plan)', async () => {
    delete process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    const items = await planPhase21MainnetRegistryBootstrap(mockEmptyClient(), {
      usdtJettonMaster: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
    });
    const resources = items.map((i) => i.resource);
    expect(resources).toContain('networks:TON_MAINNET');
    expect(resources).toContain('assets:USDT');
    expect(resources).toContain('assets:GRAM');
    expect(resources).toContain('withdrawal_fee_rules:v1');
    expect(resources).toContain('withdrawal_limit_rules:v1');
    expect(resources).toContain('hot_wallets:MAINNET_SLOT');
    expect(items.filter((i) => i.action === 'CREATE').length).toBeGreaterThanOrEqual(5);
    expect(items.find((i) => i.resource === 'hot_wallets:MAINNET_SLOT')?.action).toBe(
      'DOCUMENTED_ONLY',
    );
  });

  it('run stays PLAN without gates; no forceApply', async () => {
    process.env.PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY = '1';
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    const result = await runPhase21MainnetRegistryBootstrap(mockEmptyClient(), {
      usdtJettonMaster: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
    });
    expect(result.mode).toBe('PLAN');
    expect(result.applied).toBe(false);
    expect(result.notes.some((n) => n.includes('forceApply'))).toBe(true);
  });

  it('conflict refused in plan', async () => {
    const items = await planPhase21MainnetRegistryBootstrap(mockConflictNetworkClient(), {
      usdtJettonMaster: 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw',
    });
    expect(items.some((c) => c.resource === 'networks:TON_MAINNET' && c.action === 'CONFLICT')).toBe(
      true,
    );
  });

  it('rejects placeholder jetton master', async () => {
    await expect(
      planPhase21MainnetRegistryBootstrap(mockEmptyClient(), {
        usdtJettonMaster: 'LOCAL-PLACEHOLDER-USDT',
      }),
    ).rejects.toThrow(/PLACEHOLDER|LOCAL/);
  });
});
