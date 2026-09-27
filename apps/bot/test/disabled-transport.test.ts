import { describe, expect, it } from 'vitest';

import { loadBotConfig } from '@alex-rewards/config';
import { withdrawalEngineConfigFromValidatedApi } from '@alex-rewards/withdrawals';

import { shouldStartTelegramControlCenter } from '../src/telegram-control-center-gate.js';

describe('disabled bot transport', () => {
  it('does not start Telegram polling or Owner-review delivery', () => {
    expect(shouldStartTelegramControlCenter('disabled', undefined)).toBe(false);
    expect(
      shouldStartTelegramControlCenter('disabled', 'staging-grade-telegram-bot-token-value'),
    ).toBe(false);
    expect(shouldStartTelegramControlCenter('polling', undefined)).toBe(false);
  });

  it('constructs a staging smoke config without a payout path or Telegram startup', () => {
    const config = loadBotConfig({
      DEPLOYMENT_ENV: 'staging',
      NODE_ENV: 'production',
      STAGING_INTEGRATION_MODE: 'true',
      BOT_TRANSPORT_MODE: 'disabled',
      CONTROL_CENTER_ACTION_TOKEN_TTL_SECONDS: '900',
      CONTROL_CENTER_CONFIRM_TOKEN_TTL_SECONDS: '300',
      CONTROL_CENTER_RATE_LIMIT_WINDOW_SECONDS: '60',
      CONTROL_CENTER_RATE_LIMIT_MAX: '30',
      WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
      WITHDRAWAL_RISK_POLICY_VERSION: '1',
      WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
      WITHDRAWAL_ASSET_SYMBOL: 'USDT',
      WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
    });
    expect(
      shouldStartTelegramControlCenter(config.BOT_TRANSPORT_MODE, config.TELEGRAM_BOT_TOKEN),
    ).toBe(false);
    expect(config.DATABASE_URL).toBeUndefined();
    const engine = withdrawalEngineConfigFromValidatedApi({
      DEPLOYMENT_ENV: config.DEPLOYMENT_ENV,
      WITHDRAWAL_QUOTE_TTL_SECONDS: config.WITHDRAWAL_QUOTE_TTL_SECONDS,
      WITHDRAWAL_RISK_POLICY_VERSION: config.WITHDRAWAL_RISK_POLICY_VERSION,
      WITHDRAWAL_NETWORK_CODE: config.WITHDRAWAL_NETWORK_CODE,
      WITHDRAWAL_ASSET_SYMBOL: config.WITHDRAWAL_ASSET_SYMBOL,
      WITHDRAWAL_FAKE_CHAIN_ENABLED: config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
      STAGING_INTEGRATION_MODE: config.STAGING_INTEGRATION_MODE,
    });
    expect(engine.fakeChainEnabled).toBe(false);
    expect(engine.acceptedNetworkCode).toBe('TON_TESTNET');
    expect(engine.stagingIntegrationMode).toBe(true);
    expect(engine.deploymentEnvironment).toBe('STAGING');
  });
});
