import type { PoolClient } from 'pg';

import { WithdrawalDomainError } from './errors.js';

export interface EligiblePrimaryWallet {
  readonly id: string;
  readonly rawAddress: string;
  readonly friendlyAddress: string;
  readonly networkId: string;
}

export async function requireEligiblePrimaryWallet(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly networkId: string;
    readonly expectedWalletId?: string;
  },
): Promise<EligiblePrimaryWallet> {
  const user = await client.query<{
    status: string;
    withdrawal_status: string;
    withdrawal_cooldown_until: Date | null;
  }>(
    `SELECT status::text AS status,
            withdrawal_status::text AS withdrawal_status,
            withdrawal_cooldown_until
     FROM users WHERE id = $1::uuid FOR UPDATE`,
    [input.userId],
  );
  const u = user.rows[0];
  if (u === undefined) {
    throw new WithdrawalDomainError('UNAUTHORIZED', 'Authentication required');
  }
  if (u.status !== 'ACTIVE' || u.withdrawal_status === 'BLOCKED') {
    throw new WithdrawalDomainError('ACCOUNT_BLOCKED', 'Account cannot withdraw');
  }
  if (u.withdrawal_cooldown_until !== null && u.withdrawal_cooldown_until.getTime() > Date.now()) {
    throw new WithdrawalDomainError(
      'COOLDOWN_ACTIVE',
      'Wallet-change withdrawal cooldown is active',
    );
  }

  const wallet = await client.query<{
    id: string;
    raw_address: string;
    friendly_address: string;
    network_id: string;
    verified: boolean;
    verification_method: string | null;
    disabled_at: Date | null;
    is_primary: boolean;
  }>(
    `SELECT id, raw_address, friendly_address, network_id, verified,
            verification_method::text AS verification_method, disabled_at, is_primary
     FROM user_wallets
     WHERE user_id = $1::uuid
       AND network_id = $2::uuid
       AND is_primary = true
       AND disabled_at IS NULL
     FOR UPDATE`,
    [input.userId, input.networkId],
  );
  const w = wallet.rows[0];
  if (w === undefined) {
    throw new WithdrawalDomainError('WALLET_INELIGIBLE', 'Verified primary wallet required');
  }
  if (!w.verified || w.verification_method !== 'TON_PROOF') {
    throw new WithdrawalDomainError('WALLET_INELIGIBLE', 'Verified primary wallet required');
  }
  if (input.expectedWalletId !== undefined && w.id !== input.expectedWalletId) {
    throw new WithdrawalDomainError(
      'WALLET_INELIGIBLE',
      'Primary wallet changed; requote required',
    );
  }
  return {
    id: w.id,
    rawAddress: w.raw_address,
    friendlyAddress: w.friendly_address,
    networkId: w.network_id,
  };
}
