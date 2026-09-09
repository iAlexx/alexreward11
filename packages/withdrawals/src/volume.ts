import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';
import type { LimitRuleRow } from './rules.js';

export type VolumeScope =
  'USER_HOURLY' | 'USER_UTC_DAY' | 'HOT_WALLET_HOURLY' | 'HOT_WALLET_UTC_DAY';

function hourWindowUtc(asOf: Date): { start: Date; end: Date } {
  const start = new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(), asOf.getUTCHours()),
  );
  const end = new Date(start.getTime() + 3_600_000);
  return { start, end };
}

function utcDayWindow(asOf: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  return { start, end };
}

async function lockOrCreatePeriod(
  client: PoolClient,
  input: {
    readonly scope: VolumeScope;
    readonly assetId: string;
    readonly networkId: string;
    readonly userId?: string;
    readonly hotWalletId?: string;
    readonly periodStart: Date;
    readonly periodEnd: Date;
  },
): Promise<{ id: string; consumedAtomic: bigint }> {
  const existing = await client.query<{ id: string; consumed_atomic: string }>(
    `SELECT id, consumed_atomic::text
     FROM withdrawal_volume_periods
     WHERE scope = $1::withdrawal_volume_scope
       AND asset_id = $2::uuid
       AND network_id = $3::uuid
       AND period_start = $4::timestamptz
       AND (($5::uuid IS NULL AND user_id IS NULL) OR user_id = $5::uuid)
       AND (($6::uuid IS NULL AND hot_wallet_id IS NULL) OR hot_wallet_id = $6::uuid)
     FOR UPDATE`,
    [
      input.scope,
      input.assetId,
      input.networkId,
      input.periodStart.toISOString(),
      input.userId ?? null,
      input.hotWalletId ?? null,
    ],
  );
  if (existing.rows[0] !== undefined) {
    return {
      id: existing.rows[0].id,
      consumedAtomic: BigInt(existing.rows[0].consumed_atomic),
    };
  }
  await client.query('SAVEPOINT volume_period_insert');
  try {
    const inserted = await client.query<{ id: string; consumed_atomic: string }>(
      `INSERT INTO withdrawal_volume_periods (
         scope, asset_id, network_id, user_id, hot_wallet_id, period_start, period_end, consumed_atomic
       ) VALUES (
         $1::withdrawal_volume_scope, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::timestamptz, $7::timestamptz, 0
       )
       RETURNING id, consumed_atomic::text`,
      [
        input.scope,
        input.assetId,
        input.networkId,
        input.userId ?? null,
        input.hotWalletId ?? null,
        input.periodStart.toISOString(),
        input.periodEnd.toISOString(),
      ],
    );
    await client.query('RELEASE SAVEPOINT volume_period_insert');
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new WithdrawalDomainError('INTERNAL', 'volume period insert failed');
    }
    return { id: row.id, consumedAtomic: BigInt(row.consumed_atomic) };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT volume_period_insert');
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    ) {
      const retry = await client.query<{ id: string; consumed_atomic: string }>(
        `SELECT id, consumed_atomic::text
         FROM withdrawal_volume_periods
         WHERE scope = $1::withdrawal_volume_scope
           AND asset_id = $2::uuid
           AND network_id = $3::uuid
           AND period_start = $4::timestamptz
           AND (($5::uuid IS NULL AND user_id IS NULL) OR user_id = $5::uuid)
           AND (($6::uuid IS NULL AND hot_wallet_id IS NULL) OR hot_wallet_id = $6::uuid)
         FOR UPDATE`,
        [
          input.scope,
          input.assetId,
          input.networkId,
          input.periodStart.toISOString(),
          input.userId ?? null,
          input.hotWalletId ?? null,
        ],
      );
      const row = retry.rows[0];
      if (row === undefined) {
        throw new WithdrawalDomainError('INTERNAL', 'volume period race recovery failed');
      }
      return { id: row.id, consumedAtomic: BigInt(row.consumed_atomic) };
    }
    throw error;
  }
}

/**
 * Soft headroom check for quote creation (does not reserve).
 * Fail closed if any USER/HOT hour or UTC-day period lacks room for gross.
 */
