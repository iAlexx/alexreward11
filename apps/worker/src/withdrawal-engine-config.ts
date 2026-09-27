import type { WorkerConfig } from '@alex-rewards/config';
import {
  withdrawalEngineConfigFromValidatedApi,
  type WithdrawalEngineConfig,
} from '@alex-rewards/withdrawals';

export function withdrawalEngineConfigFromWorker(config: WorkerConfig): WithdrawalEngineConfig {
  return withdrawalEngineConfigFromValidatedApi({
    DEPLOYMENT_ENV: config.DEPLOYMENT_ENV,
    WITHDRAWAL_QUOTE_TTL_SECONDS: config.WITHDRAWAL_QUOTE_TTL_SECONDS,
    WITHDRAWAL_RISK_POLICY_VERSION: config.WITHDRAWAL_RISK_POLICY_VERSION,
    WITHDRAWAL_NETWORK_CODE: config.WITHDRAWAL_NETWORK_CODE,
    WITHDRAWAL_ASSET_SYMBOL: config.WITHDRAWAL_ASSET_SYMBOL,
    WITHDRAWAL_FAKE_CHAIN_ENABLED: config.WITHDRAWAL_FAKE_CHAIN_ENABLED,
    STAGING_INTEGRATION_MODE: config.STAGING_INTEGRATION_MODE,
  });
}
