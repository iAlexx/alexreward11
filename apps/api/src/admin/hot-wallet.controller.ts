import { Controller, Get, Inject, UseGuards } from '@nestjs/common';

import type { AdminHotWalletResponse } from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';

import { AdminSessionGuard } from '../admin-auth/admin-session.guard.js';
import { DATABASE_POOL } from '../tokens.js';
import { mapAdminDomainError } from './http.js';

/**
 * Hot Wallet Admin read — public address, balances, status.
 * NEVER returns private keys, seeds, passphrases, or signer secrets.
 */
@Controller('v1/admin')
@UseGuards(AdminSessionGuard)
export class HotWalletController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get('hot-wallet')
  async getHotWallet(): Promise<AdminHotWalletResponse> {
    try {
      const rows = await this.pool.query<{
        id: string;
        address: string;
        friendly_address: string | null;
        wallet_version: string;
        signer_type: string;
        signer_reference: string;
        status: string;
        network_code: string;
      }>(
        `SELECT hw.id, hw.address, hw.friendly_address, hw.wallet_version,
                hw.signer_type::text AS signer_type, hw.signer_reference,
                hw.status::text AS status, n.code AS network_code
         FROM hot_wallets hw
         JOIN networks n ON n.id = hw.network_id
         WHERE hw.status = 'ACTIVE'
         ORDER BY hw.created_at DESC
         LIMIT 5`,
      );

      if (rows.rows.length === 0) {
        return {
          contractVersion: '1',
          status: 'UNAVAILABLE',
          reasonCode: 'NOT_CONFIGURED',
          data: null,
        };
      }

      // Prefer non-TEST_ONLY when multiple ACTIVE wallets exist.
      const preferred =
        rows.rows.find((row) => !row.signer_reference.startsWith('TEST_ONLY_FAKE')) ??
        rows.rows[0]!;

      // Balances are optional ledger projections — if unreadable, report null + balancesKnown=false.
      let usdtBalanceAtomic: string | null = null;
      let tonBalanceAtomic: string | null = null;
      let balancesKnown = false;
      let reservedPayoutsAtomic: string | null = null;
      try {
        const bal = await this.pool.query<{
          usdt: string | null;
          ton: string | null;
          reserved: string | null;
        }>(
          `SELECT
             (
               SELECT lab.balance_atomic::text
               FROM ledger_accounts la
               JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
               JOIN assets a ON a.id = la.asset_id
               WHERE la.owner_type = 'HOT_WALLET'
                 AND la.owner_id = $1::uuid
                 AND a.symbol = 'USDT'
               LIMIT 1
             ) AS usdt,
             (
               SELECT lab.balance_atomic::text
               FROM ledger_accounts la
               JOIN ledger_account_balances lab ON lab.ledger_account_id = la.id
               JOIN assets a ON a.id = la.asset_id
               WHERE la.owner_type = 'HOT_WALLET'
                 AND la.owner_id = $1::uuid
                 AND a.symbol = 'TON'
               LIMIT 1
             ) AS ton,
             (
               SELECT COALESCE(sum(w.net_amount_atomic), 0)::text
               FROM withdrawals w
               WHERE w.hot_wallet_id = $1::uuid
                 AND w.state IN ('APPROVED', 'QUEUED', 'SIGNING', 'BROADCASTING', 'BROADCASTED')
             ) AS reserved`,
          [preferred.id],
        );
        usdtBalanceAtomic = bal.rows[0]?.usdt ?? null;
        tonBalanceAtomic = bal.rows[0]?.ton ?? null;
        reservedPayoutsAtomic = bal.rows[0]?.reserved ?? null;
        balancesKnown = usdtBalanceAtomic !== null || tonBalanceAtomic !== null;
      } catch {
        balancesKnown = false;
      }

      return {
        contractVersion: '1',
        status: 'READY',
        data: {
          hotWalletId: preferred.id,
          address: preferred.address,
          friendlyAddress: preferred.friendly_address,
          walletVersion: preferred.wallet_version,
          signerType: preferred.signer_type,
          signerReference: preferred.signer_reference,
          networkCode: preferred.network_code,
          usdtBalanceAtomic,
          tonBalanceAtomic,
          balancesKnown,
          lastChainSyncAt: null,
          reservedPayoutsAtomic,
        },
      };
    } catch (error) {
      mapAdminDomainError(error);
    }
  }
}
