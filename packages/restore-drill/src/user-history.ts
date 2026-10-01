import type { Pool } from 'pg';

import type { DrillSectionStatus, SelectedUserHistoryEvidence } from './types.js';

export interface SelectedUserHistoryResult {
  readonly status: DrillSectionStatus;
  readonly reasonCode: string;
  readonly userCountConfigured: number;
  readonly usersVerified: number;
  readonly users: readonly SelectedUserHistoryEvidence[];
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Optional Owner allowlist verification. No IDs => NOT_EXECUTED (not PASS).
 * Never exposes Telegram identity, wallet addresses, or tokens.
 * userReference is the internal UUID (Owner-supplied allowlist value).
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
      users: [],
    };
  }

  for (const userId of userIds) {
    if (!UUID_RE.test(userId)) {
      return {
        status: 'FAIL',
        reasonCode: 'INVALID_USER_ID',
        userCountConfigured: userIds.length,
        usersVerified: 0,
        users: [],
      };
    }
  }

  const users: SelectedUserHistoryEvidence[] = [];
  for (const userId of userIds) {
    const exists = await pool.query<{ present: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1::uuid) AS present`,
      [userId],
    );
    if (exists.rows[0]?.present !== true) {
      return {
        status: 'FAIL',
        reasonCode: 'SELECTED_USER_MISSING',
        userCountConfigured: userIds.length,
        usersVerified: users.length,
        users,
      };
    }

    const accounts = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ledger_accounts
        WHERE owner_type = 'USER' AND owner_id = $1::uuid`,
      [userId],
    );
    const projections = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM ledger_account_balances b
         INNER JOIN ledger_accounts a ON a.id = b.ledger_account_id
        WHERE a.owner_type = 'USER' AND a.owner_id = $1::uuid`,
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
    const byStateRows = await pool.query<{ state: string; count: string }>(
      `SELECT state::text AS state, COUNT(*)::text AS count
         FROM withdrawals
        WHERE user_id = $1::uuid
        GROUP BY state`,
      [userId],
    );
    const withdrawalsByState: Record<string, number> = {};
    for (const row of byStateRows.rows) {
      withdrawalsByState[row.state] = Number(row.count);
    }

    users.push({
      userReference: userId.toLowerCase(),
      userIdPresent: true,
      ledgerAccountCount: Number(accounts.rows[0]?.count ?? 0),
      ledgerProjectionRowCount: Number(projections.rows[0]?.count ?? 0),
      rewardEventCount: Number(rewards.rows[0]?.count ?? 0),
      withdrawalCount: Number(withdrawals.rows[0]?.count ?? 0),
      withdrawalsByState,
    });
  }

  return {
    status: 'PASS',
    reasonCode: 'USER_HISTORY_AGGREGATES_CAPTURED',
    userCountConfigured: userIds.length,
    usersVerified: users.length,
    users,
  };
}
