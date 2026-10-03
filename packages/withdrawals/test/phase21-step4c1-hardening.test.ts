import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyPhase21HotWalletRegistration,
  planPhase21HotWalletRegistration,
} from '../src/phase21-hot-wallet-registration.js';
import { applyPhase21ProductionFlagBaseline } from '../src/phase21-production-flag-baseline.js';
import { applyPhase21MainnetRegistryBootstrap } from '../src/phase21-mainnet-registry-bootstrap.js';
import { verifyPhase21HotWalletRegistrationReadOnly } from '../src/phase21-hot-wallet-post-register-verify.js';
import { __phase21TestSetApplyEnv } from '../src/phase21-ceremony-apply-gates.js';
import {
  __mintPhase21HotWalletBackupAttestationForTests,
  __mintPhase21HotWalletRegisterConfirmationForTests,
  __mintPhase21ProductionFlagsApplyConfirmationForTests,
} from '../src/phase21-ceremony-confirmations.js';
import { mintAuthenticatedPhase21OwnerCeremonyTrustForTests } from '../src/test-only/phase21-ceremony-test-hooks.js';
import { buildPhase21HotWalletIdentityProofDocument } from '../src/phase21-hot-wallet-identity-proof.js';
import { resolvePhase21HotWalletDerivationProofFromEnv } from '../src/phase21-hot-wallet-derivation-proof.js';

const FAKE_ADDR = 'EQD0vdSA_NedR9uvbgN9EikRX-suesDxGeFg69XQMavfLqIw';
const FAKE_JETTON = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const FAKE_FP = 'phase21-test-fingerprint-abcdef0123456789';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const NET_ID = '11111111-1111-4111-8111-111111111111';
const USDT_ID = '22222222-2222-4222-8222-222222222222';
const GRAM_ID = '33333333-3333-4333-8333-333333333333';

function identityProof() {
  return buildPhase21HotWalletIdentityProofDocument({
    addressRaw: '0:f83568056ea08e20640bf64d120c83fca27407f5c8ff3310dc06bdcdec360bcb',
    addressFriendly: FAKE_ADDR,
    publicKeyFingerprintSha256: FAKE_FP,
    encryptedBundleSha256: 'a0cd6cd1b871ea7664a4f66bb56ccb3794da551c5d0e920ecda2e188061e5c43',
  });
}

function derivationComplete(payout = FAKE_ADDR, owner = FAKE_ADDR, master = FAKE_ADDR) {
  return {
    primaryJettonWalletAddress: payout,
    secondaryJettonWalletAddress: payout,
    method: 'DUAL_PROVIDER_LIVE' as const,
    ownerAddress: owner,
    jettonMaster: master,
    verifiedAt: '2026-10-03T00:00:00.000Z',
    primaryProviderKind: 'toncenter',
    secondaryProviderKind: 'tonapi',
  };
}

function registryClient(opts?: {
  usdtDecimals?: number;
  usdtNative?: boolean;
  usdtMaster?: string | null;
  gramDecimals?: number;
  gramNative?: boolean;
  gramIdentity?: string | null;
}) {
  const usdtDecimals = opts?.usdtDecimals ?? 6;
  const usdtNative = opts?.usdtNative ?? false;
  const usdtMaster = opts?.usdtMaster === undefined ? FAKE_ADDR : opts.usdtMaster;
  const gramDecimals = opts?.gramDecimals ?? 9;
  const gramNative = opts?.gramNative ?? true;
  const gramIdentity = opts?.gramIdentity === undefined ? null : opts.gramIdentity;
  return {
    async query(text: string) {
      if (text.includes('FROM networks')) return { rows: [{ id: NET_ID }] };
      if (text.includes("symbol = 'USDT'")) {
        return {
          rows: [
            {
              id: USDT_ID,
              contract_identity: usdtMaster,
              decimals: usdtDecimals,
              is_native: usdtNative,
            },
          ],
        };
      }
      if (text.includes("symbol = 'GRAM'")) {
        return {
          rows: [
            {
              id: GRAM_ID,
              contract_identity: gramIdentity,
              decimals: gramDecimals,
              is_native: gramNative,
            },
          ],
        };
      }
      if (text.includes('FROM hot_wallets') && text.includes('COUNT')) {
        return { rows: [{ c: 0 }] };
      }
      if (text.includes('FROM hot_wallets')) return { rows: [] };
      if (text.includes('current_database')) {
        return { rows: [{ name: 'alex_rewards_phase20_test', current_database: 'alex_rewards_phase20_test' }] };
      }
      if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
      return { rows: [] };
    },
  };
}

