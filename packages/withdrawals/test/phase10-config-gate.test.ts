import { describe, expect, it } from 'vitest';

import {
  assertPhase10Ready,
  buildPhase10PayoutConfig,
  listPhase10MissingResources,
  phase10ReadyCheck,
} from '../src/phase10-config.js';
import { WithdrawalDomainError } from '../src/errors.js';

describe('phase10 config gate', () => {
  it('rejects MAINNET network codes and global id -239', () => {
    expect(() =>
      buildPhase10PayoutConfig({ networkCode: 'TON_MAINNET', networkGlobalId: -3 }),
    ).toThrow(/MAINNET/);
    expect(() =>
      buildPhase10PayoutConfig({ networkCode: 'TON_TESTNET', networkGlobalId: -239 }),
    ).toThrow(/MAINNET/);
  });

  it('blocks when real chain enabled but Jetton master missing', () => {
    const config = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'x'.repeat(32),
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
      jettonMasterIdentity: null,
    });
    const missing = listPhase10MissingResources(config);
    expect(missing.some((m) => m.includes('TON_TESTNET_JETTON_MASTER'))).toBe(true);
    expect(() => assertPhase10Ready(config)).toThrow(WithdrawalDomainError);
    try {
      assertPhase10Ready(config);
    } catch (error) {
      expect(error).toBeInstanceOf(WithdrawalDomainError);
      expect((error as WithdrawalDomainError).code).toBe('EXTERNAL_RESOURCE_REQUIRED');
      expect((error as WithdrawalDomainError).publicMessage).toContain(
        'PHASE10_EXTERNAL_RESOURCE_REQUIRED',
      );
    }
  });

  it('requires independent primary and secondary provider credentials', () => {
    const config = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: 'EQ_owner_approved_testnet_jetton_master',
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      primaryProviderApiKey: 'primary-key',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
      secondaryProviderApiKey: 'secondary-key',
    });
    expect(config.primaryProvider.apiKey).toBe('primary-key');
    expect(config.secondaryProvider.apiKey).toBe('secondary-key');
    expect(phase10ReadyCheck(config).ready).toBe(true);
  });

  it('rejects identical primary/secondary endpoints as non-independent', () => {
    const config = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: 'EQ_owner_approved_testnet_jetton_master',
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'toncenter',
      secondaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
    });
    const missing = listPhase10MissingResources(config);
    expect(missing.some((m) => m.includes('operationally independent'))).toBe(true);
  });

  it('phase10ReadyCheck reports incomplete Owner resources', () => {
    const config = buildPhase10PayoutConfig({ realChainEnabled: false });
    const check = phase10ReadyCheck(config);
    expect(check.ready).toBe(false);
    expect(check.missingResources.length).toBeGreaterThan(0);
  });

  it('ready when Owner resources present', () => {
    const config = buildPhase10PayoutConfig({
      realChainEnabled: true,
      signerServiceToken: 'local-signer-service-token-32chars!!',
      jettonMasterIdentity: 'EQ_owner_approved_testnet_jetton_master',
      primaryProviderKind: 'toncenter',
      primaryProviderUrl: 'https://testnet.toncenter.com/api/v2',
      secondaryProviderKind: 'tonapi',
      secondaryProviderUrl: 'https://testnet.tonapi.io',
    });
    expect(phase10ReadyCheck(config).ready).toBe(true);
    expect(() => assertPhase10Ready(config)).not.toThrow();
  });
});
