import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';

export interface PayoutPauseValidation {
  readonly status: DrillSectionStatus;
  readonly flagKey: 'PAYOUT_DISPATCH_PAUSE';
  readonly environment: string;
  readonly payoutDispatchPausedAtValidation: boolean | null;
  readonly autoUnpause: false;
  readonly reasonCode: string;
}

/**
 * Read-only verification. NEVER creates or flips PAYOUT_DISPATCH_PAUSE.
 */
export async function verifyPayoutDispatchPaused(
  pool: Pool,
  environment: string,
): Promise<PayoutPauseValidation> {
  try {
    const result = await pool.query<{ enabled: boolean }>(
      `SELECT enabled
         FROM feature_flags
        WHERE environment = $1::environment_name
          AND flag_key = 'PAYOUT_DISPATCH_PAUSE'
        LIMIT 1`,
      [environment],
    );
    if (result.rowCount === 0) {
      return {
        status: 'FAIL',
        flagKey: 'PAYOUT_DISPATCH_PAUSE',
        environment,
        payoutDispatchPausedAtValidation: null,
        autoUnpause: false,
        reasonCode: 'FLAG_MISSING',
      };
    }
    const enabled = Boolean(result.rows[0]?.enabled);
    if (!enabled) {
      return {
        status: 'FAIL',
        flagKey: 'PAYOUT_DISPATCH_PAUSE',
        environment,
        payoutDispatchPausedAtValidation: false,
        autoUnpause: false,
        reasonCode: 'FLAG_NOT_PAUSED',
      };
    }
    return {
      status: 'PASS',
      flagKey: 'PAYOUT_DISPATCH_PAUSE',
      environment,
      payoutDispatchPausedAtValidation: true,
      autoUnpause: false,
      reasonCode: 'PAUSED',
    };
  } catch {
    return {
      status: 'FAIL',
      flagKey: 'PAYOUT_DISPATCH_PAUSE',
      environment,
      payoutDispatchPausedAtValidation: null,
      autoUnpause: false,
      reasonCode: 'FLAG_QUERY_FAILED',
    };
  }
}
