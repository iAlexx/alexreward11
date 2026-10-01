import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';

export interface WithdrawalRecordsResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly byState: Readonly<Record<string, number>>;
  readonly requiringLiveChainCount: number;
}

/**
 * Aggregate withdrawal states. Identifies which would need live Step 2B chain recon
 * without exposing recipient details or calling TON RPC.
 */
export async function summarizeWithdrawalRecords(pool: Pool): Promise<WithdrawalRecordsResult> {
  try {
    const states = await pool.query<{ state: string; count: string }>(
      `SELECT state::text AS state, COUNT(*)::text AS count
         FROM withdrawals
        GROUP BY state`,
    );
    const byState: Record<string, number> = {};
    for (const row of states.rows) {
      byState[row.state] = Number(row.count);
    }

    // Attempts that reached broadcast / ambiguous chain states need live Step 2B observation.
    const needingChain = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM withdrawal_attempts
        WHERE broadcast_submitted_at IS NOT NULL
           OR broadcast_ambiguity_class IS NOT NULL
           OR broadcast_result_state IN ('UNKNOWN', 'RECONCILE_REQUIRED', 'BROADCASTED', 'PENDING')`,
    );
    const requiringLiveChainCount = Number(needingChain.rows[0]?.count ?? 0);

    return {
      status: 'PASS',
      reasonCode: 'WITHDRAWAL_AGGREGATES_CAPTURED',
      byState,
      requiringLiveChainCount,
    };
  } catch {
    return {
      status: 'FAIL',
      reasonCode: 'WITHDRAWAL_AGGREGATE_QUERY_FAILED',
      byState: {},
      requiringLiveChainCount: 0,
    };
  }
}
