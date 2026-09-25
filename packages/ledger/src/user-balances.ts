import type { PoolClient } from 'pg';

import { withLedgerTransaction, type LedgerDb } from './db.js';
import { LedgerDomainError } from './errors.js';

/** The three protected user buckets, in the order the Mini App presents them. */
export const USER_BALANCE_BUCKET_TYPES = [
  'USER_AVAILABLE_LIABILITY',
  'USER_PENDING_LIABILITY',
  'USER_RESERVED_LIABILITY',
] as const;

export type UserBalanceBucketType = (typeof USER_BALANCE_BUCKET_TYPES)[number];

export interface UserLedgerBalanceBucket {
  readonly accountType: UserBalanceBucketType;
  /** Null when the user has never had a posting into this bucket. */
  readonly accountId: string | null;
  /** Signed atomic projection as a decimal string. `'0'` when no account exists yet. */
  readonly amountAtomic: string;
  readonly accountExists: boolean;
}

export interface UserLedgerBalances {
  readonly userId: string;
  readonly assetId: string;
  readonly assetSymbol: string;
  readonly assetDecimals: number;
  readonly networkCode: string;
  readonly asOf: string;
  readonly buckets: Readonly<Record<UserBalanceBucketType, UserLedgerBalanceBucket>>;
}

export interface ReadUserLedgerBalancesInput {
  readonly userId: string;
  /** Deployment-configured payout network, e.g. `TON_TESTNET`. Never client-selected. */
  readonly networkCode: string;
  readonly assetSymbol: string;
  readonly asOf?: Date;
}

interface BucketRow {
  account_id: string;
  account_type: UserBalanceBucketType;
  amount_atomic: string | null;
}

/**
 * Read the authoritative user balance buckets for one asset.
 *
 * Strictly read-only: it never provisions an account, because asking for a balance is not
 * a financial event. A bucket with no ledger account is reported as an authoritative zero —
 * the ledger has genuinely never credited it — and a stored projection is echoed exactly as
 * posted. Nothing here can produce a non-zero amount that the ledger did not post.
 */
export async function readUserLedgerBalances(
  db: LedgerDb,
  input: ReadUserLedgerBalancesInput,
): Promise<UserLedgerBalances> {
  return withLedgerTransaction(db, (client) => readOnClient(client, input));
}

async function readOnClient(
  client: PoolClient,
  input: ReadUserLedgerBalancesInput,
): Promise<UserLedgerBalances> {
  const asOf = input.asOf ?? new Date();

  const asset = await client.query<{ id: string; symbol: string; decimals: number }>(
    `SELECT a.id, a.symbol, a.decimals::int AS decimals
     FROM assets a
     JOIN networks n ON n.id = a.network_id
     WHERE n.code = $1 AND a.symbol = $2 AND a.status = 'ACTIVE'`,
    [input.networkCode, input.assetSymbol],
  );
  if (asset.rowCount === 0) {
    throw new LedgerDomainError('VALIDATION', 'Balance asset is not configured', {
      details: { networkCode: input.networkCode, assetSymbol: input.assetSymbol },
    });
  }
  if ((asset.rowCount ?? 0) > 1) {
    throw new LedgerDomainError('VALIDATION', 'Balance asset is ambiguous', {
      details: { networkCode: input.networkCode, assetSymbol: input.assetSymbol },
    });
  }
  const assetRow = asset.rows[0];
  if (assetRow === undefined) {
    throw new LedgerDomainError('INTERNAL', 'Balance asset lookup returned no row');
  }

  const accounts = await client.query<BucketRow>(
    `SELECT la.id AS account_id,
            la.account_type::text AS account_type,
            bal.balance_atomic::text AS amount_atomic
     FROM ledger_accounts la
     LEFT JOIN ledger_account_balances bal ON bal.ledger_account_id = la.id
     WHERE la.owner_type = 'USER'
       AND la.owner_id = $1::uuid
       AND la.asset_id = $2::uuid
       AND la.account_type = ANY ($3::ledger_account_type[])`,
    [input.userId, assetRow.id, [...USER_BALANCE_BUCKET_TYPES]],
  );

  const byType = new Map<UserBalanceBucketType, BucketRow>();
  for (const row of accounts.rows) {
    byType.set(row.account_type, row);
  }

  const buckets = Object.fromEntries(
    USER_BALANCE_BUCKET_TYPES.map((accountType) => {
      const row = byType.get(accountType);
      const bucket: UserLedgerBalanceBucket = {
        accountType,
        accountId: row?.account_id ?? null,
        // A provisioned account with no projection row has had no posting: still zero.
        amountAtomic: row?.amount_atomic ?? '0',
        accountExists: row !== undefined,
      };
      return [accountType, bucket];
    }),
  ) as Record<UserBalanceBucketType, UserLedgerBalanceBucket>;

  return {
    userId: input.userId,
    assetId: assetRow.id,
    assetSymbol: assetRow.symbol,
    assetDecimals: assetRow.decimals,
    networkCode: input.networkCode,
    asOf: asOf.toISOString(),
    buckets,
  };
}
