import { AuthDomainError, consumeThrottle } from '@alex-rewards/auth';
import {
  TonDomainError,
  verifyTonProof,
  type TonConnectAccount,
  type TonProofObject,
} from '@alex-rewards/ton';
import type { Redis } from 'ioredis';
import type { PoolClient } from 'pg';

import { insertSecurityAuditLog, insertWalletOutboxEvent } from './audit.js';
import { hashChallenge, invalidateOpenWalletChallenges } from './challenge.js';
import { assertWalletOwnershipConfig, type WalletOwnershipConfig } from './config.js';
import { withWalletTransaction, type WalletDb } from './db.js';
import { WalletDomainError } from './errors.js';
import { resolveAcceptedTonNetwork, type AcceptedNetwork } from './network.js';

export interface VerifyTonProofAndBindWalletInput {
  readonly authenticatedUserId: string;
  readonly account: TonConnectAccount;
  readonly proof: TonProofObject;
  /** Display-only; never treated as security evidence. */
  readonly walletName?: string | null;
  readonly setPrimaryIfFirst?: boolean;
  readonly now?: Date;
  readonly redis?: Redis;
  readonly traceId?: string | null;
  readonly ipHash?: string | null;
  readonly userAgentSummary?: string | null;
}

export interface BoundWalletResult {
  readonly walletId: string;
  readonly userId: string;
  readonly networkId: string;
  readonly rawAddress: string;
  readonly friendlyAddress: string;
  readonly verified: true;
  readonly verificationMethod: 'TON_PROOF';
  readonly verifiedAt: Date;
  readonly isPrimary: boolean;
  readonly becamePrimary: boolean;
  readonly primaryChanged: false;
  readonly challengeId: string;
}

export async function verifyTonProofAndBindWallet(
  db: WalletDb,
  config: WalletOwnershipConfig,
  input: VerifyTonProofAndBindWalletInput,
): Promise<BoundWalletResult> {
  assertWalletOwnershipConfig(config);
  if (input.authenticatedUserId.trim() === '') {
    throw new WalletDomainError('UNAUTHORIZED', 'Authentication required');
  }

  await applyVerifyThrottle(config, input);

  try {
    return await withWalletTransaction(db, async (client) =>
      verifyAndBindInTransaction(client, config, input),
    );
  } catch (error) {
    await noteInvalidProofThrottle(config, input, error);
    throw error;
  }
}

async function applyVerifyThrottle(
  config: WalletOwnershipConfig,
  input: VerifyTonProofAndBindWalletInput,
): Promise<void> {
  if (config.verifyThrottle === undefined) return;
  if (input.redis === undefined) {
    throw new WalletDomainError('INTERNAL', 'Abuse protection unavailable');
  }
  try {
    await consumeThrottle(input.redis, config.verifyThrottle, input.authenticatedUserId);
  } catch (error) {
    mapThrottleError(error);
  }
}

async function noteInvalidProofThrottle(
  config: WalletOwnershipConfig,
  input: VerifyTonProofAndBindWalletInput,
  error: unknown,
): Promise<void> {
  if (!(error instanceof WalletDomainError)) return;
  if (
    error.code !== 'INVALID_PROOF' &&
    error.code !== 'INVALID_DOMAIN' &&
    error.code !== 'INVALID_WALLET' &&
    error.code !== 'INVALID_ADDRESS' &&
    error.code !== 'CHALLENGE_EXPIRED' &&
    error.code !== 'CHALLENGE_CONSUMED' &&
    error.code !== 'CHALLENGE_INVALIDATED' &&
    error.code !== 'REPLAY' &&
    error.code !== 'CHALLENGE_NOT_FOUND'
  ) {
    return;
  }
  if (config.invalidProofThrottle === undefined || input.redis === undefined) return;
  try {
    await consumeThrottle(input.redis, config.invalidProofThrottle, input.authenticatedUserId);
  } catch {
    // Do not mask the original proof rejection with throttle failure.
  }
}

function mapThrottleError(error: unknown): never {
  if (error instanceof AuthDomainError && error.code === 'RATE_LIMITED') {
    throw new WalletDomainError('RATE_LIMITED', 'Too many attempts. Try again later.', {
      cause: error,
    });
  }
  throw new WalletDomainError('INTERNAL', 'Abuse protection unavailable', { cause: error });
}

