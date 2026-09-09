import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export async function assertWithdrawalRequestsAllowed(
  client: PoolClient,
  environment: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION',
): Promise<void> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags
     WHERE flag_key = 'WITHDRAWAL_REQUESTS_PAUSE'
       AND environment = $1::environment_name`,
    [environment],
  );
  if (result.rows[0]?.enabled === true) {
    throw new WithdrawalDomainError('PAUSED', 'Withdrawal requests are paused');
  }
}

export async function isPayoutDispatchPaused(
  client: PoolClient,
  environment: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION',
): Promise<boolean> {
  const result = await client.query<{ enabled: boolean }>(
    `SELECT enabled FROM feature_flags
     WHERE flag_key = 'PAYOUT_DISPATCH_PAUSE'
       AND environment = $1::environment_name`,
    [environment],
  );
  return result.rows[0]?.enabled === true;
}
