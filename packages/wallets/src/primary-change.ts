import type { Redis } from 'ioredis';
import type { PoolClient } from 'pg';

import { insertSecurityAuditLog, insertWalletOutboxEvent } from './audit.js';
import { invalidateOpenWalletChallenges } from './challenge.js';
import { assertWalletOwnershipConfig, type WalletOwnershipConfig } from './config.js';
import { withWalletTransaction, type WalletDb } from './db.js';
import { WalletDomainError } from './errors.js';
import { resolveAcceptedTonNetwork } from './network.js';
import { consumeChallenge, lockOpenChallenge, mapTonError } from './verify-bind.js';
import { verifyTonProof, type TonConnectAccount, type TonProofObject } from '@alex-rewards/ton';

export interface ChangePrimaryWalletInput {
  readonly authenticatedUserId: string;
  readonly account: TonConnectAccount;
  readonly proof: TonProofObject;
  readonly walletName?: string | null;
  readonly now?: Date;
  readonly redis?: Redis;
  readonly traceId?: string | null;
  readonly ipHash?: string | null;
  readonly userAgentSummary?: string | null;
}

export interface PrimaryWalletUnchangedResult {
  readonly primaryChanged: false;
  readonly walletId: string;
  readonly userId: string;
  readonly networkId: string;
  readonly rawAddress: string;
  readonly friendlyAddress: string;
}

export interface PrimaryWalletChangedResult {
  readonly oldWalletId: string;
  readonly newWalletId: string;
  readonly userId: string;
  readonly networkId: string;
  readonly rawAddress: string;
  readonly friendlyAddress: string;
  readonly primaryChanged: true;
  readonly primaryWalletChangedAt: Date;
  readonly withdrawalCooldownUntil: Date;
  readonly auditLogId: string;
  readonly challengesInvalidated: number;
}

export type PrimaryWalletChangeResult = PrimaryWalletUnchangedResult | PrimaryWalletChangedResult;

/**
 * Change primary from A -> B requiring a fresh ton_proof for B.
 * Atomically sets 24h withdrawal cooldown and invalidates open challenges.
 */
export async function changePrimaryWallet(
  db: WalletDb,
  config: WalletOwnershipConfig,
  input: ChangePrimaryWalletInput,
): Promise<PrimaryWalletChangeResult> {
  assertWalletOwnershipConfig(config);
  if (input.authenticatedUserId.trim() === '') {
    throw new WalletDomainError('UNAUTHORIZED', 'Authentication required');
  }

  return withWalletTransaction(db, async (client) =>
    changePrimaryInTransaction(client, config, input),
  );
}

