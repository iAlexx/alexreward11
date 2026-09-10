import type { SignerRuntimeConfig } from './config.js';
import { SignerError } from './errors.js';
import type { SigningViewRow } from './read-model.js';

const SIGNABLE_STATES = new Set(['QUEUED', 'SIGNING']);
const BLOCKED_STATES = new Set([
  'HELD',
  'REJECTED',
  'CONFIRMED',
  'BROADCASTED',
  'BROADCASTING',
  'CONFIRMING',
  'REQUESTED',
  'RISK_CHECK',
  'MANUAL_REVIEW',
]);

export function assertSigningPolicy(
  row: SigningViewRow,
  config: SignerRuntimeConfig,
  now: Date = new Date(),
): void {
  if (!config.spikeEnabled) {
    throw new SignerError('SPIKE_DISABLED', 'Signer spike is disabled');
  }

  if (row.canonical_message_hash.startsWith('fake-hash:')) {
    throw new SignerError(
      'FAKE_PHASE7_HASH',
      'Phase 7 fake-hash attempts cannot be signed by real TON signer',
      { canonicalMessageHash: row.canonical_message_hash },
    );
  }

  if (row.network_environment === 'MAINNET' || row.network_code.toUpperCase().includes('MAINNET')) {
    throw new SignerError('MAINNET_REJECTED', 'MAINNET signing is forbidden in Phase 9');
  }

  if (row.network_chain !== 'TON') {
    throw new SignerError('POLICY_REJECTED', 'Network chain must be TON');
  }
  if (row.network_status !== 'ACTIVE') {
    throw new SignerError('POLICY_REJECTED', 'Network must be ACTIVE');
  }
  if (row.network_environment !== 'TESTNET') {
    throw new SignerError('POLICY_REJECTED', 'Phase 9 requires TESTNET network environment');
  }
  if (row.network_code !== config.networkCode) {
    throw new SignerError('POLICY_REJECTED', 'Network code does not match signer scope', {
      networkCode: row.network_code,
      expected: config.networkCode,
    });
  }
  if (!row.global_chain_identifier || row.global_chain_identifier.trim() === '') {
    throw new SignerError('POLICY_REJECTED', 'global_chain_identifier required');
  }

  if (row.approval_id === null || row.approval_decision !== 'APPROVE') {
    throw new SignerError('POLICY_REJECTED', 'Immutable APPROVE approval required');
  }

  if (BLOCKED_STATES.has(row.withdrawal_state) || !SIGNABLE_STATES.has(row.withdrawal_state)) {
    throw new SignerError('POLICY_REJECTED', 'Withdrawal state does not permit signing', {
      state: row.withdrawal_state,
    });
  }

  if (row.broadcast_started_at !== null) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Attempt crossed possible-broadcast boundary; signing forbidden',
    );
  }

  if (row.broadcast_result_state !== 'PENDING') {
    throw new SignerError('POLICY_REJECTED', 'Attempt broadcast_result_state must be PENDING', {
      broadcastResultState: row.broadcast_result_state,
    });
  }

  if (row.hot_wallet_status !== 'ACTIVE') {
    throw new SignerError('POLICY_REJECTED', 'Hot Wallet must be ACTIVE', {
      status: row.hot_wallet_status,
    });
  }
  if (row.hot_wallet_version !== config.walletVersion) {
    throw new SignerError('POLICY_REJECTED', 'Hot Wallet version must be v5R1', {
      walletVersion: row.hot_wallet_version,
    });
  }
  if (row.hot_wallet_signer_type !== 'FALLBACK_ENCRYPTED') {
    throw new SignerError(
      'POLICY_REJECTED',
      'Hot Wallet signer_type must be FALLBACK_ENCRYPTED (self-hosted encrypted custody)',
    );
  }
  if (
    config.expectedSignerReference !== null &&
    row.hot_wallet_signer_reference !== config.expectedSignerReference
  ) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Hot Wallet signer_reference must match expected public key fingerprint',
    );
  }
  if (
    config.expectedSignerReference !== null &&
    row.signer_key_reference !== config.expectedSignerReference
  ) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Attempt signer_key_reference must match expected public key fingerprint',
    );
  }

  if (!row.payout_jetton_wallet_address) {
    throw new SignerError(
      'POLICY_REJECTED',
      'Hot Wallet payout_jetton_wallet_address is required (no TON RPC derivation in signer)',
    );
  }

  if (!row.recipient_wallet_verified || row.recipient_wallet_disabled_at !== null) {
    throw new SignerError('POLICY_REJECTED', 'Recipient wallet must be verified and enabled');
  }

  if (row.asset_symbol !== config.expectedAssetSymbol) {
    throw new SignerError('POLICY_REJECTED', 'Unexpected payout asset symbol');
  }
  if (row.asset_is_native) {
    throw new SignerError('POLICY_REJECTED', 'Native TON cannot be used as payout asset');
  }
  if (row.asset_status !== 'ACTIVE') {
    throw new SignerError('POLICY_REJECTED', 'Asset must be ACTIVE');
  }
  if (!row.asset_contract_identity) {
    throw new SignerError('POLICY_REJECTED', 'Jetton master contract_identity required');
  }

  const requested = BigInt(row.requested_amount_atomic);
  const fee = BigInt(row.fee_amount_atomic);
  const net = BigInt(row.net_amount_atomic);
  if (requested !== fee + net || net <= 0n || fee < 0n) {
    throw new SignerError('POLICY_REJECTED', 'gross/fee/net split invalid');
  }
  if (
    row.requested_amount_atomic !== row.quote_requested_amount_atomic ||
    row.fee_amount_atomic !== row.quote_fee_amount_atomic ||
    row.net_amount_atomic !== row.quote_net_amount_atomic
  ) {
    throw new SignerError('POLICY_REJECTED', 'Withdrawal amounts must match immutable quote');
  }

  if (row.valid_until.getTime() <= now.getTime()) {
    throw new SignerError('POLICY_REJECTED', 'valid_until expired');
  }

  if (row.payout_dispatch_paused) {
    throw new SignerError('POLICY_REJECTED', 'PAYOUT_DISPATCH_PAUSE is enabled');
  }

  if (
    row.current_dispatch_fencing_token !== null &&
    row.dispatch_fencing_token !== row.current_dispatch_fencing_token
  ) {
    throw new SignerError('POLICY_REJECTED', 'Dispatch fencing token mismatch');
  }
  if (
    row.dispatch_lease_expires_at !== null &&
    row.dispatch_lease_expires_at.getTime() <= now.getTime() &&
    row.dispatch_lease_released_at === null
  ) {
    throw new SignerError('POLICY_REJECTED', 'Dispatch lease expired');
  }
}