describe('phase21 step 4C.1 hardening', () => {
  beforeEach(() => {
    process.env.ALEX_PHASE21_CEREMONY_TEST_HOOKS = '1';
  });

  const envKeys = [
    'DEPLOYMENT_ENV',
    'PHASE21_OPERATIONAL_CEREMONY_ENABLED',
    'PHASE21_HOT_WALLET_REGISTER_APPLY',
    'PHASE21_PRODUCTION_FLAG_BASELINE_APPLY',
    'PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY',
    'PHASE21_CEREMONY_REQUIRED_DATABASE_NAME',
    'PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER',
    'ALEX_PHASE21_CEREMONY_TEST_HOOKS',
    'PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE',
    'PHASE21_HOT_WALLET_DERIVATION_PRIMARY',
    'PHASE21_HOT_WALLET_DERIVATION_SECONDARY',
    'PHASE21_HOT_WALLET_DERIVATION_METHOD',
    'PHASE21_HOT_WALLET_DERIVATION_OWNER',
    'PHASE21_HOT_WALLET_DERIVATION_JETTON_MASTER',
    'PHASE21_HOT_WALLET_DERIVATION_PRIMARY_PROVIDER',
    'PHASE21_HOT_WALLET_DERIVATION_SECONDARY_PROVIDER',
    'PHASE21_HOT_WALLET_DERIVATION_VERIFIED_AT',
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

  it('9. missing final flags confirmation refused', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
        return { rows: [] };
      },
    };
    const result = await applyPhase21ProductionFlagBaseline(client as never, {
      reason: 'test',
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: OWNER_ID,
        currentDatabase: 'alex_rewards_phase20_test',
        systemIdentifier: '1',
      }),
      applyConfirmation: undefined as never,
    });
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toBe('OWNER_TRUST_OR_CONFIRMATION_REQUIRED');
  });

  it('10. missing final registry confirmation refused', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_MAINNET_REGISTRY_BOOTSTRAP_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const client = {
      async query(text: string) {
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
        return { rows: [] };
      },
    };
    // Type system requires applyConfirmation; cast proves runtime still refuses if omitted.
    const result = await applyPhase21MainnetRegistryBootstrap(client as never, {
      usdtJettonMaster: FAKE_ADDR,
      ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
        adminUserId: OWNER_ID,
        currentDatabase: 'alex_rewards_phase20_test',
        systemIdentifier: '1',
      }),
    } as never);
    expect(result.applied).toBe(false);
    expect(result.refuseCode).toMatch(/OWNER_TRUST_OR_CONFIRMATION|CONFIRMATION/);
  });

  it('11-12. missing/forged hot-wallet confirmation refused; branded passes gate check', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_HOT_WALLET_REGISTER_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'alex_rewards_phase20_test',
      systemIdentifier: '1',
    });
    const base = {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      reason: 'test',
      ownerTrust: trust,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
      derivationProof: derivationComplete(),
    };
    const client = registryClient();
    const missing = await applyPhase21HotWalletRegistration(client as never, {
      ...base,
      applyConfirmation: undefined as never,
    });
    expect(missing.applied).toBe(false);
    expect(missing.refuseCode).toBe('OWNER_TRUST_OR_PROOF_REQUIRED');

    const forged = await applyPhase21HotWalletRegistration(client as never, {
      ...base,
      applyConfirmation: { brand: 'Phase21HotWalletRegisterConfirmation' } as never,
    });
    expect(forged.applied).toBe(false);
    expect(forged.refuseCode).toBe('OWNER_TRUST_OR_PROOF_REQUIRED');

    // Branded confirmation reaches apply gates (may still refuse on seat/plan) — not confirmation error.
    const withConf = await applyPhase21HotWalletRegistration(client as never, {
      ...base,
      applyConfirmation: __mintPhase21HotWalletRegisterConfirmationForTests(),
    });
    expect(withConf.refuseCode).not.toBe('OWNER_TRUST_OR_PROOF_REQUIRED');
  });

  it('13-15. OWNER_SUPPLIED / incomplete / same-provider provenance refused', async () => {
    const client = registryClient();
    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'alex_rewards_phase20_test',
      systemIdentifier: '1',
    });
    const baseInput = {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      reason: 'test',
      ownerTrust: trust,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
    };
    const ownerSupplied = await planPhase21HotWalletRegistration(client as never, {
      ...baseInput,
      derivationProof: {
        ...derivationComplete(),
        method: 'OWNER_SUPPLIED_EVIDENCE',
      },
    });
    expect(ownerSupplied.canRegister).toBe(false);

    const incomplete = await planPhase21HotWalletRegistration(client as never, {
      ...baseInput,
      derivationProof: {
        primaryJettonWalletAddress: FAKE_ADDR,
        secondaryJettonWalletAddress: FAKE_ADDR,
        method: 'DUAL_PROVIDER_LIVE',
        ownerAddress: FAKE_ADDR,
        jettonMaster: FAKE_ADDR,
      },
    });
    expect(incomplete.canRegister).toBe(false);

    const sameProvider = await planPhase21HotWalletRegistration(client as never, {
      ...baseInput,
      derivationProof: {
        ...derivationComplete(),
        primaryProviderKind: 'toncenter',
        secondaryProviderKind: 'toncenter',
      },
    });
    expect(sameProvider.canRegister).toBe(false);

    const ok = await planPhase21HotWalletRegistration(client as never, {
      ...baseInput,
      derivationProof: derivationComplete(),
    });
    expect(ok.canRegister).toBe(true);
  });

  it('16-19. USDT/GRAM registry truth mismatches refuse READY', async () => {
    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'db',
      systemIdentifier: '1',
    });
    const base = {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      reason: 'test',
      ownerTrust: trust,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
      derivationProof: derivationComplete(),
    };
    expect(
      (await planPhase21HotWalletRegistration(registryClient({ usdtDecimals: 9 }) as never, base))
        .canRegister,
    ).toBe(false);
    expect(
      (await planPhase21HotWalletRegistration(registryClient({ usdtNative: true }) as never, base))
        .canRegister,
    ).toBe(false);
    expect(
      (
        await planPhase21HotWalletRegistration(registryClient({ usdtMaster: FAKE_JETTON }) as never, {
          ...base,
          expectedJettonMaster: FAKE_ADDR,
          derivationProof: derivationComplete(FAKE_ADDR, FAKE_ADDR, FAKE_JETTON),
        })
      ).canRegister,
    ).toBe(false);
    expect(
      (
        await planPhase21HotWalletRegistration(
          registryClient({ gramDecimals: 6, gramNative: false, gramIdentity: FAKE_ADDR }) as never,
          base,
        )
      ).canRegister,
    ).toBe(false);
  });

  it('20-21. post-register audit missing fails; present passes', async () => {
    let auditCount = 0;
    const client = {
      async query(text: string) {
        if (text === 'BEGIN READ ONLY' || text === 'ROLLBACK') return { rows: [] };
        if (text.includes('SHOW transaction_read_only')) {
          return { rows: [{ transaction_read_only: 'on' }] };
        }
        if (text.includes('FROM networks')) return { rows: [{ id: NET_ID }] };
        if (text.includes('FROM hot_wallets')) {
          return {
            rows: [
              {
                id: '44444444-4444-4444-8444-444444444444',
                address: FAKE_ADDR,
                friendly_address: FAKE_ADDR,
                wallet_version: 'v5R1',
                signer_type: 'FALLBACK_ENCRYPTED',
                signer_reference: FAKE_FP,
                status: 'ACTIVE',
                payout_jetton_wallet_address: FAKE_ADDR,
              },
            ],
          };
        }
        if (text.includes('FROM audit_logs')) return { rows: [{ c: auditCount }] };
        return { rows: [] };
      },
    };
    await expect(
      verifyPhase21HotWalletRegistrationReadOnly(client as never, {
        address: FAKE_ADDR,
        signerReference: FAKE_FP,
        payoutJettonWalletAddress: FAKE_ADDR,
        adminUserId: OWNER_ID,
      }),
    ).rejects.toMatchObject({ code: 'REGISTRATION_AUDIT_MISSING' });

    auditCount = 1;
    const ok = await verifyPhase21HotWalletRegistrationReadOnly(client as never, {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      adminUserId: OWNER_ID,
    });
    expect(ok.auditPresent).toBe(true);
    expect(ok.auditCount).toBe(1);
    expect(ok.readyForLivePayout).toBe(false);
  });

  it('22-24. rollback/commit honesty classifications', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'production',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_HOT_WALLET_REGISTER_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const trust = mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
      adminUserId: OWNER_ID,
      currentDatabase: 'alex_rewards_phase20_test',
      systemIdentifier: '1',
    });
    const input = {
      address: FAKE_ADDR,
      signerReference: FAKE_FP,
      payoutJettonWalletAddress: FAKE_ADDR,
      reason: 'test',
      ownerTrust: trust,
      identityProof: identityProof(),
      hotWalletBackupAttestation: __mintPhase21HotWalletBackupAttestationForTests(),
      applyConfirmation: __mintPhase21HotWalletRegisterConfirmationForTests(),
      derivationProof: derivationComplete(),
    };

    // COMMIT error after mutation
    const commitFail = {
      async query(text: string) {
        if (text === 'BEGIN') return { rows: [] };
        if (text === 'COMMIT') throw new Error('commit boom');
        if (text.includes('pg_advisory')) return { rows: [] };
        if (text.includes('admin_owner_authority')) return { rows: [{ holder: OWNER_ID }] };
        if (text.includes('FROM admin_users')) return { rows: [{ id: OWNER_ID, status: 'ACTIVE' }] };
        if (text.includes('admin_role_bindings')) return { rows: [{ c: 1 }] };
        if (text.includes('FROM networks')) return { rows: [{ id: NET_ID }] };
        if (text.includes("symbol = 'USDT'")) {
          return {
            rows: [{ id: USDT_ID, contract_identity: FAKE_ADDR, decimals: 6, is_native: false }],
          };
        }
        if (text.includes("symbol = 'GRAM'")) {
          return {
            rows: [{ id: GRAM_ID, contract_identity: null, decimals: 9, is_native: true }],
          };
        }
        if (text.includes('FROM hot_wallets') && text.includes('COUNT')) return { rows: [{ c: 0 }] };
        if (text.includes('FROM hot_wallets') && text.includes('SELECT id, status')) {
          return { rows: [] };
        }
        if (text.includes('INSERT INTO hot_wallets')) {
          return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
        }
        if (text.includes('INSERT INTO audit_logs')) return { rows: [] };
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
        return { rows: [] };
      },
    };
    const commitResult = await applyPhase21HotWalletRegistration(commitFail as never, input);
    expect(commitResult.refuseCode).toBe('REGISTRATION_RECONCILIATION_REQUIRED');
    expect(commitResult.mutationState).toBe('UNKNOWN');
    expect(commitResult.notes.some((n) => n.includes('DO_NOT_RETRY'))).toBe(true);

    // ROLLBACK success after mutation
    let inserted = false;
    const rollbackOk = {
      async query(text: string) {
        if (text === 'BEGIN' || text === 'ROLLBACK') return { rows: [] };
        if (text.includes('pg_advisory')) return { rows: [] };
        if (text.includes('admin_owner_authority')) return { rows: [{ holder: OWNER_ID }] };
        if (text.includes('FROM admin_users')) return { rows: [{ id: OWNER_ID, status: 'ACTIVE' }] };
        if (text.includes('admin_role_bindings')) return { rows: [{ c: 1 }] };
        if (text.includes('FROM networks')) return { rows: [{ id: NET_ID }] };
        if (text.includes("symbol = 'USDT'")) {
          return {
            rows: [{ id: USDT_ID, contract_identity: FAKE_ADDR, decimals: 6, is_native: false }],
          };
        }
        if (text.includes("symbol = 'GRAM'")) {
          return {
            rows: [{ id: GRAM_ID, contract_identity: null, decimals: 9, is_native: true }],
          };
        }
        if (text.includes('FROM hot_wallets') && text.includes('COUNT')) return { rows: [{ c: 0 }] };
        if (text.includes('FROM hot_wallets') && text.includes('SELECT id, status')) {
          return { rows: [] };
        }
        if (text.includes('INSERT INTO hot_wallets')) {
          inserted = true;
          return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
        }
        if (text.includes('INSERT INTO audit_logs')) throw new Error('audit boom');
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
        return { rows: [] };
      },
    };
    const aborted = await applyPhase21HotWalletRegistration(rollbackOk as never, input);
    expect(inserted).toBe(true);
    expect(aborted.refuseCode).toBe('TRANSACTION_ABORTED_CONFIRMED');

    // ROLLBACK failure after mutation
    const rollbackFail = {
      async query(text: string) {
        if (text === 'BEGIN') return { rows: [] };
        if (text === 'ROLLBACK') throw new Error('rollback boom');
        if (text.includes('pg_advisory')) return { rows: [] };
        if (text.includes('admin_owner_authority')) return { rows: [{ holder: OWNER_ID }] };
        if (text.includes('FROM admin_users')) return { rows: [{ id: OWNER_ID, status: 'ACTIVE' }] };
        if (text.includes('admin_role_bindings')) return { rows: [{ c: 1 }] };
        if (text.includes('FROM networks')) return { rows: [{ id: NET_ID }] };
        if (text.includes("symbol = 'USDT'")) {
          return {
            rows: [{ id: USDT_ID, contract_identity: FAKE_ADDR, decimals: 6, is_native: false }],
          };
        }
        if (text.includes("symbol = 'GRAM'")) {
          return {
            rows: [{ id: GRAM_ID, contract_identity: null, decimals: 9, is_native: true }],
          };
        }
        if (text.includes('FROM hot_wallets') && text.includes('COUNT')) return { rows: [{ c: 0 }] };
        if (text.includes('FROM hot_wallets') && text.includes('SELECT id, status')) {
          return { rows: [] };
        }
        if (text.includes('INSERT INTO hot_wallets')) {
          return { rows: [{ id: '55555555-5555-4555-8555-555555555555' }] };
        }
        if (text.includes('INSERT INTO audit_logs')) throw new Error('audit boom');
        if (text.includes('current_database')) {
          return { rows: [{ name: 'alex_rewards_phase20_test' }] };
        }
        if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
        return { rows: [] };
      },
    };
    const recon = await applyPhase21HotWalletRegistration(rollbackFail as never, input);
    expect(recon.refuseCode).toBe('REGISTRATION_RECONCILIATION_REQUIRED');
    expect(recon.mutationState).toBe('UNKNOWN');
  });

  it('25. no funding/signer unlock side effects in plan/apply refuse paths', async () => {
    const client = registryClient();
    const plan = await planPhase21HotWalletRegistration(client as never);
    expect(plan.canRegister).toBe(false);
    expect(plan.notes.join(' ')).not.toMatch(/fund|unlock|broadcast|unpause/i);
  });

  it('ENV without provider kinds is not APPLY-ready', () => {
    snap();
    delete process.env.PHASE21_HOT_WALLET_DERIVATION_PROOF_FILE;
    process.env.PHASE21_HOT_WALLET_DERIVATION_PRIMARY = FAKE_ADDR;
    process.env.PHASE21_HOT_WALLET_DERIVATION_SECONDARY = FAKE_ADDR;
    process.env.PHASE21_HOT_WALLET_DERIVATION_METHOD = 'DUAL_PROVIDER_LIVE';
    process.env.PHASE21_HOT_WALLET_DERIVATION_OWNER = FAKE_ADDR;
    process.env.PHASE21_HOT_WALLET_DERIVATION_JETTON_MASTER = FAKE_ADDR;
    delete process.env.PHASE21_HOT_WALLET_DERIVATION_PRIMARY_PROVIDER;
    delete process.env.PHASE21_HOT_WALLET_DERIVATION_SECONDARY_PROVIDER;
    delete process.env.PHASE21_HOT_WALLET_DERIVATION_VERIFIED_AT;
    const resolved = resolvePhase21HotWalletDerivationProofFromEnv();
    expect(resolved.refuseCode).toBe('DERIVATION_PROOF_ENV_PROVENANCE_INCOMPLETE');
    expect(resolved.proof).not.toBeNull();
  });

  it('branded flags confirmation type required at call site', async () => {
    snap();
    __phase21TestSetApplyEnv({
      DEPLOYMENT_ENV: 'staging',
      PHASE21_OPERATIONAL_CEREMONY_ENABLED: 'true',
      PHASE21_PRODUCTION_FLAG_BASELINE_APPLY: '1',
      PHASE21_CEREMONY_REQUIRED_DATABASE_NAME: 'alex_rewards_phase20_test',
      PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER: '1',
    });
    const result = await applyPhase21ProductionFlagBaseline(
      {
        async query(text: string) {
          if (text.includes('current_database')) {
            return { rows: [{ name: 'alex_rewards_phase20_test' }] };
          }
          if (text.includes('pg_control_system')) return { rows: [{ sid: '1' }] };
          return { rows: [] };
        },
      } as never,
      {
        reason: 'test',
        ownerTrust: mintAuthenticatedPhase21OwnerCeremonyTrustForTests({
          adminUserId: OWNER_ID,
          currentDatabase: 'alex_rewards_phase20_test',
          systemIdentifier: '1',
        }),
        applyConfirmation: __mintPhase21ProductionFlagsApplyConfirmationForTests(),
      },
    );
    expect(result.refuseCode).toBe('STAGING_APPLY_FORBIDDEN');
  });
});
