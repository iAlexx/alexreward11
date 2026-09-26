import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';

import type { AdminLedgerLookupResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

/** Read-only ledger lookup — never posts, never mutates balances. */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class LedgerAdminController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('ledger')
  async lookup(
    @Query('transactionId') transactionId?: string,
    @Query('accountId') accountId?: string,
    @Query('userId') userId?: string,
  ): Promise<AdminLedgerLookupResponse> {
    try {
      let transactions: AdminLedgerLookupResponse['transactions'] = {
        status: 'EMPTY',
        data: [],
        errorCode: 'NO_DATA',
      };
      let accounts: AdminLedgerLookupResponse['accounts'] = {
        status: 'EMPTY',
        data: [],
        errorCode: 'NO_DATA',
      };

      if (transactionId !== undefined && transactionId.trim() !== '') {
        const tx = await this.pool.query(
          `SELECT id, transaction_type::text AS transaction_type,
                  business_reference_type, business_reference_id,
                  posted_at, created_at
           FROM ledger_transactions WHERE id = $1::uuid`,
          [transactionId.trim()],
        );
        const entries = await this.pool.query(
          `SELECT id, ledger_account_id AS account_id, side::text AS side,
                  amount_atomic::text AS amount_atomic
           FROM ledger_entries WHERE ledger_transaction_id = $1::uuid`,
          [transactionId.trim()],
        );
        transactions = {
          status: tx.rows.length === 0 ? 'EMPTY' : 'READY',
          data: tx.rows.map((row) => ({ ...row, entries: entries.rows })),
          ...(tx.rows.length === 0 ? { errorCode: 'NO_DATA' as const } : {}),
        };
      }

      if (accountId !== undefined && accountId.trim() !== '') {
        const acc = await this.pool.query(
          `SELECT la.id, la.account_type::text AS account_type,
                  la.owner_type::text AS owner_type, la.owner_id, la.asset_id,
                  lab.balance_atomic::text AS balance_atomic
           FROM ledger_accounts la
           LEFT JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
           WHERE la.id = $1::uuid`,
          [accountId.trim()],
        );
        accounts = {
          status: acc.rows.length === 0 ? 'EMPTY' : 'READY',
          data: acc.rows,
          ...(acc.rows.length === 0 ? { errorCode: 'NO_DATA' as const } : {}),
        };
      } else if (userId !== undefined && userId.trim() !== '') {
        const acc = await this.pool.query(
          `SELECT la.id, la.account_type::text AS account_type,
                  la.owner_type::text AS owner_type, la.owner_id, la.asset_id,
                  lab.balance_atomic::text AS balance_atomic
           FROM ledger_accounts la
           LEFT JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
           WHERE la.owner_type = 'USER' AND la.owner_id = $1::uuid
           ORDER BY la.account_type
           LIMIT 50`,
          [userId.trim()],
        );
        accounts = {
          status: acc.rows.length === 0 ? 'EMPTY' : 'READY',
          data: acc.rows,
          ...(acc.rows.length === 0 ? { errorCode: 'NO_DATA' as const } : {}),
        };
      }

      return { contractVersion: '1', transactions, accounts };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
