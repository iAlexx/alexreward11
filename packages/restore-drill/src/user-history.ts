import type { Pool } from 'pg';

import type { DrillSectionStatus } from './types.js';

export interface SelectedUserHistoryResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly userCountConfigured: number;
  readonly usersVerified: number;
  readonly aggregates: readonly {
    readonly userIdPresent: true;
    readonly ledgerAccountCount: number;
    readonly rewardEventCount: number;
    readonly withdrawalCount: number;
  }[];
}

/**
 * Optional Owner allowlist verification. No IDs => NOT_EXECUTED (not PASS).
 * Never exposes Telegram identity, wallet addresses, or tokens.
 */
export async function verifySelectedUserHistory(
  pool: Pool,
  userIds: readonly string[],
): Promise<SelectedUserHistoryResult> {
  if (userIds.length === 0) {
    return {
      status: 'NOT_EXECUTED',
      reasonCode: 'NO_USER_ALLOWLIST',
      userCountConfigured: 0,
      usersVerified: 0,
      aggregates: [],
    };
  }

  const aggregates: SelectedUserHistoryResult['aggregates'][number][] = [];
  for (const userId of userIds) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      continue;
    }
    const accounts = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ledger_accounts
        WHERE owner_type = 'USER' AND owner_id = $1::uuid`,
      [userId],
    );
    const rewards = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reward_events WHERE user_id = $1::uuid`,
      [userId],
    );
    const withdrawals = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM withdrawals WHERE user_id = $1::uuid`,
      [userId],
    );
    aggregates.push({
      userIdPresent: true,
      ledgerAccountCount: Number(accounts.rows[0]?.count ?? 0),
      rewardEventCount: Number(rewards.rows[0]?.count ?? 0),
      withdrawalCount: Number(withdrawals.rows[0]?.count ?? 0),
    });
  }

  return {
    status: 'PASS',
    reasonCode: 'USER_HISTORY_AGGREGATES_CAPTURED',
    userCountConfigured: userIds.length,
    usersVerified: aggregates.length,
    aggregates,
  };
}
