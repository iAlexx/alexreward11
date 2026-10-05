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
  const row = result.rows[0];
  if (row === undefined) {
    // Missing kill-switch fails closed for production-like environments.
    // LOCAL/DEV remain compatible with existing fixtures (missing => allow).
    if (environment === 'STAGING' || environment === 'PRODUCTION') {
      throw new WithdrawalDomainError('PAUSED', 'Withdrawal requests are paused', {
        details: { reason: 'PAUSE_FLAG_MISSING', flagKey: 'WITHDRAWAL_REQUESTS_PAUSE', environment },
      });
    }
    return;
  }
  if (row.enabled === true) {
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
  const row = result.rows[0];
  if (row === undefined) {
    // P19-SEC-016: missing kill-switch fails closed for production-like environments.
    // LOCAL/DEV remain compatible with existing fixtures (missing => not paused).
    if (environment === 'STAGING' || environment === 'PRODUCTION') {
      return true;
    }
    return false;
  }
  return row.enabled === true;
}
