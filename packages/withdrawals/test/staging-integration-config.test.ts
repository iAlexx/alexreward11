import { describe, expect, it } from 'vitest';

import {
  localWithdrawalEngineFixtureConfig,
  withdrawalEngineConfigFromValidatedApi,
  type ValidatedWithdrawalApiConfig,
} from '../src/config.js';

const base = {
  WITHDRAWAL_QUOTE_TTL_SECONDS: 300,
  WITHDRAWAL_RISK_POLICY_VERSION: 1,
  WITHDRAWAL_ASSET_SYMBOL: 'USDT',
} satisfies Partial<ValidatedWithdrawalApiConfig>;

describe('withdrawal engine staging integration alignment', () => {
  it('keeps the local TON_TESTNET fixture', () => {
    const config = localWithdrawalEngineFixtureConfig();
    expect(config.deploymentEnvironment).toBe('LOCAL');
    expect(config.acceptedNetworkCode).toBe('TON_TESTNET');
    expect(config.fakeChainEnabled).toBe(true);
    expect(config.stagingIntegrationMode).toBe(false);
  });

  it('keeps historical staging and production fake-chain rejection', () => {
    expect(() =>
      localWithdrawalEngineFixtureConfig({
        deploymentEnvironment: 'STAGING',
        fakeChainEnabled: true,
      }),
    ).toThrow(/Fake payout chain/);
    expect(() =>
      localWithdrawalEngineFixtureConfig({
        deploymentEnvironment: 'PRODUCTION',
        fakeChainEnabled: true,
      }),
    ).toThrow(/Fake payout chain/);
  });

  it('rejects normal staging with TON_TESTNET', () => {
    expect(() =>
      withdrawalEngineConfigFromValidatedApi({
        ...base,
        DEPLOYMENT_ENV: 'staging',
        STAGING_INTEGRATION_MODE: false,
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: false,
      }),
    ).toThrow(/TON_TESTNET is forbidden for staging\/production/);
  });

  it('accepts explicit staging integration with TON_TESTNET and fake chain off', () => {
    const config = withdrawalEngineConfigFromValidatedApi({
      ...base,
      DEPLOYMENT_ENV: 'staging',
      STAGING_INTEGRATION_MODE: true,
      WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
      WITHDRAWAL_FAKE_CHAIN_ENABLED: false,
    });
    expect(config.deploymentEnvironment).toBe('STAGING');
    expect(config.stagingIntegrationMode).toBe(true);
    expect(config.acceptedNetworkCode).toBe('TON_TESTNET');
    expect(config.fakeChainEnabled).toBe(false);
  });

  it('rejects explicit staging integration when fake chain is on', () => {
    expect(() =>
      withdrawalEngineConfigFromValidatedApi({
        ...base,
        DEPLOYMENT_ENV: 'staging',
        STAGING_INTEGRATION_MODE: true,
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: true,
      }),
    ).toThrow(/fakeChainEnabled=false/);
  });

  it('rejects production TON_TESTNET', () => {
    expect(() =>
      withdrawalEngineConfigFromValidatedApi({
        ...base,
        DEPLOYMENT_ENV: 'production',
        STAGING_INTEGRATION_MODE: false,
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: false,
      }),
    ).toThrow(/TON_TESTNET is forbidden for staging\/production/);
  });

  it('rejects production even when staging integration mode is set', () => {
    expect(() =>
      withdrawalEngineConfigFromValidatedApi({
        ...base,
        DEPLOYMENT_ENV: 'production',
        STAGING_INTEGRATION_MODE: true,
        WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
        WITHDRAWAL_FAKE_CHAIN_ENABLED: false,
      }),
    ).toThrow(/only allowed when deployment is STAGING/);
  });

  it('keeps historical production network acceptance unchanged', () => {
    const config = withdrawalEngineConfigFromValidatedApi({
      ...base,
      DEPLOYMENT_ENV: 'production',
      STAGING_INTEGRATION_MODE: false,
      WITHDRAWAL_NETWORK_CODE: 'TON',
      WITHDRAWAL_FAKE_CHAIN_ENABLED: false,
    });
    expect(config.deploymentEnvironment).toBe('PRODUCTION');
    expect(config.acceptedNetworkCode).toBe('TON');
    expect(config.fakeChainEnabled).toBe(false);
    expect(config.stagingIntegrationMode).toBe(false);
  });

  it('rejects Mainnet identities under explicit staging integration', () => {
    for (const networkCode of ['MAINNET', 'TON_MAINNET', 'USDT_MAINNET']) {
      expect(() =>
        withdrawalEngineConfigFromValidatedApi({
          ...base,
          DEPLOYMENT_ENV: 'staging',
          STAGING_INTEGRATION_MODE: true,
          WITHDRAWAL_NETWORK_CODE: networkCode,
          WITHDRAWAL_FAKE_CHAIN_ENABLED: false,
        }),
      ).toThrow(/MAINNET/);
    }
  });
});
