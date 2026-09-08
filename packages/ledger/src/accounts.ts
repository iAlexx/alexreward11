import type { PoolClient } from 'pg';

import { resolveProvisionableSemantics } from './catalogue.js';
import { LedgerDomainError } from './errors.js';
import type { LedgerAccountRecord, LedgerAccountType, LedgerOwnerType } from './types.js';

function mapAccount(row: {
  id: string;
  owner_type: LedgerOwnerType;
  owner_id: string | null;
  account_type: LedgerAccountType;
  account_class: LedgerAccountRecord['accountClass'];
  normal_side: LedgerAccountRecord['normalSide'];
  asset_id: string;
  status: string;
}): LedgerAccountRecord {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    accountType: row.account_type,
    accountClass: row.account_class,
    normalSide: row.normal_side,
    assetId: row.asset_id,
    status: row.status,
  };
}

async function ensureBalanceRow(client: PoolClient, accountId: string): Promise<void> {
  await client.query(
    `INSERT INTO ledger_account_balances (ledger_account_id, balance_atomic, version)
     VALUES ($1, 0, 0)
     ON CONFLICT (ledger_account_id) DO NOTHING`,
    [accountId],
  );
}

/**
 * Race-safe get-or-create for a catalogue account + zero projection row.
 * Callers must not invent class/side/owner_type — catalogue is authoritative.
 */
export async function getOrCreateLedgerAccount(
  client: PoolClient,
  input: {
    readonly accountType: LedgerAccountType;
    readonly assetId: string;
    readonly ownerId?: string | null;
    readonly acknowledgeUnresolvedAccounting?: boolean;
  },
): Promise<LedgerAccountRecord> {
  const semantics = resolveProvisionableSemantics(
    input.accountType,
    input.acknowledgeUnresolvedAccounting === undefined
      ? undefined
      : { acknowledgeUnresolvedAccounting: input.acknowledgeUnresolvedAccounting },
  );

  const ownerId = semantics.requiresOwnerId ? (input.ownerId ?? null) : null;
  if (semantics.requiresOwnerId && (ownerId === null || ownerId === '')) {
    throw new LedgerDomainError('VALIDATION', 'ownerId is required for this account type', {
      details: { accountType: input.accountType },
    });
  }
  if (!semantics.requiresOwnerId && input.ownerId !== undefined && input.ownerId !== null) {
    throw new LedgerDomainError('VALIDATION', 'ownerId must be null for PLATFORM accounts', {
      details: { accountType: input.accountType },
    });
  }

  const inserted = await client.query<{
    id: string;
    owner_type: LedgerOwnerType;
    owner_id: string | null;
    account_type: LedgerAccountType;
    account_class: LedgerAccountRecord['accountClass'];
    normal_side: LedgerAccountRecord['normalSide'];
    asset_id: string;
    status: string;
  }>(
    `INSERT INTO ledger_accounts (
       owner_type, owner_id, account_type, account_class, normal_side, asset_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT ON CONSTRAINT ledger_accounts_identity_key DO UPDATE
       SET status = ledger_accounts.status
     RETURNING id, owner_type, owner_id, account_type, account_class, normal_side, asset_id, status`,
    [
      semantics.ownerType,
      ownerId,
      semantics.accountType,
      semantics.accountClass,
      semantics.normalSide,
      input.assetId,
    ],
  );

  const row = inserted.rows[0];
  if (row === undefined) {
    throw new LedgerDomainError('INTERNAL', 'Failed to provision ledger account');
  }
  if (
    row.account_class !== semantics.accountClass ||
    row.normal_side !== semantics.normalSide ||
    row.owner_type !== semantics.ownerType
  ) {
    throw new LedgerDomainError(
      'VALIDATION',
      'Existing account identity conflicts with catalogue semantics',
      { details: { accountType: input.accountType, accountId: row.id } },
    );
  }

  await ensureBalanceRow(client, row.id);
  return mapAccount(row);
}

export async function getLedgerAccountById(
  client: PoolClient,
  accountId: string,
): Promise<LedgerAccountRecord> {
  const result = await client.query<{
    id: string;
    owner_type: LedgerOwnerType;
    owner_id: string | null;
    account_type: LedgerAccountType;
    account_class: LedgerAccountRecord['accountClass'];
    normal_side: LedgerAccountRecord['normalSide'];
    asset_id: string;
    status: string;
  }>(
    `SELECT id, owner_type, owner_id, account_type, account_class, normal_side, asset_id, status
     FROM ledger_accounts WHERE id = $1`,
    [accountId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new LedgerDomainError('ACCOUNT_NOT_FOUND', 'Ledger account not found', {
      details: { accountId },
    });
  }
  return mapAccount(row);
}
