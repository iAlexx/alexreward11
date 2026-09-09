/**
 * Shared Phase 6 wallet ownership test helpers.
 * Destructive against PHASE6_DATABASE_URL (or PHASE6_WALLET_TESTS=1 + DATABASE_URL).
 */
import { beginCell, storeStateInit, Address } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { buildTonProofSigningDigest } from '@alex-rewards/ton';
import { migrateDatabase } from '@alex-rewards/db';
import { WalletContractV4 } from '@ton/ton';
import { randomBytes } from 'node:crypto';
import { Client, type Pool } from 'pg';

import { localWalletOwnershipFixtureConfig } from '../src/index.js';

const explicitUrl = process.env.PHASE6_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE6_WALLET_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase6DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export const walletConfig = localWalletOwnershipFixtureConfig();

export async function resetAndMigrate(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO PUBLIC');
  } finally {
    await client.end();
  }
  await migrateDatabase(url);
}

export async function createTestUser(pool: Pool, telegramUserId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, preferred_locale)
     VALUES ($1::bigint, 'en')
     RETURNING id`,
    [telegramUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return id;
}

export async function claimFounderForUser(pool: Pool, userId: string): Promise<void> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  await pool.query(
    `INSERT INTO user_memberships (
       user_id, membership_plan_id, status, source, claimed_at, founder_number
     ) VALUES (
       $1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now(),
       nextval('founder_number_seq')
     )
     ON CONFLICT DO NOTHING`,
    [userId, planId],
  );
}

export interface WalletFixture {
  readonly publicKey: Buffer;
  readonly secretKey: Buffer;
  readonly address: string;
  readonly rawAddress: string;
  readonly friendlyAddress: string;
  readonly stateInitBase64: string;
  readonly network: '-3';
}

export function createWalletFixture(seed?: Buffer): WalletFixture {
  const seedBytes = seed ?? randomBytes(32);
  const keyPair = keyPairFromSeed(seedBytes);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const stateInitCell = beginCell().store(storeStateInit(wallet.init)).endCell();
  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    address: `${wallet.address.workChain}:${wallet.address.hash.toString('hex')}`,
    rawAddress: wallet.address.toRawString(),
    friendlyAddress: wallet.address.toString({ urlSafe: true, bounceable: true }),
    stateInitBase64: stateInitCell.toBoc().toString('base64'),
    network: '-3',
  };
}

export function signProof(input: {
  readonly fixture: WalletFixture;
  readonly payload: string;
  readonly domain?: string;
  readonly timestamp?: number;
  readonly domainLengthBytes?: number;
}): {
  timestamp: number;
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string;
  state_init: string;
} {
  const domain = input.domain ?? walletConfig.expectedTonProofDomain;
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const domainLengthBytes = input.domainLengthBytes ?? Buffer.byteLength(domain, 'utf8');
  const digest = buildTonProofSigningDigest({
    workchain: 0,
    addressHash: Buffer.from(input.fixture.address.split(':')[1] ?? '', 'hex'),
    domainValue: domain,
    domainLengthBytes,
    timestamp,
    payload: input.payload,
  });
  return {
    timestamp,
    domain: { lengthBytes: domainLengthBytes, value: domain },
    payload: input.payload,
    signature: sign(digest, input.fixture.secretKey).toString('base64'),
    state_init: input.fixture.stateInitBase64,
  };
}

export function addressVariants(friendly: string): string[] {
  const address = Address.parse(friendly);
  return [
    address.toString({ urlSafe: true, bounceable: true }),
    address.toString({ urlSafe: true, bounceable: false }),
    address.toString({ urlSafe: false, bounceable: true }),
    address.toRawString(),
  ];
}
