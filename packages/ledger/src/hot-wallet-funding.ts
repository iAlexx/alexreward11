/**
 * Owner-acknowledged hot-wallet USDT inventory funding (ledger-only).
 * Mirrors test harness fundHotWalletUsdt; requires explicit Owner acknowledgement
 * for TREASURY_FUNDING_CLEARING (OWNER_DECISION_REQUIRED).
 *
 * Does NOT move on-chain Jettons. Idempotent via idempotencyScope+key.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { getOrCreateLedgerAccount } from './accounts.js';
import { assertAssetActive, resolveHotWalletAssetAccountType } from './assets.js';
import { withLedgerTransaction, isPool } from './db.js';
import { LedgerDomainError } from './errors.js';
import { postLedgerTransaction } from './posting.js';

export interface PostOwnerAcknowledgedHotWalletUsdtFundingInput {
  readonly hotWalletId: string;
  readonly assetId: string;
  readonly amountAtomic: string;
  /** Must be exactly true — silent treasury clearing provision is refused. */
  readonly ownerAcknowledgesUnresolvedTreasuryClearing: true;
  readonly businessReferenceType: string;
  readonly businessReferenceId: string;
  readonly idempotencyScope: string;
  readonly idempotencyKey: string;
  readonly createdByType?: 'ADMIN' | 'SYSTEM';
  readonly createdById?: string | null;
}

export interface PostOwnerAcknowledgedHotWalletUsdtFundingResult {
  readonly ledgerTransactionId: string;
  readonly created: boolean;
  readonly amountAtomic: string;
  readonly hotWalletAccountId: string;
  readonly treasuryAccountId: string;
}

async function withClient<T>(db: Pool | PoolClient, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  if (!isPool(db)) return fn(db);
  return withLedgerTransaction(db, fn);
}

/**
 * DEBIT HOT_WALLET_USDT_ASSET / CREDIT TREASURY_FUNDING_CLEARING.
 * Refuse if Owner acknowledgement flag is not exactly true.
 */
export async function postOwnerAcknowledgedHotWalletUsdtFunding(
  db: Pool | PoolClient,
  input: PostOwnerAcknowledgedHotWalletUsdtFundingInput,
): Promise<PostOwnerAcknowledgedHotWalletUsdtFundingResult> {
  if (input.ownerAcknowledgesUnresolvedTreasuryClearing !== true) {
    throw new LedgerDomainError(
      'OWNER_DECISION_REQUIRED',
      'HOT_WALLET_FUNDING requires ownerAcknowledgesUnresolvedTreasuryClearing=true',
    );
  }
  if (!/^[1-9][0-9]*$/.test(input.amountAtomic)) {
    throw new LedgerDomainError('VALIDATION', 'amountAtomic must be a positive integer string');
  }

  return withClient(db, async (client) => {
    await assertAssetActive(client, input.assetId);
    const hotType = await resolveHotWalletAssetAccountType(client, input.assetId);
    if (hotType !== 'HOT_WALLET_USDT_ASSET') {
      throw new LedgerDomainError(
        'VALIDATION',
        `HOT_WALLET_FUNDING USDT path requires HOT_WALLET_USDT_ASSET (got ${hotType})`,
      );
    }

    const existing = await client.query<{ id: string }>(
      `SELECT id::text
       FROM ledger_transactions
       WHERE idempotency_scope = $1 AND idempotency_key = $2
       LIMIT 1`,
      [input.idempotencyScope, input.idempotencyKey],
    );
    if (existing.rows[0] !== undefined) {
      const hot = await getOrCreateLedgerAccount(client, {
        accountType: 'HOT_WALLET_USDT_ASSET',
        assetId: input.assetId,
        ownerId: input.hotWalletId,
      });
      const treasury = await getOrCreateLedgerAccount(client, {
        accountType: 'TREASURY_FUNDING_CLEARING',
        assetId: input.assetId,
        acknowledgeUnresolvedAccounting: true,
      });
      return {
        ledgerTransactionId: existing.rows[0].id,
        created: false,
        amountAtomic: input.amountAtomic,
        hotWalletAccountId: hot.id,
        treasuryAccountId: treasury.id,
      };
    }

    // Refuse a second distinct funding for the same hot wallet+asset when any
    // HOT_WALLET_FUNDING already exists (duplicate deposit reconciliation).
    const priorFund = await client.query<{ id: string; amount: string }>(
      `SELECT t.id::text, e.amount_atomic::text AS amount
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.ledger_transaction_id = t.id
       JOIN ledger_accounts a ON a.id = e.ledger_account_id
       WHERE t.transaction_type = 'HOT_WALLET_FUNDING'
         AND a.account_type = 'HOT_WALLET_USDT_ASSET'
         AND a.owner_id = $1::uuid
         AND a.asset_id = $2::uuid
         AND e.direction = 'DEBIT'
       LIMIT 1`,
      [input.hotWalletId, input.assetId],
    );
    if (priorFund.rows[0] !== undefined) {
      throw new LedgerDomainError(
        'BUSINESS_REFERENCE_CONFLICT',
        `HOT_WALLET_FUNDING already exists for this hot wallet (${priorFund.rows[0].id}); refuse duplicate`,
        { details: { existingTxId: priorFund.rows[0].id, existingAmount: priorFund.rows[0].amount } },
      );
    }

    const hot = await getOrCreateLedgerAccount(client, {
      accountType: 'HOT_WALLET_USDT_ASSET',
      assetId: input.assetId,
      ownerId: input.hotWalletId,
    });
    const treasury = await getOrCreateLedgerAccount(client, {
      accountType: 'TREASURY_FUNDING_CLEARING',
      assetId: input.assetId,
      acknowledgeUnresolvedAccounting: true,
    });

    const posted = await postLedgerTransaction(client, {
      transactionType: 'HOT_WALLET_FUNDING',
      businessReferenceType: input.businessReferenceType,
      businessReferenceId: input.businessReferenceId,
      idempotencyScope: input.idempotencyScope,
      idempotencyKey: input.idempotencyKey,
      assetId: input.assetId,
      ...(input.createdByType !== undefined
        ? {
            createdByType: input.createdByType,
            createdById: input.createdById ?? null,
          }
        : {}),
      entries: [
        { ledgerAccountId: hot.id, direction: 'DEBIT', amountAtomic: input.amountAtomic },
        { ledgerAccountId: treasury.id, direction: 'CREDIT', amountAtomic: input.amountAtomic },
      ],
      metadata: {
        purpose: 'owner_acknowledged_hot_wallet_usdt_inventory_reconcile',
        note: 'Ledger-only; on-chain Jetton deposit already completed',
      },
    });

    return {
      ledgerTransactionId: posted.id,
      created: true,
      amountAtomic: input.amountAtomic,
      hotWalletAccountId: hot.id,
      treasuryAccountId: treasury.id,
    };
  });
}

/** Test helper identity — prefer production API above for Owner ops. */
export function newHotWalletFundingBusinessReferenceId(): string {
  return randomUUID();
}
