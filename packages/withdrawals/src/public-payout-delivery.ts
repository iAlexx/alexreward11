/**
 * Phase 17 Step 3 - ambiguity-safe public payout publication delivery engine.
 * Lease/fencing, snapshot-at-claim, network-attempt marker before send.
 * No Telegram/grammY transport here - inject PublicPayoutTelegramSender.
 */

import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { withWithdrawalTransaction } from './db.js';
import { WithdrawalDomainError } from './errors.js';
import {
  buildExplorerUrl,
  formatAtomicAmount,
  formatConfirmedUtcDate,
} from './public-payout-format.js';
import {
  readPublicPayoutLogsFeatureFlag,
  type PublicPayoutFeatureEnvironment,
} from './public-payout-feature.js';
import {
  renderPublicPayoutMessage,
  type PublicPayoutIdentityMode,
} from './public-payout-render.js';

const MAX_BACKOFF_SECONDS = 300;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_BATCH_LIMIT = 20;

export type PublicPayoutTelegramSender = {
  sendPublicPayout(input: {
    chatId: string;
    topicThreadId: number | null;
    text: string;
    explorerUrl: string;
  }): Promise<{ telegramMessageId: string }>;
};

export type PublicPayoutSendClassification = 'SUCCESS' | 'DEFINITE_FAILURE' | 'AMBIGUOUS';

export interface ClaimedPublicPayoutPublication {
  readonly publicationId: string;
  readonly withdrawalId: string;
  readonly destinationId: string;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
  readonly attempts: number;
  readonly identityMode: PublicPayoutIdentityMode;
  readonly usernameSnapshot: string | null;
  readonly messageTextSnapshot: string;
  readonly explorerUrlSnapshot: string;
  readonly chatId: string;
  readonly topicThreadId: number | null;
}

export type MarkNetworkAttemptStartedResult =
  | {
      readonly blocked?: undefined;
      readonly newlyStarted: boolean;
      readonly attempts: number;
      readonly chatId: string;
      readonly topicThreadId: number | null;
    }
  | {
      readonly blocked: true;
      readonly reason: string;
    };

export type DeliverClaimedPublicPayoutOutcome =
  | 'PUBLISHED'
  | 'FAILED'
  | 'AMBIGUOUS'
  | 'ALREADY_STARTED';

export interface DeliverClaimedPublicPayoutResult {
  readonly publicationId: string;
  readonly outcome: DeliverClaimedPublicPayoutOutcome;
}

export interface ClaimAndDeliverPublicPayoutBatchOptions {
  readonly owner: string;
  readonly sender: PublicPayoutTelegramSender;
  readonly environment: PublicPayoutFeatureEnvironment;
  readonly limit?: number;
  readonly leaseSeconds?: number;
  readonly recoverStaleFirst?: boolean;
}

export interface ClaimAndDeliverPublicPayoutBatchResult {
  readonly recovered: number;
  readonly claimed: number;
  readonly delivered: readonly DeliverClaimedPublicPayoutResult[];
}

export interface RecoverStalePublicPayoutSendingBatchResult {
  readonly recovered: number;
  readonly failed: number;
  readonly ambiguous: number;
}

/** Marker error class for fake senders / tests: definite no-message on Telegram. */
export class PublicPayoutDefiniteFailureError extends Error {
  readonly classification = 'DEFINITE_FAILURE' as const;

  constructor(message = 'Public payout send definite failure') {
    super(message);
    this.name = 'PublicPayoutDefiniteFailureError';
  }
}

