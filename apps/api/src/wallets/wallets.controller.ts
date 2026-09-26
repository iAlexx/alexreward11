import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Ip,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { hashIp, summarizeUserAgent } from '@alex-rewards/auth';
import type { ApiConfig } from '@alex-rewards/config';
import type {
  TonProofBindResponse,
  TonProofChallengeResponse,
  UserWalletDto,
  WalletSummaryResponse,
} from '@alex-rewards/contracts';
import type { Pool } from '@alex-rewards/db';
import { createTonProofChallenge, verifyTonProofAndBindWallet } from '@alex-rewards/wallets';

import {
  AccessSessionGuard,
  CurrentAuthUser,
  type AuthenticatedRequestUser,
} from '../auth/access-session.guard.js';
import { API_CONFIG, DATABASE_POOL, REDIS_CLIENT } from '../tokens.js';

import { mapWalletError, parseTonProofBindBody, walletOwnershipConfigFromApi } from './http.js';

interface WalletRow {
  id: string;
  chain: string;
  network_code: string;
  friendly_address: string;
  wallet_name: string | null;
  is_primary: boolean;
  verified: boolean;
  verification_method: UserWalletDto['verificationMethod'];
  verified_at: Date | null;
  became_primary_at: Date | null;
  disabled_at: Date | null;
}

function mapWallet(row: WalletRow): UserWalletDto {
  return {
    id: row.id,
    chain: row.chain,
    networkCode: row.network_code,
    friendlyAddress: row.friendly_address,
    walletName: row.wallet_name,
    isPrimary: row.is_primary,
    verified: row.verified,
    verificationMethod: row.verification_method,
    verifiedAt: row.verified_at?.toISOString() ?? null,
    becamePrimaryAt: row.became_primary_at?.toISOString() ?? null,
    disabledAt: row.disabled_at?.toISOString() ?? null,
  };
}

/**
 * Phase 12 user-facing wallet surface.
 *
 * A thin HTTP shell over the Phase 6 ownership domain: the challenge is server-generated
 * and single-use, and binding is decided entirely by `verifyTonProofAndBindWallet`. The
 * client never selects the network, the proof domain or the verification outcome, and no
 * endpoint here moves money or changes withdrawal eligibility by itself.
 */
@Controller('v1/wallets')
@UseGuards(AccessSessionGuard)
export class WalletsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  @Get()
  async listWallets(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<WalletSummaryResponse> {
    try {
      const wallets = await this.pool.query<WalletRow>(
        `SELECT w.id,
                w.chain,
                n.code AS network_code,
                w.friendly_address,
                w.wallet_name,
                w.is_primary,
                w.verified,
                w.verification_method::text AS verification_method,
                w.verified_at,
                w.became_primary_at,
                w.disabled_at
         FROM user_wallets w
         JOIN networks n ON n.id = w.network_id
         WHERE w.user_id = $1::uuid
         ORDER BY w.is_primary DESC, w.created_at`,
        [auth.userId],
      );
      const cooldown = await this.pool.query<{ withdrawal_cooldown_until: Date | null }>(
        `SELECT withdrawal_cooldown_until FROM users WHERE id = $1::uuid`,
        [auth.userId],
      );
      const items = wallets.rows.map(mapWallet);
      const primary = items.find((wallet) => wallet.isPrimary && wallet.disabledAt === null);
      return {
        status: items.length === 0 ? 'EMPTY' : 'READY',
        wallets: items,
        primaryWalletId: primary?.id ?? null,
        acceptedNetworkCode: this.config.WITHDRAWAL_NETWORK_CODE,
        withdrawalCooldownUntil: cooldown.rows[0]?.withdrawal_cooldown_until?.toISOString() ?? null,
      };
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  @Post('ton-proof/challenge')
  @HttpCode(200)
  async createChallenge(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
  ): Promise<TonProofChallengeResponse> {
    try {
      const challenge = await createTonProofChallenge(
        this.pool,
        walletOwnershipConfigFromApi(this.config),
        { authenticatedUserId: auth.userId, redis: this.redis },
      );
      return {
        challenge: challenge.challenge,
        expiresAt: challenge.expiresAt.toISOString(),
        networkCode: challenge.networkCode,
        tonConnectNetworkId: challenge.tonConnectNetworkId,
        expectedDomain: challenge.expectedDomain,
      };
    } catch (error) {
      throw mapWalletError(error);
    }
  }

  @Post('ton-proof/bind')
  @HttpCode(200)
  async bindWallet(
    @CurrentAuthUser() auth: AuthenticatedRequestUser,
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ): Promise<TonProofBindResponse> {
    const { account, proof, walletName } = parseTonProofBindBody(body);
    try {
      const bound = await verifyTonProofAndBindWallet(
        this.pool,
        walletOwnershipConfigFromApi(this.config),
        {
          authenticatedUserId: auth.userId,
          account,
          proof,
          walletName,
          redis: this.redis,
          ipHash: hashIp(ip),
          userAgentSummary: summarizeUserAgent(userAgent),
        },
      );
      return {
        walletId: bound.walletId,
        friendlyAddress: bound.friendlyAddress,
        verified: true,
        verificationMethod: 'TON_PROOF',
        verifiedAt: bound.verifiedAt.toISOString(),
        isPrimary: bound.isPrimary,
        becamePrimary: bound.becamePrimary,
      };
    } catch (error) {
      throw mapWalletError(error);
    }
  }
}
