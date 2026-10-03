import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  planPhase21HotWalletRegistration,
  applyPhase21HotWalletRegistration,
} from '../src/phase21-hot-wallet-registration.js';
import { __phase21TestSetApplyEnv } from '../src/phase21-ceremony-apply-gates.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';
import { __mintPhase21HotWalletBackupAttestationForTests } from '../src/phase21-ceremony-confirmations.js';
import { buildPhase21HotWalletIdentityProofDocument } from '../src/phase21-hot-wallet-identity-proof.js';

const FAKE_ADDR = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
const FAKE_JETTON = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const FAKE_FP = 'phase21-test-fingerprint-abcdef0123456789';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';

function identityProof() {
  return buildPhase21HotWalletIdentityProofDocument({
    addressRaw: '0:f83568056ea08e20640bf64d120c83fca27407f5c8ff3310dc06bdcdec360bcb',
    addressFriendly: FAKE_ADDR,
    publicKeyFingerprintSha256: FAKE_FP,
    encryptedBundleSha256: 'a0cd6cd1b871ea7664a4f66bb56ccb3794da551c5d0e920ecda2e188061e5c43',
  });
}

function derivation(payout = FAKE_ADDR, owner = FAKE_ADDR, master = FAKE_ADDR) {
  return {
    primaryJettonWalletAddress: payout,
    secondaryJettonWalletAddress: payout,
    method: 'DUAL_PROVIDER_LIVE' as const,
    ownerAddress: owner,
    jettonMaster: master,
  };
}

describe('phase21 hot wallet registration', () => {
  const envKeys = [
    'DEPLOYMENT_ENV',
    'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
    'PHASE21_HOT_WALLET_REGISTER_APPLY',
    'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
    'PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
    'ALEX_PHASE21_CEREMONY_TEST_HOOKS',
  ] as const;
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  });

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
    });
    expect(planMissingProof.canRegister).toBe(false);
    expect(
      planMissingProof.items.some(
        (i) => i.check === 'jetton_wallet_derivation_proof' && i.status === 'MISSING',
      ),
    ).toBe(true);

    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'alex_rewards_phase20_test',
      systemIdentifier: '1',
    });
    const plan = await planPhase21HotWalletRegistration(client, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      reason: 'test plan',
      ownerTrust: trust,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
      derivationProof: derivation(FAKE_ADDR, FAKE_ADDR, FAKE_ADDR),
    });
    expect(plan.canRegister).toBe(true);
  });

  it('plan reports OWNER_ATTESTATION_REQUIRED without backup attestation', async () => {
    const client = {
      async query(text: string) {
        if (text.includes('FROM networks')) {
          return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }] };
        }
        if (text.includes('FROM assets')) {
          return {
            rows: [
              {
                id: '22222222-2222-4222-8222-222222222222',
                contract_identity: FAKE_ADDR,
              },
            ],
          };
        }
        if (text.includes('FROM hot_wallets') && text.includes('COUNT')) {
          return { rows: [{ c: 0 }] };
        }
        if (text.includes('FROM hot_wallets')) {
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    const plan = await planPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      reason: 'test',
      identityProof: identityProof(),
      derivationProof: derivation(),
    });
    expect(plan.canRegister).toBe(false);
    expect(
      plan.items.some(
        (i) =>
          i.check === 'hot_wallet_backup_attestation' &&
          i.status === 'OWNER_ATTESTATION_REQUIRED',
      ),
    ).toBe(true);
  });

  it('apply refuses without gates / forceApply', async () => {
    snap();
    delete process.env.DEPLOYMENT_ENV;
    delete process.env.PHASE21_OPERATIONAL_CEREMONY_ENABLED;
    delete process.env.PHASE21_HOT_WALLET_REGISTER_APPLY;
    delete process.env.PHASE21_CEREMONY_REQUIRED_DATABASE_NAME;
    delete process.env.PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER;
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) {
          return { rows: [{ sid: '1' }] };
        }
        return { rows: [] };
      },
    };
    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'alex_rewards_phase20_test',
      systemIdentifier: '1',
    });
    const result = await applyPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      ownerTrust: trust,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
      derivationProof: derivation(FAKE_JETTON, FAKE_ADDR, FAKE_ADDR),
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
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) {
          return { rows: [{ sid: '1' }] };
        }
        return { rows: [] };
      },
    };
    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'alex_rewards_phase20_test',
      systemIdentifier: '1',
    });
    const result = await applyPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      ownerTrust: trust,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
      derivationProof: derivation(FAKE_JETTON, FAKE_ADDR, FAKE_ADDR),
    });
    expect(result.refuseCode).toBe('STAGING_APPLY_FORBIDDEN');
  });

  it('forged ownerTrust cannot authorize apply', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_HOT_WALLET_REGISTER_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) {
          return { rows: [{ sid: '1' }] };
        }
        return { rows: [] };
      },
    };
    const forged = {
      brand: 'AuthenticatedPhase21OwnerCeremonyTrust' as const,
      trustClass: 'AuthenticatedPhase21OwnerCeremonyTrust' as const,
      adminUserId: OWNER_ID,
      authenticatedAt: new Date().toISOString(),
      currentDatabase: 'alex_rewards_phase20_test',
      systemIdentifier: '1',
      authMethod: 'PASSWORD_TOTP' as const,
      authStateMutationOccurred: true as const,
      witnessModel: 'LIVE_OWNER_TTY' as const,
    };
    const result = await applyPhase21HotWalletRegistration(client as never, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_JETTON,
      reason: 'test',
      ownerTrust: forged,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
      derivationProof: derivation(FAKE_JETTON, FAKE_ADDR, FAKE_ADDR),
    });
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toBe('OWNER_TRUST_OR_PROOF_REQUIRED');
  });
});