/** Pre-network authorization failure: no Telegram call; row moved to FAILED. */
export class PublicPayoutPreNetworkAuthError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Public payout pre-network auth blocked: ${reason}`);
    this.name = 'PublicPayoutPreNetworkAuthError';
    this.reason = reason;
  }
}

export function publicPayoutDeliveryBackoffSeconds(attempts: number): number {
  const safe = Math.max(0, Math.floor(attempts));
  const cappedExp = Math.min(safe, 8);
  return Math.min(MAX_BACKOFF_SECONDS, Math.max(1, 2 ** cappedExp));
}

export function classifyPublicPayoutSenderError(
  error: unknown,
): Extract<PublicPayoutSendClassification, 'DEFINITE_FAILURE' | 'AMBIGUOUS'> {
  if (error instanceof PublicPayoutDefiniteFailureError) {
    return 'DEFINITE_FAILURE';
  }
  if (
    error !== null &&
    typeof error === 'object' &&
    'classification' in error &&
    (error as { classification?: unknown }).classification === 'DEFINITE_FAILURE'
  ) {
    return 'DEFINITE_FAILURE';
  }
  return 'AMBIGUOUS';
}

export function redactPublicPayoutDeliveryError(error: unknown): string {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = String(error);
  }
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, 'postgres://[redacted]')
    .replace(/redis(?:s)?:\/\/[^\s'"]+/gi, 'redis://[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/password=[^&\s'"]+/gi, 'password=[redacted]')
    .slice(0, 500);
}

function clampLimit(limit: number | undefined): number {
  const n = limit ?? DEFAULT_BATCH_LIMIT;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function clampLeaseSeconds(leaseSeconds: number | undefined): number {
  const n = leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  return Math.max(5, Math.min(600, Math.floor(n)));
}

async function schedulePublicationRetry(
  client: PoolClient,
  input: {
    readonly publicationId: string;
    readonly fromStatus: 'PENDING' | 'FAILED';
    readonly attempts: number;
    readonly errorRedacted: string;
  },
): Promise<void> {
  const backoff = publicPayoutDeliveryBackoffSeconds(input.attempts);
  if (input.fromStatus === 'FAILED') {
    await client.query(
      `UPDATE payout_publications
       SET last_error_redacted = $2,
           next_attempt_at = now() + make_interval(secs => $3::int)
       WHERE id = $1::uuid
         AND status = 'FAILED'::payout_publication_status`,
      [input.publicationId, input.errorRedacted, backoff],
    );
    return;
  }
  // PENDING cannot transition to FAILED (state machine). Delay retry in place.
  await client.query(
    `UPDATE payout_publications
     SET last_error_redacted = $2,
         next_attempt_at = now() + make_interval(secs => $3::int)
     WHERE id = $1::uuid
       AND status = 'PENDING'::payout_publication_status`,
    [input.publicationId, input.errorRedacted, backoff],
  );
}

async function skipPublication(
  client: PoolClient,
  publicationId: string,
  fromStatus: 'PENDING' | 'FAILED',
  errorRedacted: string,
): Promise<void> {
  await client.query(
    `UPDATE payout_publications
     SET status = 'SKIPPED'::payout_publication_status,
         last_error_redacted = $2
     WHERE id = $1::uuid
       AND status = $3::payout_publication_status`,
    [publicationId, errorRedacted, fromStatus],
  );
}

type ProofLoadResult =
  | {
      readonly ok: true;
      readonly messageText: string;
      readonly explorerUrl: string;
    }
  | { readonly ok: false; readonly reason: string };

async function loadProofAndBuildSnapshots(
  client: PoolClient,
  input: {
    readonly withdrawalId: string;
    readonly identityMode: string;
    readonly usernameSnapshot: string | null;
  },
): Promise<ProofLoadResult> {
  const withdrawal = await client.query<{
    state: string;
    confirmed_at: Date | null;
    settlement_ledger_tx_id: string | null;
    asset_id: string;
    network_id: string;
    net_amount_atomic: string;
    public_id: string;
  }>(
    `SELECT state::text AS state,
            confirmed_at,
            settlement_ledger_tx_id::text AS settlement_ledger_tx_id,
            asset_id::text AS asset_id,
            network_id::text AS network_id,
            net_amount_atomic::text AS net_amount_atomic,
            public_id
     FROM withdrawals
     WHERE id = $1::uuid
     FOR SHARE`,
    [input.withdrawalId],
  );
  const w = withdrawal.rows[0];
  if (w === undefined) {
    return { ok: false, reason: 'WITHDRAWAL_MISSING' };
  }
  if (w.state !== 'CONFIRMED' || w.confirmed_at === null || w.settlement_ledger_tx_id === null) {
    return { ok: false, reason: 'WITHDRAWAL_NOT_SETTLED_CONFIRMED' };
  }

  const proven = await client.query<{ attempt_id: string }>(
    `SELECT withdrawal_attempt_id::text AS attempt_id
     FROM withdrawal_payout_reconciliations
     WHERE withdrawal_id = $1::uuid
       AND resolution = 'INTENDED_PAYOUT_PROVEN'
     FOR SHARE`,
    [input.withdrawalId],
  );
  if (proven.rows.length !== 1) {
    return { ok: false, reason: 'PROOF_COUNT_INVALID' };
  }
  const attemptId = proven.rows[0]!.attempt_id;

  const attempt = await client.query<{ settled_at: Date | null }>(
    `SELECT settled_at
     FROM withdrawal_attempts
     WHERE id = $1::uuid
       AND withdrawal_id = $2::uuid
     FOR SHARE`,
    [attemptId, input.withdrawalId],
  );
  if (attempt.rows[0]?.settled_at === null || attempt.rows[0] === undefined) {
    return { ok: false, reason: 'ATTEMPT_NOT_SETTLED' };
  }

  const chainRows = await client.query<{
    chain_tx_reference: string;
    network_id: string;
    asset_id: string;
    amount_atomic: string;
  }>(
    `SELECT chain_tx_reference,
            network_id::text AS network_id,
            asset_id::text AS asset_id,
            amount_atomic::text AS amount_atomic
     FROM blockchain_transactions
     WHERE withdrawal_attempt_id = $1::uuid
       AND state = 'CONFIRMED'::blockchain_transaction_state
     FOR SHARE`,
    [attemptId],
  );
  if (chainRows.rows.length !== 1) {
    return { ok: false, reason: 'CHAIN_TX_COUNT_INVALID' };
  }
  const chain = chainRows.rows[0]!;
  if (chain.chain_tx_reference.trim() === '') {
    return { ok: false, reason: 'CHAIN_TX_REFERENCE_EMPTY' };
  }
  if (
    chain.network_id !== w.network_id ||
    chain.asset_id !== w.asset_id ||
    chain.amount_atomic !== w.net_amount_atomic
  ) {
    return { ok: false, reason: 'CHAIN_TX_MISMATCH' };
  }

  const network = await client.query<{
    display_name: string;
    public_explorer_base_url: string | null;
  }>(
    `SELECT display_name, public_explorer_base_url
     FROM networks
     WHERE id = $1::uuid`,
    [w.network_id],
  );
  const net = network.rows[0];
  if (net === undefined) {
    return { ok: false, reason: 'NETWORK_MISSING' };
  }
  const explorerBase = (net.public_explorer_base_url ?? '').trim();
  if (explorerBase === '') {
    return { ok: false, reason: 'EXPLORER_BASE_MISSING' };
  }

  const asset = await client.query<{ symbol: string; decimals: number }>(
    `SELECT symbol, decimals FROM assets WHERE id = $1::uuid`,
    [w.asset_id],
  );
  const a = asset.rows[0];
  if (a === undefined) {
    return { ok: false, reason: 'ASSET_MISSING' };
  }

  let explorerUrl: string;
  let amountFormatted: string;
  try {
    explorerUrl = buildExplorerUrl(explorerBase, chain.chain_tx_reference);
    amountFormatted = formatAtomicAmount(w.net_amount_atomic, a.decimals);
  } catch {
    return { ok: false, reason: 'SNAPSHOT_BUILD_FAILED' };
  }

  const identityMode: PublicPayoutIdentityMode =
    input.identityMode === 'SHOW_USERNAME' ? 'SHOW_USERNAME' : 'HIDE_IDENTITY';
  const messageText = renderPublicPayoutMessage({
    identityMode,
    usernameSnapshot: input.usernameSnapshot,
    amountFormatted,
    assetSymbol: a.symbol,
    networkLabel: net.display_name,
    publicId: w.public_id,
    confirmedDateUtc: formatConfirmedUtcDate(w.confirmed_at),
  });

  return { ok: true, messageText, explorerUrl };
}

/**
 * Claim PENDING|FAILED publications into SENDING with lease + message snapshots.
 * Does NOT increment attempts (network marker owns that).
 */
export async function claimPublicPayoutPublications(
  client: PoolClient,
  input: {
    readonly owner: string;
    readonly environment: PublicPayoutFeatureEnvironment;
    readonly limit?: number;
    readonly leaseSeconds?: number;
  },
): Promise<ClaimedPublicPayoutPublication[]> {
  const owner = input.owner.trim();
  if (owner === '') {
    throw new WithdrawalDomainError('VALIDATION', 'lease owner is required');
  }
  const limit = clampLimit(input.limit);
  const leaseSeconds = clampLeaseSeconds(input.leaseSeconds);

  const flag = await readPublicPayoutLogsFeatureFlag(client, input.environment);

  const candidates = await client.query<{
    id: string;
    withdrawal_id: string;
    destination_id: string;
    status: string;
    attempts: number;
    identity_mode: string;
    username_snapshot: string | null;
    destination_enabled: boolean;
    destination_purpose: string;
    chat_id: string;
    topic_thread_id: string | null;
  }>(
    `SELECT pp.id::text AS id,
            pp.withdrawal_id::text AS withdrawal_id,
            pp.destination_id::text AS destination_id,
            pp.status::text AS status,
            pp.attempts,
            pp.identity_mode::text AS identity_mode,
            pp.username_snapshot,
            td.enabled AS destination_enabled,
            td.purpose::text AS destination_purpose,
            td.chat_id::text AS chat_id,
            td.topic_thread_id::text AS topic_thread_id
     FROM payout_publications pp
     INNER JOIN telegram_destinations td ON td.id = pp.destination_id
     WHERE pp.status IN (
             'PENDING'::payout_publication_status,
             'FAILED'::payout_publication_status
           )
       AND pp.next_attempt_at <= now()
       AND td.environment = $1::environment_name
       AND td.purpose = 'PUBLIC_PAYOUT_LOGS'::telegram_destination_purpose
     ORDER BY pp.next_attempt_at ASC, pp.created_at ASC
     LIMIT $2
     FOR UPDATE OF pp SKIP LOCKED`,
    [input.environment, limit],
  );

  const claimed: ClaimedPublicPayoutPublication[] = [];

  for (const row of candidates.rows) {
    const fromStatus = row.status === 'FAILED' ? 'FAILED' : 'PENDING';

    if (flag !== 'ENABLED') {
      await skipPublication(
        client,
        row.id,
        fromStatus,
        flag === 'MISSING' ? 'FEATURE_FLAG_MISSING' : 'FEATURE_DISABLED',
      );
      continue;
    }

    if (!row.destination_enabled || row.destination_purpose !== 'PUBLIC_PAYOUT_LOGS') {
      await schedulePublicationRetry(client, {
        publicationId: row.id,
        fromStatus,
        attempts: row.attempts,
        errorRedacted: 'DESTINATION_DISABLED_OR_INVALID',
      });
      continue;
    }

    const proof = await loadProofAndBuildSnapshots(client, {
      withdrawalId: row.withdrawal_id,
      identityMode: row.identity_mode,
      usernameSnapshot: row.username_snapshot,
    });
    if (!proof.ok) {
      await schedulePublicationRetry(client, {
        publicationId: row.id,
        fromStatus,
        attempts: row.attempts,
        errorRedacted: proof.reason,
      });
      continue;
    }

    const leaseToken = randomUUID();
    const updated = await client.query<{
      id: string;
      lease_expires_at: Date;
      attempts: number;
      message_text_snapshot: string;
      explorer_url_snapshot: string;
      identity_mode: string;
      username_snapshot: string | null;
    }>(
      `UPDATE payout_publications
       SET status = 'SENDING'::payout_publication_status,
           lease_owner = $2,
           lease_token = $3::uuid,
           lease_expires_at = now() + make_interval(secs => $4::int),
           message_text_snapshot = $5,
           explorer_url_snapshot = $6,
           last_error_redacted = NULL
       WHERE id = $1::uuid
         AND status = $7::payout_publication_status
       RETURNING id::text AS id,
                 lease_expires_at,
                 attempts,
                 message_text_snapshot,
                 explorer_url_snapshot,
                 identity_mode::text AS identity_mode,
                 username_snapshot`,
      [
        row.id,
        owner,
        leaseToken,
        leaseSeconds,
        proof.messageText,
        proof.explorerUrl,
        fromStatus,
      ],
    );
    const u = updated.rows[0];
    if (u === undefined) {
      continue;
    }

    const topicThreadId =
      row.topic_thread_id === null || row.topic_thread_id === ''
        ? null
        : Number(row.topic_thread_id);

    claimed.push({
      publicationId: u.id,
      withdrawalId: row.withdrawal_id,
      destinationId: row.destination_id,
      leaseOwner: owner,
      leaseToken,
      leaseExpiresAt: u.lease_expires_at,
      attempts: u.attempts,
      identityMode:
        u.identity_mode === 'SHOW_USERNAME' ? 'SHOW_USERNAME' : 'HIDE_IDENTITY',
      usernameSnapshot: u.username_snapshot,
      messageTextSnapshot: u.message_text_snapshot,
      explorerUrlSnapshot: u.explorer_url_snapshot,
      chatId: row.chat_id,
      topicThreadId:
        topicThreadId !== null && Number.isFinite(topicThreadId) ? topicThreadId : null,
    });
  }

  return claimed;
}

/**
 * Final send authorization + irreversible network-attempt marker.
 * Re-checks DB feature flag and destination under FOR SHARE locks.
 * Increments attempts exactly once per lease. Replay returns newlyStarted=false.
 */
export async function markPublicPayoutNetworkAttemptStarted(
  client: PoolClient,
  input: {
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly environment: PublicPayoutFeatureEnvironment;
  },
): Promise<MarkNetworkAttemptStartedResult> {
  const locked = await client.query<{
    status: string;
    lease_token: string | null;
    lease_expires_at: Date | null;
    send_request_started_at: Date | null;
    attempts: number;
    destination_id: string;
  }>(
    `SELECT status::text AS status,
            lease_token::text AS lease_token,
            lease_expires_at,
            send_request_started_at,
            attempts,
            destination_id::text AS destination_id
     FROM payout_publications
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.publicationId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'payout publication not found', {
      details: { publicationId: input.publicationId },
    });
  }
  if (row.status !== 'SENDING') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'publication not in SENDING for network mark', {
      details: { status: row.status },
    });
  }
  if (row.lease_token !== input.leaseToken) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'stale or wrong lease token for network mark', {
      details: { code: 'LEASE_MISMATCH' },
    });
  }
  if (row.lease_expires_at === null || row.lease_expires_at.getTime() <= Date.now()) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'lease expired for network mark', {
      details: { code: 'LEASE_EXPIRED' },
    });
  }

  const loadRoutingTarget = async (): Promise<{
    chatId: string;
    topicThreadId: number | null;
  }> => {
    const dest = await client.query<{
      chat_id: string;
      topic_thread_id: string | null;
    }>(
      `SELECT chat_id::text AS chat_id,
              topic_thread_id::text AS topic_thread_id
       FROM telegram_destinations
       WHERE id = $1::uuid`,
      [row.destination_id],
    );
    const d = dest.rows[0];
    if (d === undefined) {
      throw new WithdrawalDomainError('CONFIG', 'publication destination missing for routing', {
        details: { code: 'DESTINATION_MISSING' },
      });
    }
    const topic =
      d.topic_thread_id === null || d.topic_thread_id === ''
        ? null
        : Number(d.topic_thread_id);
    return {
      chatId: d.chat_id,
      topicThreadId: topic !== null && Number.isFinite(topic) ? topic : null,
    };
  };

  if (row.send_request_started_at !== null) {
    const routing = await loadRoutingTarget();
    return {
      newlyStarted: false,
      attempts: row.attempts,
      chatId: routing.chatId,
      topicThreadId: routing.topicThreadId,
    };
  }

  const failPreNetwork = async (
    reason: string,
  ): Promise<Extract<MarkNetworkAttemptStartedResult, { blocked: true }>> => {
    await finalizePublicPayoutFailed(client, {
      publicationId: input.publicationId,
      leaseToken: input.leaseToken,
      errorRedacted: reason,
    });
    return { blocked: true, reason };
  };

  // Feature flag final authorization (FOR SHARE serializes with disable UPDATEs).
  const flag = await client.query<{ enabled: boolean }>(
    `SELECT enabled
     FROM feature_flags
     WHERE flag_key = 'PUBLIC_PAYOUT_LOGS_ENABLED'
       AND environment = $1::environment_name
     FOR SHARE`,
    [input.environment],
  );
  if (flag.rows[0] === undefined) {
    return await failPreNetwork('FEATURE_FLAG_MISSING_BEFORE_NETWORK');
  }
  if (flag.rows[0]!.enabled !== true) {
    return await failPreNetwork('FEATURE_DISABLED_BEFORE_NETWORK');
  }

  const destRow = await client.query<{
    id: string;
    enabled: boolean;
    purpose: string;
    environment: string;
    chat_id: string;
    topic_thread_id: string | null;
  }>(
    `SELECT id::text AS id,
            enabled,
            purpose::text AS purpose,
            environment::text AS environment,
            chat_id::text AS chat_id,
            topic_thread_id::text AS topic_thread_id
     FROM telegram_destinations
     WHERE id = $1::uuid
     FOR SHARE`,
    [row.destination_id],
  );
  const destination = destRow.rows[0];
  if (destination === undefined) {
    return await failPreNetwork('DESTINATION_DISABLED_BEFORE_NETWORK');
  }
  if (
    destination!.enabled !== true ||
    destination!.purpose !== 'PUBLIC_PAYOUT_LOGS' ||
    destination!.environment !== input.environment
  ) {
    return await failPreNetwork('DESTINATION_DISABLED_BEFORE_NETWORK');
  }

  const enabledSet = await client.query<{ id: string }>(
    `SELECT id::text AS id
     FROM telegram_destinations
     WHERE environment = $1::environment_name
       AND purpose = 'PUBLIC_PAYOUT_LOGS'::telegram_destination_purpose
       AND enabled = true
     ORDER BY id ASC
     FOR SHARE`,
    [input.environment],
  );
  if (enabledSet.rows.length === 0) {
    return await failPreNetwork('DESTINATION_DISABLED_BEFORE_NETWORK');
  }
  if (enabledSet.rows.length > 1) {
    return await failPreNetwork('DESTINATION_AMBIGUOUS_BEFORE_NETWORK');
  }
  if (enabledSet.rows[0]!.id !== row.destination_id) {
    return await failPreNetwork('DESTINATION_CHANGED_BEFORE_NETWORK');
  }

  const topicRaw = destination!.topic_thread_id;
  const topicParsed =
    topicRaw === null || topicRaw === '' ? null : Number(topicRaw);
  const routing = {
    chatId: destination!.chat_id,
    topicThreadId:
      topicParsed !== null && Number.isFinite(topicParsed) ? topicParsed : null,
  };

  const updated = await client.query<{ attempts: number }>(
    `UPDATE payout_publications
     SET send_request_started_at = now(),
         attempts = attempts + 1
     WHERE id = $1::uuid
       AND status = 'SENDING'::payout_publication_status
       AND lease_token = $2::uuid
       AND lease_expires_at > now()
       AND send_request_started_at IS NULL
     RETURNING attempts`,
    [input.publicationId, input.leaseToken],
  );
  const attempts = updated.rows[0]?.attempts;
  if (attempts === undefined) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'failed to mark network attempt started', {
      details: { code: 'MARK_RACE' },
    });
  }
  return {
    newlyStarted: true,
    attempts,
    chatId: routing.chatId,
    topicThreadId: routing.topicThreadId,
  };
}

