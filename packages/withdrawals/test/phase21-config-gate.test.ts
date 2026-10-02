import { describe, expect, it } from 'vitest';

import {
  PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS,
  PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MAX,
  PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MIN,
  PHASE21_NETWORK_CODE,
  PHASE21_NETWORK_GLOBAL_ID,
  assertPhase21Ready,
  assessPhase21InitialFundingExposure,
  buildPhase21PayoutConfig,
  listPhase21MissingResources,
  phase21ReadyCheck,
} from '../src/phase21-config.js';
import { WithdrawalDomainError } from '../src/errors.js';
import { buildPhase10PayoutConfig } from '../src/phase10-config.js';

describe('phase21 config gate', () => {
  it('rejects when phase21MainnetEnabled is not explicitly true', () => {
    expect(() => buildPhase21PayoutConfig({})).toThrow(/phase21MainnetEnabled/);
    expect(() => buildPhase21PayoutConfig({ phase21MainnetEnabled: false })).toThrow(
      /phase21MainnetEnabled/,
    );
  });

  it('accepts TON_MAINNET/-239 only in explicit Phase21 mode', () => {
    const config = buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: true,
      fakeChainEnabled: false,
      signerServiceToken: 'x'.repeat(32),
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://tonapi.io',
      jettonMasterIdentity: 'EQ_owner_approved_mainnet_usdt_jetton_master',
      signerBaseUrl: 'https://signer.example.internal',
    });
    expect(config.networkCode).toBe(PHASE21_NETWORK_CODE);
    expect(config.networkGlobalId).toBe(PHASE21_NETWORK_GLOBAL_ID);
    expect(config.autoPayoutAllowed).toBe(false);
    expect(config.autoUnpauseAllowed).toBe(false);
    expect(config.autoResendAllowed).toBe(false);
    expect(config.manualApprovalOnly).toBe(true);
    expect(config.signerKeyMode).toBe('self_hosted_encrypted');
  });

  it('rejects wrong network / Testnet global id / fake chain / auto payout', () => {
    expect(() =>
      buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        networkCode: 'TON_TESTNET',
      }),
    ).toThrow(/TON_MAINNET/);
    expect(() =>
      buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        networkGlobalId: -3,
      }),
    ).toThrow(/-239|Testnet/);
    expect(() =>
      buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        fakeChainEnabled: true,
      }),
    ).toThrow(/fake-chain|fake chain/i);
    expect(() =>
      buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        autoPayoutAllowed: true,
      }),
    ).toThrow(/auto payout/i);
    expect(() =>
      buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        autoUnpauseAllowed: true,
      }),
    ).toThrow(/auto unpause/i);
    expect(() =>
      buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        autoResendAllowed: true,
      }),
    ).toThrow(/auto resend/i);
  });

  it('rejects Testnet/local Jetton placeholders as Mainnet master', () => {
    for (const placeholder of PHASE21_FORBIDDEN_JETTON_PLACEHOLDERS) {
      expect(() =>
        buildPhase21PayoutConfig({
          phase21MainnetEnabled: true,
          jettonMasterIdentity: placeholder,
        }),
      ).toThrow(/Testnet|placeholder|cannot/i);
    }
  });

  it('blocks when real chain resources missing', () => {
    const config = buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: true,
      signerServiceToken: 'x'.repeat(32),
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://tonapi.io',
      jettonMasterIdentity: null,
      signerBaseUrl: 'https://signer.example.internal',
    });
    const missing = listPhase21MissingResources(config);
    expect(missing.some((m) => m.includes('TON_MAINNET_USDT_JETTON_MASTER'))).toBe(true);
    expect(() => assertPhase21Ready(config)).toThrow(WithdrawalDomainError);
    expect(phase21ReadyCheck(config).ready).toBe(false);
  });

  it('rejects identical primary/secondary endpoints as non-independent', () => {
    const config = buildPhase21PayoutConfig({
      phase21MainnetEnabled: true,
      realChainEnabled: true,
      signerServiceToken: 'x'.repeat(32),
      jettonMasterIdentity: 'EQ_owner_approved_mainnet_usdt_jetton_master',
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://toncenter.com/api/v2',
      secondaryProviderKind: 'toncenter',
      secondaryProviderUrl: 'https://toncenter.com/api/v2',
      signerBaseUrl: 'https://signer.example.internal',
    });
    const missing = listPhase21MissingResources(config);
    expect(missing.some((m) => m.includes('independent'))).toBe(true);
  });

  it('requires self_hosted_encrypted signer key mode', () => {
    expect(() =>
      buildPhase21PayoutConfig({
        phase21MainnetEnabled: true,
        signerKeyMode: 'local_ephemeral',
      }),
    ).toThrow(/self_hosted_encrypted/);
  });

  it('assesses micro-launch funding band (5-10 USDT atomic) without inventing balances', () => {
    expect(assessPhase21InitialFundingExposure(null).status).toBe('NOT_OBSERVED');
    expect(assessPhase21InitialFundingExposure(PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MIN).status).toBe(
      'WITHIN_BAND',
    );
    expect(
      assessPhase21InitialFundingExposure(PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MAX + 1n).status,
    ).toBe('EXCESSIVE');
    expect(
      assessPhase21InitialFundingExposure(PHASE21_MICRO_LAUNCH_USDT_ATOMIC_MIN - 1n).status,
    ).toBe('BELOW_BAND');
  });

  it('Phase10 Testnet config still rejects Mainnet unchanged', () => {
    expect(() =>
      buildPhase10PayoutConfig({ networkCode: 'TON_MAINNET', networkGlobalId: -3 }),
    ).toThrow(/MAINNET/);
    expect(() =>
      buildPhase10PayoutConfig({ networkCode: 'TON_TESTNET', networkGlobalId: -239 }),
    ).toThrow(/MAINNET/);
  });
});