async function changePrimaryInTransaction(
  client: PoolClient,
  config: WalletOwnershipConfig,
  input: ChangePrimaryWalletInput,
): Promise<PrimaryWalletChangeResult> {
  const now = input.now ?? new Date();

  const userLock = await client.query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`,
    [input.authenticatedUserId],
  );
  if (userLock.rowCount === 0) {
    throw new WalletDomainError('UNAUTHORIZED', 'Authentication required');
  }

  const network = await resolveAcceptedTonNetwork(client, {
    acceptedNetworkCode: config.acceptedNetworkCode,
    deploymentEnvironment: config.deploymentEnvironment,
  });

  const currentPrimary = await client.query<{
    id: string;
    raw_address: string;
  }>(
    `SELECT id, raw_address FROM user_wallets
     WHERE user_id = $1::uuid AND network_id = $2::uuid
       AND is_primary = true AND disabled_at IS NULL
     FOR UPDATE`,
    [input.authenticatedUserId, network.id],
  );
  const oldPrimary = currentPrimary.rows[0];
  if (oldPrimary === undefined) {
    throw new WalletDomainError(
      'PRIMARY_REQUIRED',
      'Primary wallet change requires a verified wallet',
    );
  }

  const nonce = await lockOpenChallenge(client, {
    authenticatedUserId: input.authenticatedUserId,
    networkId: network.id,
    payload: input.proof.payload,
    now,
  });

  let verified;
  try {
    verified = verifyTonProof({
      account: input.account,
      proof: input.proof,
      expectedDomain: config.expectedTonProofDomain,
      expectedPayload: input.proof.payload,
      expectedNetwork: network.tonConnectNetworkId,
      nowUnixSeconds: Math.floor(now.getTime() / 1000),
      maxAgeSeconds: config.maxProofAgeSeconds,
      maxFutureSkewSeconds: config.maxFutureSkewSeconds,
    });
  } catch (error) {
    throw mapTonError(error);
  }

  if (verified.canonical.rawAddress === oldPrimary.raw_address) {
    // Re-proof of current primary: consume challenge, refresh verification, do NOT change cooldown.
    const walletName =
      input.walletName === undefined || input.walletName === null
        ? null
        : String(input.walletName).slice(0, 64);
    await client.query(
      `UPDATE user_wallets
       SET verified = true,
           verification_method = 'TON_PROOF',
           verified_at = COALESCE(verified_at, $2::timestamptz),
           friendly_address = $3,
           wallet_name = COALESCE($4, wallet_name),
           last_used_at = $2::timestamptz,
           updated_at = now()
       WHERE id = $1::uuid`,
      [oldPrimary.id, now.toISOString(), verified.canonical.friendlyAddress, walletName],
    );
    await consumeChallenge(client, nonce.id, oldPrimary.id, now);
    return {
      primaryChanged: false,
      walletId: oldPrimary.id,
      userId: input.authenticatedUserId,
      networkId: network.id,
      rawAddress: verified.canonical.rawAddress,
      friendlyAddress: verified.canonical.friendlyAddress,
    };
  }

  const walletName =
    input.walletName === undefined || input.walletName === null
      ? null
      : String(input.walletName).slice(0, 64);

  const upsert = await client.query<{
    id: string;
    raw_address: string;
    friendly_address: string;
  }>(
    `INSERT INTO user_wallets (
       user_id, network_id, chain, raw_address, friendly_address, wallet_name,
       is_primary, verified, verification_method, verified_at, last_used_at
     ) VALUES (
       $1::uuid, $2::uuid, 'TON', $3, $4, $5,
       false, true, 'TON_PROOF', $6::timestamptz, $6::timestamptz
     )
     ON CONFLICT (user_id, network_id, raw_address) DO UPDATE
       SET friendly_address = EXCLUDED.friendly_address,
           wallet_name = COALESCE(EXCLUDED.wallet_name, user_wallets.wallet_name),
           verified = true,
           verification_method = 'TON_PROOF',
           verified_at = COALESCE(user_wallets.verified_at, EXCLUDED.verified_at),
           last_used_at = EXCLUDED.last_used_at,
           disabled_at = NULL,
           updated_at = now()
     RETURNING id, raw_address, friendly_address`,
    [
      input.authenticatedUserId,
      network.id,
      verified.canonical.rawAddress,
      verified.canonical.friendlyAddress,
      walletName,
      now.toISOString(),
    ],
  );
  const newWallet = upsert.rows[0];
  if (newWallet === undefined) {
    throw new WalletDomainError('INTERNAL', 'Wallet upsert failed');
  }

  await client.query(
    `UPDATE user_wallets
     SET is_primary = false, updated_at = now()
     WHERE id = $1::uuid`,
    [oldPrimary.id],
  );

  await client.query(
    `UPDATE user_wallets
     SET is_primary = true, became_primary_at = $2::timestamptz, updated_at = now()
     WHERE id = $1::uuid`,
    [newWallet.id, now.toISOString()],
  );

  const cooldownUntil = new Date(now.getTime() + config.withdrawalCooldownHours * 60 * 60 * 1000);
  await client.query(
    `UPDATE users
     SET primary_wallet_changed_at = $2::timestamptz,
         withdrawal_cooldown_until = $3::timestamptz,
         updated_at = now()
     WHERE id = $1::uuid`,
    [input.authenticatedUserId, now.toISOString(), cooldownUntil.toISOString()],
  );

  await consumeChallenge(client, nonce.id, newWallet.id, now);

  const invalidated = await invalidateOpenWalletChallenges(client, {
    userId: input.authenticatedUserId,
    networkId: network.id,
    reason: 'PRIMARY_WALLET_CHANGED',
    now,
  });

  const auditLogId = await insertSecurityAuditLog(client, {
    actionType: 'PRIMARY_WALLET_CHANGED',
    resourceType: 'user',
    resourceId: input.authenticatedUserId,
    afterSnapshot: {
      userId: input.authenticatedUserId,
      networkId: network.id,
      networkCode: network.code,
      oldWalletId: oldPrimary.id,
      newWalletId: newWallet.id,
      eventTimestamp: now.toISOString(),
      cooldownUntil: cooldownUntil.toISOString(),
      challengesInvalidated: invalidated,
    },
    reason: 'Primary wallet changed; withdrawal cooldown started',
    traceId: input.traceId ?? null,
    ipHash: input.ipHash ?? null,
    userAgentSummary: input.userAgentSummary ?? null,
  });

  await insertWalletOutboxEvent(client, {
    aggregateType: 'user',
    aggregateId: input.authenticatedUserId,
    eventType: 'primary_wallet.changed',
    dedupeKey: `primary_wallet.changed:${input.authenticatedUserId}:${network.id}:${nonce.id}`,
    payload: {
      userId: input.authenticatedUserId,
      networkId: network.id,
      oldWalletId: oldPrimary.id,
      newWalletId: newWallet.id,
      cooldownUntil: cooldownUntil.toISOString(),
      auditLogId,
    },
    traceId: input.traceId ?? null,
  });

  return {
    oldWalletId: oldPrimary.id,
    newWalletId: newWallet.id,
    userId: input.authenticatedUserId,
    networkId: network.id,
    rawAddress: newWallet.raw_address,
    friendlyAddress: newWallet.friendly_address,
    primaryChanged: true,
    primaryWalletChangedAt: now,
    withdrawalCooldownUntil: cooldownUntil,
    auditLogId,
    challengesInvalidated: invalidated,
  };
}

export type { TonConnectAccount, TonProofObject };
