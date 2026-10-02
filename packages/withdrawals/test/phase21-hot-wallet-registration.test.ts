import { afterEach, describe, expect, it } from 'vitest';

import {
  planPhase21HotWalletRegistration,
  applyPhase21HotWalletRegistration,
} from '../src/phase21-hot-wallet-registration.js';
import { __phase21TestSetApplyEnv } from '../src/phase21-ceremony-apply-gates.js';

const FAKE_ADDR = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
const FAKE_JETTON = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const FAKE_FP = 'phase21-test-fingerprint-abcdef0123456789';

describe('phase21 hot wallet registration', () => {
  const envKeys = [
    'DEPLOYMENT_ENV',
    'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
    'PHASE21_HOT_WALLET_REGISTER_APPLY',
    'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
  ] as const;
  const prev: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of envKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function snap(): void {
    for (const k of envKeys) prev[k] = process.env[k];
  }

  it('plan without inputs does not invent addresses', async () => {
    const client = {
      async query() {
        return { rows: [] };
      },
    };
    const plan = await planPhase21HotWalletRegistration(client);
    expect(plan.canRegister).toBe(false);
    expect(
      plan.items.some(
        (i) =>
          i.check === 'owner_inputs' &&
          String(i.details.address).includes('OWNER_DECISION_REQUIRED'),
      ),
    ).toBe(true);
  });

  it('plan validates disposable address shapes when network/USDT present', async () => {
    const client = {
      async query<T extends Record<string, unknown> = Record<string, unknown>>(text: string) {
        if (text.includes('FROM networks')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] as unknown as T[] };
        }
        if (text.includes('FROM assets')) {
          return {
            rows: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                contract_identity: FAKE_ADDR,
              },
            ] as unknown as T[],
          };
        }
        if (text.includes('FROM hot_wallets') && text.includes('COUNT')) {
          return { rows: [{ c: 0 }] as unknown as T[] };
        }
        if (text.includes('FROM hot_wallets')) {
          return { rows: [] as unknown as T[] };
        }
        return { rows: [] as unknown as T[] };
      },
    };
    const planMissingProof = await planPhase21HotWalletRegistration(client, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test plan',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
    });
    expect(planMissingProof.canRegister).toBe(false);
    expect(
      planMissingProof.items.some(
        (i) => i.check === 'jetton_wallet_derivation_proof' && i.status === 'MISSING',
      ),
    ).toBe(true);

    const plan = await planPhase21HotWalletRegistration(client, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      reason: 'test plan',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
      derivationProof: {
        primaryJettonWalletAddress: FAKE_ADDR,
        secondaryJettonWalletAddress: FAKE_ADDR,
        method: 'OWNER_SUPPLIED_EVIDENCE',
      },
    });
    expect(plan.canRegister).toBe(true);
  });

  it('apply refuses without gates / forceApply', async () => {
    snap();
    delete process.env.DEPLOYMENT_ENV;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    delete process.env.PHASE21_HOT_WALLET_REGISTER_APPLY;
    delete process.env.PHASE21_CEREMONY_REQUIRED_DATABASE_NAME;
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        return { rows: [] };
      },
    };
    const result = await applyPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.applied).toBe(false);
    expect(result.mode).toBe('REFUSED');
  });

  it('apply refuses staging', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'staging',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_HOT_WALLET_REGISTER_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
    });
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        return { rows: [] };
      },
    };
    const result = await applyPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      changedByAdminId: '11111111-1111-4111-8111-111111111111',
    });
    expect(result.refuseCode).toBe('STAGING_APPLY_FORBIDDEN');
  });
});
