import type { PoolClient } from 'pg';

import { getLedgerAccountById, getOrCreateLedgerAccount } from './accounts.js';
import { amountAtomicToString, parsePositiveAtomicAmount } from './amounts.js';
import { assertAssetActive } from './assets.js';
import { isProtectedUserBucket, normalSideDelta } from './catalogue.js';
import { isUniqueViolation, type LedgerDb, withLedgerTransaction } from './db.js';
import { LedgerDomainError } from './errors.js';
import { intentsMatch, ledgerIntentFingerprint, type LedgerIntent } from './intent.js';
import { assertExactReversalOfOriginal } from './reversal-guard.js';
import type {
  CanonicalLedgerEntry,
  LedgerAccountRecord,
  LedgerAccountType,
  LedgerOwnerType,
  LedgerSide,
  PostLedgerCommand,
  PostLedgerCommandWithReversalLink,
  PostedLedgerEntry,
  PostedLedgerTransaction,
} from './types.js';

/** Internal command shape; reversesTransactionId only via guarded path. */
type InternalPostCommand = PostLedgerCommand & {
  readonly reversesTransactionId?: string | null;
};

interface BalanceLockRow {
  ledger_account_id: string;
  balance_atomic: string;
  version: string;
}

async function loadPostedTransaction(
  client: PoolClient,
  transactionId: string,
  created: boolean,
): Promise<PostedLedgerTransaction> {
  const header = await client.query<{
    id: string;
    transaction_type: PostedLedgerTransaction['transactionType'];
    business_reference_type: string;
    business_reference_id: string | null;
    idempotency_scope: string;
    idempotency_key: string;
    asset_id: string;
    reverses_transaction_id: string | null;
    posted_at: Date;
  }>(
    `SELECT id, transaction_type, business_reference_type, business_reference_id,
            idempotency_scope, idempotency_key, asset_id, reverses_transaction_id, posted_at
     FROM ledger_transactions WHERE id = $1`,
    [transactionId],
  );
  const row = header.rows[0];
  if (row === undefined) {
    throw new LedgerDomainError('TRANSACTION_NOT_FOUND', 'Ledger transaction not found', {
      details: { transactionId },
    });
  }
  const entries = await client.query<{
    id: string;
    ledger_account_id: string;
    direction: LedgerSide;
    amount_atomic: string;
    entry_index: number;
  }>(
    `SELECT id, ledger_account_id, direction, amount_atomic::text AS amount_atomic, entry_index
     FROM ledger_entries
     WHERE ledger_transaction_id = $1
     ORDER BY entry_index ASC`,
    [transactionId],
  );
  return {
    id: row.id,
    transactionType: row.transaction_type,
    businessReferenceType: row.business_reference_type,
    businessReferenceId: row.business_reference_id,
    idempotencyScope: row.idempotency_scope,
    idempotencyKey: row.idempotency_key,
    assetId: row.asset_id,
    reversesTransactionId: row.reverses_transaction_id,
    postedAt: row.posted_at.toISOString(),
    created,
    entries: entries.rows.map((entry): PostedLedgerEntry => ({
      id: entry.id,
      ledgerAccountId: entry.ledger_account_id,
      direction: entry.direction,
      amountAtomic: entry.amount_atomic,
      entryIndex: entry.entry_index,
    })),
  };
}

async function loadIntentFromPosted(
  client: PoolClient,
  transactionId: string,
): Promise<LedgerIntent> {
  const posted = await loadPostedTransaction(client, transactionId, false);
  return {
    transactionType: posted.transactionType,
    businessReferenceType: posted.businessReferenceType,
    businessReferenceId: posted.businessReferenceId,
    assetId: posted.assetId,
    reversesTransactionId: posted.reversesTransactionId,
    entries: posted.entries.map((entry, index) => ({
      ledgerAccountId: entry.ledgerAccountId,
      direction: entry.direction,
      amountAtomic: BigInt(entry.amountAtomic),
      entryIndex: entry.entryIndex ?? index,
    })),
  };
}