export async function finalizePublicPayoutPublished(
  client: PoolClient,
  input: {
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly telegramMessageId: string;
  },
): Promise<void> {
  const messageId = input.telegramMessageId.trim();
  if (!/^\d+$/.test(messageId)) {
    throw new WithdrawalDomainError('VALIDATION', 'telegramMessageId must be a digit string');
  }

  const locked = await client.query<{
    status: string;
    lease_token: string | null;
    send_request_started_at: Date | null;
  }>(
    `SELECT status::text AS status,
            lease_token::text AS lease_token,
            send_request_started_at
     FROM payout_publications
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.publicationId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'payout publication not found');
  }
  if (row.status !== 'SENDING') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'publication not in SENDING for publish', {
      details: { status: row.status },
    });
  }
  if (row.lease_token !== input.leaseToken) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'stale or wrong lease token for publish', {
      details: { code: 'LEASE_MISMATCH' },
    });
  }
  if (row.send_request_started_at === null) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'publish requires send_request_started_at', {
      details: { code: 'NETWORK_NOT_STARTED' },
    });
  }

  const result = await client.query(
    `UPDATE payout_publications
     SET status = 'PUBLISHED'::payout_publication_status,
         telegram_message_id = $3::bigint,
         published_at = now(),
         last_error_redacted = NULL
     WHERE id = $1::uuid
       AND status = 'SENDING'::payout_publication_status
       AND lease_token = $2::uuid
       AND send_request_started_at IS NOT NULL`,
    [input.publicationId, input.leaseToken, messageId],
  );
  if (result.rowCount !== 1) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'failed to finalize PUBLISHED');
  }
}

export async function finalizePublicPayoutFailed(
  client: PoolClient,
  input: {
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly errorRedacted: string;
  },
): Promise<void> {
  const locked = await client.query<{
    status: string;
    lease_token: string | null;
    attempts: number;
  }>(
    `SELECT status::text AS status,
            lease_token::text AS lease_token,
            attempts
     FROM payout_publications
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.publicationId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'payout publication not found');
  }
  if (row.status !== 'SENDING') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'publication not in SENDING for fail', {
      details: { status: row.status },
    });
  }
  if (row.lease_token !== input.leaseToken) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'stale or wrong lease token for fail', {
      details: { code: 'LEASE_MISMATCH' },
    });
  }

  const backoff = publicPayoutDeliveryBackoffSeconds(row.attempts);
  const result = await client.query(
    `UPDATE payout_publications
     SET status = 'FAILED'::payout_publication_status,
         last_error_redacted = $3,
         next_attempt_at = now() + make_interval(secs => $4::int)
     WHERE id = $1::uuid
       AND status = 'SENDING'::payout_publication_status
       AND lease_token = $2::uuid`,
    [input.publicationId, input.leaseToken, input.errorRedacted.slice(0, 500), backoff],
  );
  if (result.rowCount !== 1) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'failed to finalize FAILED');
  }
}

