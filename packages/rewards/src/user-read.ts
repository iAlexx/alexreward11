import type { PoolClient } from 'pg';

import { withLedgerTransaction, type LedgerDb } from './db.js';

export interface ReadUserLifetimeEarnedInput {
  readonly userId: string;
  readonly assetId: string;
}

export interface UserLifetimeEarned {
  readonly userId: string;
  readonly assetId: string;
  /** Atomic decimal string. Sum of matured, non-reversed reward events. */
  readonly amountAtomic: string;
  readonly rewardEventCount: number;
}

/**
 * Lifetime earned for one asset: the sum of reward events that actually matured.
 *
 * Read-only history, never a spendable balance. CREATED/PENDING rewards are excluded
 * because they have not matured, and REVERSED rewards are excluded because they were
 * taken back — so this figure can only ever reflect postings the Reward Engine made.
 */
export async function readUserLifetimeEarned(
  db: LedgerDb,
  input: ReadUserLifetimeEarnedInput,
): Promise<UserLifetimeEarned> {
  return withLedgerTransaction(db, (client) => readOnClient(client, input));
}

async function readOnClient(
  client: PoolClient,
  input: ReadUserLifetimeEarnedInput,
): Promise<UserLifetimeEarned> {
  const result = await client.query<{ amount_atomic: string; reward_event_count: number }>(
    `SELECT COALESCE(sum(amount_atomic), 0)::text AS amount_atomic,
            count(*)::int AS reward_event_count
     FROM reward_events
     WHERE user_id = $1::uuid
       AND asset_id = $2::uuid
       AND state = 'AVAILABLE'`,
    [input.userId, input.assetId],
  );
  const row = result.rows[0];
  return {
    userId: input.userId,
    assetId: input.assetId,
    amountAtomic: row?.amount_atomic ?? '0',
    rewardEventCount: row?.reward_event_count ?? 0,
  };
}