async function resolveEntryAccounts(
  client: PoolClient,
  command: InternalPostCommand,
): Promise<{ accountsById: Map<string, LedgerAccountRecord>; canonical: CanonicalLedgerEntry[] }> {
  if (command.entries.length < 2) {
    throw new LedgerDomainError('VALIDATION', 'At least two ledger entries are required');
  }

  const accountsById = new Map<string, LedgerAccountRecord>();
  const canonical: CanonicalLedgerEntry[] = [];

  for (let index = 0; index < command.entries.length; index += 1) {
    const entry = command.entries[index];
    if (entry === undefined) continue;
    if (entry.direction !== 'DEBIT' && entry.direction !== 'CREDIT') {
      throw new LedgerDomainError('VALIDATION', 'Entry direction must be DEBIT or CREDIT');
    }

    let account: LedgerAccountRecord;
    if (entry.ledgerAccountId !== undefined && entry.ledgerAccountId !== '') {
      account = await getLedgerAccountById(client, entry.ledgerAccountId);
    } else if (entry.accountType !== undefined) {
      account = await getOrCreateLedgerAccount(client, {
        accountType: entry.accountType,
        assetId: command.assetId,
        ownerId: entry.ownerId ?? null,
      });
      if (entry.ownerType !== undefined && entry.ownerType !== account.ownerType) {
        throw new LedgerDomainError('VALIDATION', 'ownerType does not match catalogue', {
          details: { accountType: entry.accountType },
        });
      }
    } else {
      throw new LedgerDomainError(
        'VALIDATION',
        'Each entry requires ledgerAccountId or accountType',
      );
    }

    if (account.assetId !== command.assetId) {
      throw new LedgerDomainError(
        'ACCOUNT_ASSET_MISMATCH',
        'Entry account asset does not match transaction asset',
        { details: { accountId: account.id, assetId: command.assetId } },
      );
    }
    if (account.status !== 'ACTIVE') {
      throw new LedgerDomainError('VALIDATION', 'Ledger account is not ACTIVE', {
        details: { accountId: account.id },
      });
    }

    accountsById.set(account.id, account);
    canonical.push({
      ledgerAccountId: account.id,
      direction: entry.direction,
      amountAtomic: parsePositiveAtomicAmount(entry.amountAtomic),
      entryIndex: index,
    });
  }

  return { accountsById, canonical };
}

function assertBalanced(entries: ReadonlyArray<CanonicalLedgerEntry>): {
  debitTotal: bigint;
  creditTotal: bigint;
} {
  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const entry of entries) {
    if (entry.direction === 'DEBIT') debitTotal += entry.amountAtomic;
    else creditTotal += entry.amountAtomic;
  }
  if (debitTotal !== creditTotal) {
    throw new LedgerDomainError('UNBALANCED', 'Debit total must equal credit total', {
      details: {
        debitTotal: amountAtomicToString(debitTotal),
        creditTotal: amountAtomicToString(creditTotal),
      },
    });
  }
  if (debitTotal === 0n) {
    throw new LedgerDomainError('VALIDATION', 'Transaction total must be greater than zero');
  }
  return { debitTotal, creditTotal };
}