export async function finalizePublicPayoutAmbiguous(
  client: PoolClient,
  input: {
    readonly publicationId: string;
    readonly leaseToken: string;
    readonly errorRedacted?: string;
  },
): Promise<void> {
  const locked = await client.query<{
    status: string;
    lease_token: string | null;
    send_request_started_at: Date | null;
  }>(
    `SELECT status::text AS status,
            lease_token::text AS lease_token,
            send_request_started_at
     FROM payout_publications
     WHERE id = $1::uuid
     FOR UPDATE`,
    [input.publicationId],
  );
  const row = locked.rows[0];
  if (row === undefined) {
    throw new WithdrawalDomainError('VALIDATION', 'payout publication not found');
  }
  if (row.status !== 'SENDING') {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'publication not in SENDING for ambiguous', {
      details: { status: row.status },
    });
  }
  if (row.lease_token !== input.leaseToken) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'stale or wrong lease token for ambiguous', {
      details: { code: 'LEASE_MISMATCH' },
    });
  }
  if (row.send_request_started_at === null) {
    throw new WithdrawalDomainError(
      'STATE_CONFLICT',
      'ambiguous requires send_request_started_at (network started)',
      { details: { code: 'NETWORK_NOT_STARTED' } },
    );
  }

  const result = await client.query(
    `UPDATE payout_publications
     SET status = 'AMBIGUOUS'::payout_publication_status,
         ambiguous_at = now(),
         last_error_redacted = COALESCE($3, last_error_redacted)
     WHERE id = $1::uuid
       AND status = 'SENDING'::payout_publication_status
       AND lease_token = $2::uuid
       AND send_request_started_at IS NOT NULL`,
    [
      input.publicationId,
      input.leaseToken,
      input.errorRedacted === undefined ? null : input.errorRedacted.slice(0, 500),
    ],
  );
  if (result.rowCount !== 1) {
    throw new WithdrawalDomainError('STATE_CONFLICT', 'failed to finalize AMBIGUOUS');
  }
}