async function verifyAndBindInTransaction(
  client: PoolClient,
  config: WalletOwnershipConfig,
  input: VerifyTonProofAndBindWalletInput,
): Promise<BoundWalletResult> {
  await client
    .query(`SELECT id FROM users WHERE id = $1::uuid FOR UPDATE`, [input.authenticatedUserId])
    .then((r) => {
      if (r.rowCount === 0) {
        throw new WalletDomainError('UNAUTHORIZED', 'Authentication required');
      }
    });

  const network = await resolveAcceptedTonNetwork(client, {
    acceptedNetworkCode: config.acceptedNetworkCode,
    deploymentEnvironment: config.deploymentEnvironment,
  });

  const nonce = await lockOpenChallenge(client, {
    authenticatedUserId: input.authenticatedUserId,
    networkId: network.id,
    payload: input.proof.payload,
    now: input.now ?? new Date(),
  });

  const verified = verifyProofOrMap(config, network, input);

  const now = input.now ?? new Date();
  const walletName =
    input.walletName === undefined || input.walletName === null
      ? null
      : String(input.walletName).slice(0, 64);

  const wallet = await upsertVerifiedWallet(client, {
    userId: input.authenticatedUserId,
    networkId: network.id,
    rawAddress: verified.canonical.rawAddress,
    friendlyAddress: verified.canonical.friendlyAddress,
    walletName,
    now,
  });

  let becamePrimary = false;
  let isPrimary = wallet.is_primary;
  if ((input.setPrimaryIfFirst ?? true) && !wallet.is_primary) {
    const existingPrimary = await client.query<{ id: string }>(
      `SELECT id FROM user_wallets
       WHERE user_id = $1::uuid AND network_id = $2::uuid
         AND is_primary = true AND disabled_at IS NULL
       FOR UPDATE`,
      [input.authenticatedUserId, network.id],
    );
    if (existingPrimary.rowCount === 0) {
      await client.query(
        `UPDATE user_wallets
         SET is_primary = true, became_primary_at = $2::timestamptz, updated_at = now()
         WHERE id = $1::uuid`,
        [wallet.id, now.toISOString()],
      );
      becamePrimary = true;
      isPrimary = true;
      // First wallet is not a primary-wallet *change* — no 24h cooldown.
    }
  }

  await consumeChallenge(client, nonce.id, wallet.id, now);

  await insertSecurityAuditLog(client, {
    actionType: 'WALLET_VERIFIED',
    resourceType: 'user_wallet',
    resourceId: wallet.id,
    afterSnapshot: {
      userId: input.authenticatedUserId,
      networkId: network.id,
      networkCode: network.code,
      walletId: wallet.id,
      becamePrimary,
      verificationMethod: 'TON_PROOF',
    },
    reason: 'ton_proof ownership verified',
    traceId: input.traceId ?? null,
    ipHash: input.ipHash ?? null,
    userAgentSummary: input.userAgentSummary ?? null,
  });

  await insertWalletOutboxEvent(client, {
    aggregateType: 'user_wallet',
    aggregateId: wallet.id,
    eventType: 'wallet.verified',
    dedupeKey: `wallet.verified:${wallet.id}:${nonce.id}`,
    payload: {
      userId: input.authenticatedUserId,
      networkId: network.id,
      walletId: wallet.id,
      becamePrimary,
    },
    traceId: input.traceId ?? null,
  });

  return {
    walletId: wallet.id,
    userId: input.authenticatedUserId,
    networkId: network.id,
    rawAddress: wallet.raw_address,
    friendlyAddress: wallet.friendly_address,
    verified: true,
    verificationMethod: 'TON_PROOF',
    verifiedAt: wallet.verified_at ?? now,
    isPrimary,
    becamePrimary,
    primaryChanged: false,
    challengeId: nonce.id,
  };
}

export interface ChallengeRow {
  readonly id: string;
  readonly user_id: string;
  readonly network_id: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly invalidated_at: Date | null;
}

export async function lockOpenChallenge(
  client: PoolClient,
  input: {
    readonly authenticatedUserId: string;
    readonly networkId: string;
    readonly payload: string;
    readonly now: Date;
  },
): Promise<ChallengeRow> {
  if (typeof input.payload !== 'string' || input.payload.trim() === '') {
    throw new WalletDomainError('INVALID_PROOF', 'Wallet ownership proof was rejected');
  }
  const nonceHash = hashChallenge(input.payload);
  const result = await client.query<ChallengeRow>(
    `SELECT id, user_id, network_id, expires_at, consumed_at, invalidated_at
     FROM user_wallet_proof_nonces
     WHERE nonce_hash = $1
     FOR UPDATE`,
    [nonceHash],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new WalletDomainError('CHALLENGE_NOT_FOUND', 'Wallet ownership proof was rejected');
  }
  if (row.user_id !== input.authenticatedUserId) {
    throw new WalletDomainError('CHALLENGE_NOT_FOUND', 'Wallet ownership proof was rejected', {
      details: { reason: 'USER_MISMATCH' },
    });
  }
  if (row.network_id !== input.networkId) {
    throw new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
      details: { reason: 'CHALLENGE_NETWORK_MISMATCH' },
    });
  }
  if (row.consumed_at !== null) {
    throw new WalletDomainError('REPLAY', 'Wallet ownership proof was rejected', {
      details: { reason: 'CHALLENGE_CONSUMED' },
    });
  }
  if (row.invalidated_at !== null) {
    throw new WalletDomainError('CHALLENGE_INVALIDATED', 'Wallet ownership proof was rejected');
  }
  if (row.expires_at.getTime() <= input.now.getTime()) {
    throw new WalletDomainError('CHALLENGE_EXPIRED', 'Wallet ownership proof was rejected');
  }
  return row;
}

