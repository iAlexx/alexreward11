import { describe, expect, it } from 'vitest';

import { loadWorkerConfig } from '@alex-rewards/config';

import { withdrawalEngineConfigFromWorker } from '../src/withdrawal-engine-config.js';

describe('worker staging integration withdrawal engine config', () => {
  it('constructs TON_TESTNET config without enabling a payout path', () => {
    const worker = loadWorkerConfig({
      DEPLOYMENT_ENV: 'staging',
      NODE_ENV: 'production',
      STAGING_INTEGRATION_MODE: 'true',
      DATABASE_URL: 'postgresql://user:pass@db.example.com:5432/db',
      REDIS_URL: 'rediss://redis.example.com:6379',
      TEMPORAL_ADDRESS: 'temporal.example.com:7233',
      TEMPORAL_TASK_QUEUE: 'alex-rewards-foundation',
      WITHDRAWAL_QUOTE_TTL_SECONDS: '300',
      WITHDRAWAL_RISK_POLICY_VERSION: '1',
      WITHDRAWAL_NETWORK_CODE: 'TON_TESTNET',
      WITHDRAWAL_ASSET_SYMBOL: 'USDT',
      WITHDRAWAL_FAKE_CHAIN_ENABLED: 'false',
      WITHDRAWAL_REAL_CHAIN_ENABLED: 'false',
      SIGNER_BASE_URL: 'https://signer.example.com',
    });

    const engine = withdrawalEngineConfigFromWorker(worker);

    expect(worker.WORKER_OUTBOX_RELAY_ENABLED).toBe(false);
    expect(worker.WITHDRAWAL_REAL_CHAIN_ENABLED).toBe(false);
    expect(worker.WITHDRAWAL_FAKE_CHAIN_ENABLED).toBe(false);
    expect(engine.deploymentEnvironment).toBe('STAGING');
    expect(engine.stagingIntegrationMode).toBe(true);
    expect(engine.acceptedNetworkCode).toBe('TON_TESTNET');
    expect(engine.fakeChainEnabled).toBe(false);
  });
});
