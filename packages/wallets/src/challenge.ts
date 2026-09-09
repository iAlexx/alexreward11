import { createHash, randomBytes } from 'node:crypto';

import { AuthDomainError, consumeThrottle } from '@alex-rewards/auth';
import type { Redis } from 'ioredis';
import type { PoolClient } from 'pg';

import { assertWalletOwnershipConfig, type WalletOwnershipConfig } from './config.js';
import { withWalletTransaction, type WalletDb } from './db.js';
import { WalletDomainError } from './errors.js';
import { resolveAcceptedTonNetwork } from './network.js';

export interface CreateTonProofChallengeInput {
  /** Authoritative session user — never trust client userId. */
  readonly authenticatedUserId: string;
  readonly now?: Date;
  readonly redis?: Redis;
}

export interface TonProofChallenge {
  readonly challengeId: string;
  readonly challenge: string;
  readonly networkCode: string;
  readonly networkId: string;
  readonly tonConnectNetworkId: string;
  readonly expiresAt: Date;
  readonly issuedAt: Date;
  readonly expectedDomain: string;
}

export function hashChallenge(rawChallenge: string): string {
  return createHash('sha256').update(rawChallenge, 'utf8').digest('hex');
}

/** CSPRNG challenge — never UUID/time/counter-only. */
export function generateRawChallenge(): string {
  return randomBytes(32).toString('base64url');
}

export async function createTonProofChallenge(
  db: WalletDb,
  config: WalletOwnershipConfig,
  input: CreateTonProofChallengeInput,
): Promise<TonProofChallenge> {
  assertWalletOwnershipConfig(config);
  if (input.authenticatedUserId.trim() === '') {
    throw new WalletDomainError('UNAUTHORIZED', 'Authentication required');
  }

  if (config.challengeThrottle !== undefined) {
    if (input.redis === undefined) {
      throw new WalletDomainError('INTERNAL', 'Abuse protection unavailable');
    }
    try {
      await consumeThrottle(input.redis, config.challengeThrottle, input.authenticatedUserId);
    } catch (error) {
      if (error instanceof AuthDomainError && error.code === 'RATE_LIMITED') {
        throw new WalletDomainError('RATE_LIMITED', 'Too many attempts. Try again later.', {
          cause: error,
        });
      }
      throw new WalletDomainError('INTERNAL', 'Abuse protection unavailable', { cause: error });
    }
  }

  return withWalletTransaction(db, async (client) => {
    await assertUserExists(client, input.authenticatedUserId);
    const network = await resolveAcceptedTonNetwork(client, {
      acceptedNetworkCode: config.acceptedNetworkCode,
      deploymentEnvironment: config.deploymentEnvironment,
    });

    const rawChallenge = generateRawChallenge();
    const nonceHash = hashChallenge(rawChallenge);
    const issuedAt = input.now ?? new Date();
    const expiresAt = new Date(issuedAt.getTime() + config.challengeTtlSeconds * 1000);

    const inserted = await client.query<{ id: string; issued_at: Date; expires_at: Date }>(
      `INSERT INTO user_wallet_proof_nonces (
         user_id, network_id, nonce_hash, issued_at, expires_at
       ) VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz)
       RETURNING id, issued_at, expires_at`,
      [
        input.authenticatedUserId,
        network.id,
        nonceHash,
        issuedAt.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new WalletDomainError('INTERNAL', 'Challenge creation failed');
    }

    return {
      challengeId: row.id,
      challenge: rawChallenge,
      networkCode: network.code,
      networkId: network.id,
      tonConnectNetworkId: network.tonConnectNetworkId,
      expiresAt: row.expires_at,
      issuedAt: row.issued_at,
      expectedDomain: config.expectedTonProofDomain,
    };
  });
}

export async function invalidateOpenWalletChallenges(
  client: PoolClient,
  input: {
    readonly userId: string;
    readonly networkId: string;
    readonly reason: string;
    readonly now?: Date;
  },
): Promise<number> {
  const now = input.now ?? new Date();
  const result = await client.query(
    `UPDATE user_wallet_proof_nonces
     SET invalidated_at = $3::timestamptz,
         invalidation_reason = $4
     WHERE user_id = $1::uuid
       AND network_id = $2::uuid
       AND consumed_at IS NULL
       AND invalidated_at IS NULL`,
    [input.userId, input.networkId, now.toISOString(), input.reason],
  );
  return result.rowCount ?? 0;
}

async function assertUserExists(client: PoolClient, userId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM users WHERE id = $1::uuid FOR SHARE`, [userId]);
  if (result.rowCount === 0) {
    throw new WalletDomainError('UNAUTHORIZED', 'Authentication required');
  }
}