export async function consumeChallenge(
  client: PoolClient,
  challengeId: string,
  walletId: string,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE user_wallet_proof_nonces
     SET consumed_at = $2::timestamptz,
         consumed_wallet_id = $3::uuid
     WHERE id = $1::uuid
       AND consumed_at IS NULL
       AND invalidated_at IS NULL`,
    [challengeId, now.toISOString(), walletId],
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new WalletDomainError('REPLAY', 'Wallet ownership proof was rejected');
  }
}

interface WalletRow {
  id: string;
  raw_address: string;
  friendly_address: string;
  is_primary: boolean;
  verified_at: Date | null;
}

async function upsertVerifiedWallet(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly networkId: string;
    readonly rawAddress: string;
    readonly friendlyAddress: string;
    readonly walletName: string | null;
    readonly now: Date;
  },
): Promise<WalletRow> {
  const result = await client.query<WalletRow>(
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
     RETURNING id, raw_address, friendly_address, is_primary, verified_at`,
    [
      input.userId,
      input.networkId,
      input.rawAddress,
      input.friendlyAddress,
      input.walletName,
      input.now.toISOString(),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new WalletDomainError('INTERNAL', 'Wallet upsert failed');
  }
  return row;
}

function verifyProofOrMap(
  config: WalletOwnershipConfig,
  network: AcceptedNetwork,
  input: VerifyTonProofAndBindWalletInput,
): ReturnType<typeof verifyTonProof> {
  const nowUnix = Math.floor((input.now ?? new Date()).getTime() / 1000);
  try {
    return verifyTonProof({
      account: input.account,
      proof: input.proof,
      expectedDomain: config.expectedTonProofDomain,
      expectedPayload: input.proof.payload,
      expectedNetwork: network.tonConnectNetworkId,
      nowUnixSeconds: nowUnix,
      maxAgeSeconds: config.maxProofAgeSeconds,
      maxFutureSkewSeconds: config.maxFutureSkewSeconds,
    });
  } catch (error) {
    throw mapTonError(error);
  }
}

export function mapTonError(error: unknown): WalletDomainError {
  if (error instanceof WalletDomainError) return error;
  if (error instanceof TonDomainError) {
    const tonError = error;
    switch (tonError.code) {
      case 'INVALID_DOMAIN':
        return tonError.details === undefined
          ? new WalletDomainError('INVALID_DOMAIN', 'Wallet ownership proof was rejected', {
              cause: tonError,
            })
          : new WalletDomainError('INVALID_DOMAIN', 'Wallet ownership proof was rejected', {
              cause: tonError,
              details: tonError.details,
            });
      case 'INVALID_NETWORK':
        return tonError.details === undefined
          ? new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', { cause: tonError })
          : new WalletDomainError('INVALID_NETWORK', 'Network is not accepted', {
              cause: tonError,
              details: tonError.details,
            });
      case 'INVALID_WALLET':
        return tonError.details === undefined
          ? new WalletDomainError('INVALID_WALLET', 'Wallet ownership proof was rejected', {
              cause: tonError,
            })
          : new WalletDomainError('INVALID_WALLET', 'Wallet ownership proof was rejected', {
              cause: tonError,
              details: tonError.details,
            });
      case 'INVALID_ADDRESS':
        return new WalletDomainError('INVALID_ADDRESS', 'Wallet ownership proof was rejected', {
          cause: tonError,
        });
      case 'STALE_PROOF':
      case 'FUTURE_PROOF':
      case 'INVALID_PROOF':
      case 'VALIDATION':
        return new WalletDomainError('INVALID_PROOF', 'Wallet ownership proof was rejected', {
          cause: tonError,
          details: { tonCode: tonError.code, ...(tonError.details ?? {}) },
        });
      default:
        return new WalletDomainError('INTERNAL', 'Wallet verification is temporarily unavailable', {
          cause: tonError,
        });
    }
  }
  return new WalletDomainError('INTERNAL', 'Wallet verification is temporarily unavailable', {
    cause: error,
  });
}

export { invalidateOpenWalletChallenges };
