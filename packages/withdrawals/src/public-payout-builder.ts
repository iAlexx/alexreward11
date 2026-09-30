/**
 * Phase 17 Step 2 — confirmed payout publication builder.
 * Creates PENDING payout_publications from withdrawal.confirmed authority.
 * No Telegram send. Message snapshots remain NULL until SENDING (Step 3).
 */

import type { PoolClient } from 'pg';

import { insertWithdrawalAuditLog } from './audit.js';
import { WithdrawalDomainError } from './errors.js';
import { buildExplorerUrl } from './public-payout-format.js';
import {
  readPublicPayoutLogsFeatureFlag,
  type PublicPayoutFeatureEnvironment,
} from './public-payout-feature.js';
import { sanitizePublicPayoutUsernameSnapshot } from './public-payout-username.js';

export interface CreateConfirmedPayoutPublicationInput {
  readonly withdrawalId: string;
  readonly confirmedAttemptId: string;
  readonly environment: PublicPayoutFeatureEnvironment;
}

export type CreateConfirmedPayoutPublicationOutcome =
  | 'CREATED'
  | 'EXISTING'
  | 'FEATURE_DISABLED'
  | 'FEATURE_MISSING';

export interface CreateConfirmedPayoutPublicationResult {
  readonly publicationId: string | null;
  readonly created: boolean;
  readonly outcome: CreateConfirmedPayoutPublicationOutcome;
}

function isTestnetNetworkCode(code: string): boolean {
  const upper = code.toUpperCase();
  return upper.includes('TESTNET') || upper === 'TON_TESTNET';
}