async function lockBalancesDeterministically(
  client: PoolClient,
  accountIds: ReadonlyArray<string>,
): Promise<Map<string, BalanceLockRow>> {
  const unique = [...new Set(accountIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const locked = new Map<string, BalanceLockRow>();
  for (const accountId of unique) {
    await client.query(
      `INSERT INTO ledger_account_balances (ledger_account_id, balance_atomic, version)
       VALUES ($1, 0, 0)
       ON CONFLICT (ledger_account_id) DO NOTHING`,
      [accountId],
    );
    const row = await client.query<BalanceLockRow>(
      `SELECT ledger_account_id, balance_atomic::text AS balance_atomic, version::text AS version
       FROM ledger_account_balances
       WHERE ledger_account_id = $1
       FOR UPDATE`,
      [accountId],
    );
    const balance = row.rows[0];
    if (balance === undefined) {
      throw new LedgerDomainError('INTERNAL', 'Missing balance projection row', {
        details: { accountId },
      });
    }
    locked.set(accountId, balance);
  }
  return locked;
}

async function recoverByIdempotency(
  client: PoolClient,
  command: InternalPostCommand,
  intent: LedgerIntent,
): Promise<PostedLedgerTransaction> {
  const existing = await client.query<{ id: string; metadata: { intentFingerprint?: string } }>(
    `SELECT id, metadata FROM ledger_transactions
     WHERE idempotency_scope = $1 AND idempotency_key = $2`,
    [command.idempotencyScope, command.idempotencyKey],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new LedgerDomainError('INTERNAL', 'Idempotency conflict without existing row');
  }
  const priorIntent = await loadIntentFromPosted(client, row.id);
  if (!intentsMatch(priorIntent, intent)) {
    throw new LedgerDomainError(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key reused with different financial intent',
      {
        details: {
          existingTransactionId: row.id,
          expectedFingerprint: ledgerIntentFingerprint(intent),
          actualFingerprint: ledgerIntentFingerprint(priorIntent),
        },
      },
    );
  }
  return loadPostedTransaction(client, row.id, false);
}

async function recoverByBusinessReference(
  client: PoolClient,
  command: InternalPostCommand,
  intent: LedgerIntent,
): Promise<PostedLedgerTransaction> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ledger_transactions
     WHERE transaction_type = $1
       AND business_reference_type = $2
       AND business_reference_id IS NOT DISTINCT FROM $3::uuid`,
    [command.transactionType, command.businessReferenceType, command.businessReferenceId ?? null],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new LedgerDomainError('INTERNAL', 'Business reference conflict without existing row');
  }
  const priorIntent = await loadIntentFromPosted(client, row.id);
  if (!intentsMatch(priorIntent, intent)) {
    throw new LedgerDomainError(
      'BUSINESS_REFERENCE_CONFLICT',
      'Business reference reused with different financial intent',
      { details: { existingTransactionId: row.id } },
    );
  }
  return loadPostedTransaction(client, row.id, false);
}

async function postInsideClient(
  client: PoolClient,
  command: InternalPostCommand,
): Promise<PostedLedgerTransaction> {
  if (!command.idempotencyScope?.trim() || !command.idempotencyKey?.trim()) {
    throw new LedgerDomainError('VALIDATION', 'idempotencyScope and idempotencyKey are required');
  }
  if (!command.businessReferenceType?.trim()) {
    throw new LedgerDomainError('VALIDATION', 'businessReferenceType is required');
  }
  await assertAssetActive(client, command.assetId);

  const { accountsById, canonical } = await resolveEntryAccounts(client, command);
  assertBalanced(canonical);

  // Exact reversal semantics MUST pass before any ledger_transaction insert.
  if (command.reversesTransactionId) {
    await assertExactReversalOfOriginal(
      client,
      command.reversesTransactionId,
      command.assetId,
      canonical,
    );
  }

  const intent: LedgerIntent = {
    transactionType: command.transactionType,
    businessReferenceType: command.businessReferenceType,
    businessReferenceId: command.businessReferenceId ?? null,
    assetId: command.assetId,
    reversesTransactionId: command.reversesTransactionId ?? null,
    entries: canonical,
  };
  const fingerprint = ledgerIntentFingerprint(intent);

  // Fast-path recover before insert when row already exists (exact retry).
  const priorIdem = await client.query<{ id: string }>(
    `SELECT id FROM ledger_transactions
     WHERE idempotency_scope = $1 AND idempotency_key = $2`,
    [command.idempotencyScope, command.idempotencyKey],
  );
  if (priorIdem.rows[0]) {
    return recoverByIdempotency(client, command, intent);
  }

  const accountIds = canonical.map((entry) => entry.ledgerAccountId);
  const locked = await lockBalancesDeterministically(client, accountIds);

  const nextBalances = new Map<string, bigint>();
  for (const [accountId, row] of locked) {
    nextBalances.set(accountId, BigInt(row.balance_atomic));
  }
  for (const entry of canonical) {
    const account = accountsById.get(entry.ledgerAccountId);
    if (account === undefined) {
      throw new LedgerDomainError('INTERNAL', 'Account missing during projection update');
    }
    const current = nextBalances.get(entry.ledgerAccountId) ?? 0n;
    const delta = normalSideDelta(account.normalSide, entry.direction, entry.amountAtomic);
    nextBalances.set(entry.ledgerAccountId, current + delta);
  }

  for (const [accountId, next] of nextBalances) {
    const account = accountsById.get(accountId);
    if (account !== undefined && isProtectedUserBucket(account.accountType) && next < 0n) {
      throw new LedgerDomainError(
        'NEGATIVE_PROTECTED_BALANCE',
        'Protected user bucket cannot become negative',
        {
          details: {
            accountId,
            accountType: account.accountType,
            resultingBalance: amountAtomicToString(next),
          },
        },
      );
    }
  }

  const metadata = {
    ...(command.metadata ?? {}),
    intentFingerprint: fingerprint,
  };

  let transactionId: string;
  try {
    await client.query('SAVEPOINT ledger_post_insert');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (
         transaction_type, business_reference_type, business_reference_id,
         idempotency_scope, idempotency_key, asset_id, reverses_transaction_id,
         metadata, created_by_type, created_by_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       RETURNING id`,
      [
        command.transactionType,
        command.businessReferenceType,
        command.businessReferenceId ?? null,
        command.idempotencyScope,
        command.idempotencyKey,
        command.assetId,
        command.reversesTransactionId ?? null,
        JSON.stringify(metadata),
        command.createdByType ?? 'SYSTEM',
        command.createdById ?? null,
      ],
    );
    await client.query('RELEASE SAVEPOINT ledger_post_insert');
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new LedgerDomainError('INTERNAL', 'Failed to insert transaction');
    transactionId = id;
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT ledger_post_insert');
    } catch {
      // savepoint may already be gone
    }
    if (isUniqueViolation(error)) {
      const constraint =
        typeof error === 'object' && error !== null && 'constraint' in error
          ? String((error as { constraint?: string }).constraint ?? '')
          : '';
      if (
        constraint.includes('idempotency') ||
        constraint === 'ledger_transactions_idempotency_key'
      ) {
        return recoverByIdempotency(client, command, intent);
      }
      if (
        constraint.includes('business_reference') ||
        constraint === 'ledger_transactions_business_reference_key'
      ) {
        return recoverByBusinessReference(client, command, intent);
      }
      if (constraint.includes('one_reversal') || constraint.includes('reverses')) {
        throw new LedgerDomainError(
          'REVERSAL_CONFLICT',
          'Original transaction already has a direct reversal',
          { cause: error },
        );
      }
      try {
        return await recoverByIdempotency(client, command, intent);
      } catch (idemError) {
        if (idemError instanceof LedgerDomainError && idemError.code === 'IDEMPOTENCY_CONFLICT') {
          throw idemError;
        }
        return recoverByBusinessReference(client, command, intent);
      }
    }
    throw error;
  }

  for (const entry of canonical) {
    await client.query(
      `INSERT INTO ledger_entries (
         ledger_transaction_id, ledger_account_id, direction, amount_atomic, entry_index
       ) VALUES ($1, $2, $3, $4, $5)`,
      [
        transactionId,
        entry.ledgerAccountId,
        entry.direction,
        entry.amountAtomic.toString(10),
        entry.entryIndex,
      ],
    );
  }

  // version += 1 once per distinct transaction affecting the account (not per entry line).
  for (const accountId of [...locked.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const next = nextBalances.get(accountId);
    if (next === undefined) continue;
    await client.query(
      `UPDATE ledger_account_balances
       SET balance_atomic = $2,
           version = version + 1,
           last_ledger_transaction_id = $3
       WHERE ledger_account_id = $1`,
      [accountId, next.toString(10), transactionId],
    );
  }

  return loadPostedTransaction(client, transactionId, true);
}

/**
 * Authoritative ledger posting path (no linked-reversal creation).
 * Pass a PoolClient to compose with domain/outbox writes in the same transaction.
 * Pass a Pool to let the ledger open and commit its own transaction.
 */
export async function postLedgerTransaction(
  db: LedgerDb,
  command: PostLedgerCommand,
): Promise<PostedLedgerTransaction> {
  return withLedgerTransaction(db, (client) => postInsideClient(client, command));
}

/**
 * Restricted posting path that links reverses_transaction_id.
 * Prefer reverseLedgerTransaction. This path enforces exact economic reversal
 * before insert so malformed linked reversals cannot consume the unique slot.
 */
export async function postLedgerTransactionWithReversalLink(
  db: LedgerDb,
  command: PostLedgerCommandWithReversalLink,
): Promise<PostedLedgerTransaction> {
  return withLedgerTransaction(db, (client) =>
    postInsideClient(client, {
      ...command,
      reversesTransactionId: command.reversesTransactionId,
    }),
  );
}

export type { LedgerAccountType, LedgerOwnerType };