/**
 * Recover expired SENDING leases without network calls.
 * Pre-marker => FAILED (safe retry). Post-marker => AMBIGUOUS.
 */
export async function recoverStalePublicPayoutSendingBatch(
  client: PoolClient,
  input: { readonly limit?: number } = {},
): Promise<RecoverStalePublicPayoutSendingBatchResult> {
  const limit = clampLimit(input.limit);
  const stale = await client.query<{
    id: string;
    lease_token: string | null;
    send_request_started_at: Date | null;
    attempts: number;
  }>(
    `SELECT id::text AS id,
            lease_token::text AS lease_token,
            send_request_started_at,
            attempts
     FROM payout_publications
     WHERE status = 'SENDING'::payout_publication_status
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()
     ORDER BY lease_expires_at ASC, created_at ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [limit],
  );

  let failed = 0;
  let ambiguous = 0;

  for (const row of stale.rows) {
    if (row.send_request_started_at === null) {
      const backoff = publicPayoutDeliveryBackoffSeconds(row.attempts);
      await client.query(
        `UPDATE payout_publications
         SET status = 'FAILED'::payout_publication_status,
             last_error_redacted = 'STALE_SENDING_BEFORE_NETWORK',
             next_attempt_at = now() + make_interval(secs => $2::int)
         WHERE id = $1::uuid
           AND status = 'SENDING'::payout_publication_status`,
        [row.id, backoff],
      );
      failed += 1;
    } else {
      await client.query(
        `UPDATE payout_publications
         SET status = 'AMBIGUOUS'::payout_publication_status,
             ambiguous_at = now(),
             last_error_redacted = COALESCE(last_error_redacted, 'STALE_SENDING_AFTER_NETWORK')
         WHERE id = $1::uuid
           AND status = 'SENDING'::payout_publication_status
           AND send_request_started_at IS NOT NULL`,
        [row.id],
      );
      ambiguous += 1;
    }
  }

  return { recovered: stale.rows.length, failed, ambiguous };
}

/**
 * Orchestration: mark network attempt, then send, then finalize by classification.
 * Marker is committed before any sender call. Only newlyStarted may invoke Telegram.
 */
export async function deliverClaimedPublicPayout(
  pool: Pool,
  sender: PublicPayoutTelegramSender,
  claimed: ClaimedPublicPayoutPublication,
  environment: PublicPayoutFeatureEnvironment,
): Promise<DeliverClaimedPublicPayoutResult> {
  const markResult = await withWithdrawalTransaction(pool, async (client) =>
    markPublicPayoutNetworkAttemptStarted(client, {
      publicationId: claimed.publicationId,
      leaseToken: claimed.leaseToken,
      environment,
    }),
  );
  if (markResult.blocked === true) {
    return { publicationId: claimed.publicationId, outcome: 'FAILED' };
  }
  if (!markResult.newlyStarted) {
    return { publicationId: claimed.publicationId, outcome: 'ALREADY_STARTED' };
  }

  try {
    const sendResult = await sender.sendPublicPayout({
      chatId: markResult.chatId,
      topicThreadId: markResult.topicThreadId,
      text: claimed.messageTextSnapshot,
      explorerUrl: claimed.explorerUrlSnapshot,
    });
    await withWithdrawalTransaction(pool, async (client) => {
      await finalizePublicPayoutPublished(client, {
        publicationId: claimed.publicationId,
        leaseToken: claimed.leaseToken,
        telegramMessageId: sendResult.telegramMessageId,
      });
    });
    return { publicationId: claimed.publicationId, outcome: 'PUBLISHED' };
  } catch (error) {
    const classification = classifyPublicPayoutSenderError(error);
    const redacted = redactPublicPayoutDeliveryError(error);
    if (classification === 'DEFINITE_FAILURE') {
      await withWithdrawalTransaction(pool, async (client) => {
        await finalizePublicPayoutFailed(client, {
          publicationId: claimed.publicationId,
          leaseToken: claimed.leaseToken,
          errorRedacted: redacted,
        });
      });
      return { publicationId: claimed.publicationId, outcome: 'FAILED' };
    }
    await withWithdrawalTransaction(pool, async (client) => {
      await finalizePublicPayoutAmbiguous(client, {
        publicationId: claimed.publicationId,
        leaseToken: claimed.leaseToken,
        errorRedacted: redacted,
      });
    });
    return { publicationId: claimed.publicationId, outcome: 'AMBIGUOUS' };
  }
}

export async function claimAndDeliverPublicPayoutBatch(
  pool: Pool,
  options: ClaimAndDeliverPublicPayoutBatchOptions,
): Promise<ClaimAndDeliverPublicPayoutBatchResult> {
  const limit = clampLimit(options.limit);
  const leaseSeconds = clampLeaseSeconds(options.leaseSeconds);
  const recoverStaleFirst = options.recoverStaleFirst !== false;

  let recovered = 0;
  if (recoverStaleFirst) {
    const recoverResult = await withWithdrawalTransaction(pool, async (client) =>
      recoverStalePublicPayoutSendingBatch(client, { limit }),
    );
    recovered = recoverResult.recovered;
  }

  const claimed = await withWithdrawalTransaction(pool, async (client) =>
    claimPublicPayoutPublications(client, {
      owner: options.owner,
      environment: options.environment,
      limit,
      leaseSeconds,
    }),
  );

  const delivered: DeliverClaimedPublicPayoutResult[] = [];
  for (const row of claimed) {
    delivered.push(
      await deliverClaimedPublicPayout(pool, options.sender, row, options.environment),
    );
  }

  return { recovered, claimed: claimed.length, delivered };
}