export async function createConfirmedPayoutPublication(
  client: PoolClient,
  input: CreateConfirmedPayoutPublicationInput,
): Promise<CreateConfirmedPayoutPublicationResult> {
  const withdrawalId = input.withdrawalId.trim();
  const confirmedAttemptId = input.confirmedAttemptId.trim();
  if (withdrawalId === '' || confirmedAttemptId === '') {
    throw new WithdrawalDomainError(
      'VALIDATION',
      'withdrawalId and confirmedAttemptId are required',
    );
  }

  const flag = await readPublicPayoutLogsFeatureFlag(client, input.environment);
  if (flag === 'MISSING' || flag === 'DISABLED') {
    const reason = flag === 'MISSING' ? 'FEATURE_FLAG_MISSING' : 'FEATURE_DISABLED';
    await insertWithdrawalAuditLog(client, {
      actorType: 'SYSTEM',
      actionType: 'PUBLIC_PAYOUT_NOT_CREATED',
      resourceType: 'withdrawal',
      resourceId: withdrawalId,
      reason,
      afterSnapshot: {
        withdrawalId,
        confirmedAttemptId,
        environment: input.environment,
        reason,
      },
    });
    return {
      publicationId: null,
      created: false,
      outcome: flag === 'MISSING' ? 'FEATURE_MISSING' : 'FEATURE_DISABLED',
    };
  }

  const destinations = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM telegram_destinations
     WHERE environment = $1::environment_name
       AND purpose = 'PUBLIC_PAYOUT_LOGS'::telegram_destination_purpose
       AND enabled = true
     ORDER BY created_at ASC, id ASC`,
    [input.environment],
  );
  if (destinations.rows.length === 0) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'PUBLIC_PAYOUT_LOGS destination missing for environment',
      { details: { code: 'DESTINATION_MISSING', environment: input.environment } },
    );
  }
  if (destinations.rows.length > 1) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'PUBLIC_PAYOUT_LOGS destination ambiguous for environment',
      {
        details: {
          code: 'DESTINATION_AMBIGUOUS',
          environment: input.environment,
          count: destinations.rows.length,
        },
      },
    );
  }
  const destinationId = destinations.rows[0]!.id;

  const withdrawal = await client.query<{
    id: string;
    state: string;
    confirmed_at: Date | null;
    settlement_ledger_tx_id: string | null;
    user_id: string;
    asset_id: string;
    network_id: string;
    net_amount_atomic: string;
    public_id: string;
    wallet_id: string;
    hot_wallet_id: string | null;
  }>(
    `SELECT id::text AS id,
            state::text AS state,
            confirmed_at,
            settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
            user_id::text AS user_id,
            asset_id::text AS asset_id,
            network_id::text AS network_id,
            net_amount_atomic::text AS net_amount_atomic,
            public_id,
            wallet_id::text AS wallet_id,
            hot_wallet_id::text AS hot_wallet_id
     FROM withdrawals
     WHERE id = $1::uuid
     FOR SHARE`,
    [withdrawalId],
  );
  const w = withdrawal.rows[0];
  if (w === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'Withdrawal not found for publication');
  }
  if (w.state !== 'CONFIRMED') {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication requires CONFIRMED withdrawal',
      { details: { state: w.state } },
    );
  }
  if (w.confirmed_at === null) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication requires confirmed_at',
    );
  }
  if (w.settlement_ledger_tx_id === null) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication requires settlement_ledger_tx_id',
    );
  }
  if (w.hot_wallet_id === null) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication requires hot_wallet_id',
    );
  }

  const attempt = await client.query<{ id: string; settled_at: Date | null }>(
    `SELECT id::text AS id, settled_at
     FROM withdrawal_attempts
     WHERE id = $1::uuid
       AND withdrawal_id = $2::uuid
     FOR SHARE`,
    [confirmedAttemptId, withdrawalId],
  );
  const att = attempt.rows[0];
  if (att === undefined) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'confirmedAttemptId does not belong to withdrawal',
      { details: { confirmedAttemptId, withdrawalId } },
    );
  }
  if (att.settled_at === null) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'confirmedAttemptId requires settled_at',
    );
  }

  const proven = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM withdrawal_payout_reconciliations
     WHERE withdrawal_id = $1::uuid
       AND withdrawal_attempt_id = $2::uuid
       AND resolution = 'INTENDED_PAYOUT_PROVEN'
     FOR SHARE`,
    [withdrawalId, confirmedAttemptId],
  );
  if (proven.rows.length !== 1) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication requires exactly one INTENDED_PAYOUT_PROVEN for confirmed attempt',
      { details: { count: proven.rows.length } },
    );
  }

  const chainRows = await client.query<{
    id: string;
    chain_tx_reference: string;
    network_id: string;
    asset_id: string;
    amount_atomic: string;
    state: string;
  }>(
    `SELECT id::text AS id,
            chain_tx_reference,
            network_id::text AS network_id,
            asset_id::text AS asset_id,
            amount_atomic::text AS amount_atomic,
            state::text AS state
     FROM blockchain_transactions
     WHERE withdrawal_attempt_id = $1::uuid
       AND state = 'CONFIRMED'::blockchain_transaction_state
     FOR SHARE`,
    [confirmedAttemptId],
  );
  if (chainRows.rows.length === 0) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication requires CONFIRMED blockchain_transactions for attempt',
      { details: { code: 'CHAIN_TX_MISSING' } },
    );
  }
  if (chainRows.rows.length > 1) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication refused: multiple CONFIRMED blockchain_transactions for attempt',
      { details: { code: 'CHAIN_TX_AMBIGUOUS', count: chainRows.rows.length } },
    );
  }
  const chain = chainRows.rows[0]!;
  if (chain.chain_tx_reference.trim() === '') {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'Publication requires non-empty chain_tx_reference',
    );
  }
  if (
    chain.network_id !== w.network_id ||
    chain.asset_id !== w.asset_id ||
    chain.amount_atomic !== w.net_amount_atomic
  ) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'blockchain_transactions does not match withdrawal net payout identity',
      {
        details: {
          code: 'CHAIN_TX_MISMATCH',
          chainNetworkId: chain.network_id,
          chainAssetId: chain.asset_id,
          chainAmountAtomic: chain.amount_atomic,
          withdrawalNetworkId: w.network_id,
          withdrawalAssetId: w.asset_id,
          netAmountAtomic: w.net_amount_atomic,
        },
      },
    );
  }

  const network = await client.query<{
    code: string;
    display_name: string;
    public_explorer_base_url: string | null;
  }>(
    `SELECT code, display_name, public_explorer_base_url
     FROM networks
     WHERE id = $1::uuid`,
    [w.network_id],
  );
  const net = network.rows[0];
  if (net === undefined) {
    throw new WithdrawalDomainError('CONFIG', 'Withdrawal network not found');
  }

  if (
    (input.environment === 'PRODUCTION' || input.environment === 'STAGING') &&
    isTestnetNetworkCode(net.code)
  ) {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Public payout publication blocked for Testnet in this environment',
      {
        details: {
          code: 'TESTNET_PUBLICATION_BLOCKED',
          environment: input.environment,
          networkCode: net.code,
        },
      },
    );
  }

  const asset = await client.query<{ symbol: string; decimals: number }>(
    `SELECT symbol, decimals
     FROM assets
     WHERE id = $1::uuid`,
    [w.asset_id],
  );
  const a = asset.rows[0];
  if (a === undefined) {
    throw new WithdrawalDomainError('CONFIG', 'Withdrawal asset not found');
  }

  const explorerBase = (net.public_explorer_base_url ?? '').trim();
  if (explorerBase === '') {
    throw new WithdrawalDomainError(
      'CONFIG',
      'Network public_explorer_base_url is required for publication',
      { details: { networkCode: net.code } },
    );
  }
  // Validate https explorer joinability now (snapshots set at SENDING in Step 3).
  void buildExplorerUrl(explorerBase, chain.chain_tx_reference);

  const settings = await client.query<{
    identity_mode: string | null;
    username: string | null;
  }>(
    `SELECT COALESCE(s.public_payout_identity_mode::text, 'HIDE_IDENTITY') AS identity_mode,
            u.username
     FROM users u
     LEFT JOIN user_settings s ON s.user_id = u.id
     WHERE u.id = $1::uuid`,
    [w.user_id],
  );
  const identityModeRaw = settings.rows[0]?.identity_mode ?? 'HIDE_IDENTITY';
  const identityMode =
    identityModeRaw === 'SHOW_USERNAME' ? 'SHOW_USERNAME' : 'HIDE_IDENTITY';
  const usernameSnapshot =
    identityMode === 'SHOW_USERNAME'
      ? sanitizePublicPayoutUsernameSnapshot(settings.rows[0]?.username)
      : null;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO payout_publications (
       withdrawal_id, destination_id, identity_mode, username_snapshot, status
     ) VALUES (
       $1::uuid,
       $2::uuid,
       $3::public_payout_identity_mode,
       $4,
       'PENDING'::payout_publication_status
     )
     ON CONFLICT (withdrawal_id, destination_id) DO NOTHING
     RETURNING id::text AS id`,
    [withdrawalId, destinationId, identityMode, usernameSnapshot],
  );
  if (inserted.rows[0]?.id !== undefined) {
    return {
      publicationId: inserted.rows[0].id,
      created: true,
      outcome: 'CREATED',
    };
  }

  const existing = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM payout_publications
     WHERE withdrawal_id = $1::uuid
       AND destination_id = $2::uuid`,
    [withdrawalId, destinationId],
  );
  const existingId = existing.rows[0]?.id;
  if (existingId === undefined) {
    throw new WithdrawalDomainError(
      'INTERNAL',
      'payout_publications conflict without existing row',
    );
  }
  return {
    publicationId: existingId,
    created: false,
    outcome: 'EXISTING',
  };
}