export async function assertWithdrawalVolumeHeadroom(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly hotWalletId: string;
    readonly assetId: string;
    readonly networkId: string;
    readonly grossAtomic: bigint;
    readonly limits: LimitRuleRow;
    readonly asOf: Date;
  },
): Promise<void> {
  const hour = hourWindowUtc(input.asOf);
  const day = utcDayWindow(input.asOf);
  const checks: Array<{
    scope: VolumeScope;
    cap: bigint;
    userId?: string;
    hotWalletId?: string;
    window: { start: Date; end: Date };
  }> = [
    {
      scope: 'USER_HOURLY',
      cap: input.limits.maxUserHourlyAtomic,
      userId: input.userId,
      window: hour,
    },
    {
      scope: 'USER_UTC_DAY',
      cap: input.limits.maxUserDailyAtomic,
      userId: input.userId,
      window: day,
    },
    {
      scope: 'HOT_WALLET_HOURLY',
      cap: input.limits.maxHotWalletHourlyAtomic,
      hotWalletId: input.hotWalletId,
      window: hour,
    },
    {
      scope: 'HOT_WALLET_UTC_DAY',
      cap: input.limits.maxHotWalletDailyAtomic,
      hotWalletId: input.hotWalletId,
      window: day,
    },
  ];

  for (const p of checks) {
    const period = await lockOrCreatePeriod(client, {
      scope: p.scope,
      assetId: input.assetId,
      networkId: input.networkId,
      ...(p.userId !== undefined ? { userId: p.userId } : {}),
      ...(p.hotWalletId !== undefined ? { hotWalletId: p.hotWalletId } : {}),
      periodStart: p.window.start,
      periodEnd: p.window.end,
    });
    if (period.consumedAtomic + input.grossAtomic > p.cap) {
      throw new WithdrawalDomainError('LIMIT_EXCEEDED', 'Withdrawal volume limit exceeded', {
        details: { scope: p.scope, stage: 'quote' },
      });
    }
  }
}

/**
 * Atomically authorize gross volume against user + hot-wallet hourly/UTC-day caps.
 * Committed REQUESTED withdrawals permanently consume volume for the original period.
 */
export async function reserveWithdrawalVolume(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly userId: string;
    readonly hotWalletId: string;
    readonly assetId: string;
    readonly networkId: string;
    readonly grossAtomic: bigint;
    readonly limits: LimitRuleRow;
    readonly asOf: Date;
  },
): Promise<void> {
  const hour = hourWindowUtc(input.asOf);
  const day = utcDayWindow(input.asOf);

  const periods: Array<{
    scope: VolumeScope;
    cap: bigint;
    userId?: string;
    hotWalletId?: string;
    window: { start: Date; end: Date };
  }> = [
    {
      scope: 'USER_HOURLY',
      cap: input.limits.maxUserHourlyAtomic,
      userId: input.userId,
      window: hour,
    },
    {
      scope: 'USER_UTC_DAY',
      cap: input.limits.maxUserDailyAtomic,
      userId: input.userId,
      window: day,
    },
    {
      scope: 'HOT_WALLET_HOURLY',
      cap: input.limits.maxHotWalletHourlyAtomic,
      hotWalletId: input.hotWalletId,
      window: hour,
    },
    {
      scope: 'HOT_WALLET_UTC_DAY',
      cap: input.limits.maxHotWalletDailyAtomic,
      hotWalletId: input.hotWalletId,
      window: day,
    },
  ];

  for (const p of periods) {
    const period = await lockOrCreatePeriod(client, {
      scope: p.scope,
      assetId: input.assetId,
      networkId: input.networkId,
      ...(p.userId !== undefined ? { userId: p.userId } : {}),
      ...(p.hotWalletId !== undefined ? { hotWalletId: p.hotWalletId } : {}),
      periodStart: p.window.start,
      periodEnd: p.window.end,
    });
    if (period.consumedAtomic + input.grossAtomic > p.cap) {
      throw new WithdrawalDomainError('LIMIT_EXCEEDED', 'Withdrawal volume limit exceeded', {
        details: { scope: p.scope },
      });
    }
    await client.query(
      `UPDATE withdrawal_volume_periods
       SET consumed_atomic = consumed_atomic + $2::bigint, updated_at = now()
       WHERE id = $1::uuid`,
      [period.id, input.grossAtomic.toString(10)],
    );
    await client.query(
      `INSERT INTO withdrawal_volume_reservations (volume_period_id, withdrawal_id, amount_atomic)
       VALUES ($1::uuid, $2::uuid, $3::bigint)
       ON CONFLICT (volume_period_id, withdrawal_id) DO NOTHING`,
      [period.id, input.withdrawalId, input.grossAtomic.toString(10)],
    );
  }
}

/** Deterministic single eligible TEST-ONLY hot wallet for the network. */
export async function resolveSingleTestHotWallet(
  client: PoolClient,
  networkId: string,
): Promise<{ id: string; address: string }> {
  const result = await client.query<{ id: string; address: string }>(
    `SELECT id, address FROM hot_wallets
     WHERE network_id = $1::uuid
       AND status = 'ACTIVE'
       AND signer_reference LIKE 'TEST_ONLY_FAKE%'
     FOR SHARE`,
    [networkId],
  );
  if (result.rowCount === 0) {
    throw new WithdrawalDomainError('CONFIG', 'No eligible test Hot Wallet');
  }
  if ((result.rowCount ?? 0) > 1) {
    throw new WithdrawalDomainError('CONFIG', 'Ambiguous eligible test Hot Wallets');
  }
  return result.rows[0]!;
}
