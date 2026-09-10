import type { Pool } from 'pg';

import { SignerError } from './errors.js';

export interface SigningViewRow {
  readonly withdrawal_attempt_id: string;
  readonly withdrawal_id: string;
  readonly attempt_number: number;
  readonly hot_wallet_id: string;
  readonly expected_seqno: string;
  readonly query_id: string;
  readonly valid_until: Date;
  readonly canonical_message_hash: string;
  readonly signed_message_hash: string | null;
  readonly signer_key_reference: string;
  readonly dispatch_fencing_token: string;
  readonly broadcast_result_state: string;
  readonly signing_started_at: Date | null;
  readonly broadcast_started_at: Date | null;
  readonly settled_at: Date | null;
  readonly withdrawal_state: string;
  readonly requested_amount_atomic: string;
  readonly fee_amount_atomic: string;
  readonly net_amount_atomic: string;
  readonly recipient_raw_address: string;
  readonly recipient_friendly_address: string;
  readonly recipient_wallet_verified: boolean;
  readonly recipient_wallet_disabled_at: Date | null;
  readonly hot_wallet_address: string;
  readonly hot_wallet_version: string;
  readonly hot_wallet_signer_type: string;
  readonly hot_wallet_signer_reference: string;
  readonly hot_wallet_status: string;
  readonly payout_jetton_wallet_address: string | null;
  readonly network_code: string;
  readonly network_chain: string;
  readonly network_environment: string;
  readonly global_chain_identifier: string;
  readonly network_status: string;
  readonly asset_symbol: string;
  readonly asset_decimals: number;
  readonly asset_is_native: boolean;
  readonly asset_contract_identity: string | null;
  readonly asset_status: string;
  readonly quote_requested_amount_atomic: string;
  readonly quote_fee_amount_atomic: string;
  readonly quote_net_amount_atomic: string;
  readonly approval_id: string | null;
  readonly approval_decision: string | null;
  readonly current_dispatch_fencing_token: string | null;
  readonly dispatch_lease_expires_at: Date | null;
  readonly dispatch_lease_released_at: Date | null;
  readonly payout_dispatch_paused: boolean;
}

export async function loadSigningView(
  pool: Pool,
  withdrawalAttemptId: string,
): Promise<SigningViewRow> {
  const result = await pool.query<SigningViewRow>(
    `SELECT *
     FROM signer_withdrawal_attempt_signing_v
     WHERE withdrawal_attempt_id = $1::uuid`,
    [withdrawalAttemptId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new SignerError('ATTEMPT_NOT_FOUND', 'withdrawal_attempt_id not found', {
      withdrawalAttemptId,
    });
  }
  return row;
}
