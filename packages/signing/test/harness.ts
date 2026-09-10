/**
 * Shared Phase 9 signer test helpers.
 * Destructive against PHASE9_DATABASE_URL (or PHASE9_SIGNER_TESTS=1 + DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';

import { migrateDatabase } from '@alex-rewards/db';
import {
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '@alex-rewards/ledger';
import {
  acquireTestDispatchLease,
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  decideWithdrawal,
  localWithdrawalEngineFixtureConfig,
  seedLockedInitialWithdrawalRules,
} from '@alex-rewards/withdrawals';
import { Client, Pool } from 'pg';

import {
  LocalEphemeralSignPort,
  buildCanonicalSigningMessageAsync,
  deriveWalletV5R1,
  localSigningFixtureConfig,
  type SignerRuntimeConfig,
} from '../src/index.js';

const explicitUrl = process.env.PHASE9_DATABASE_URL ?? '';
const optedInUrl = process.env.PHASE9_SIGNER_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase9DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export const SPIKE_SEED = Buffer.alloc(32, 42);
export const SPIKE_JETTON_WALLET =
  '0:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** Must match resolveSingleTestHotWallet TEST_ONLY_FAKE% filter for quote path. */
export const SPIKE_SIGNER_REFERENCE = 'TEST_ONLY_FAKE_PHASE9_SPIKE';

export function createPool(url: string): Pool {
  return new Pool({ connectionString: url });
}

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
  return result.rows[0]!.id;
}

export async function createOwnerAdmin(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status)
     VALUES ($1, 'Phase9 Owner Admin', 'ACTIVE')
     RETURNING id`,
    [`phase9-admin-${randomUUID()}@example.local`],
  );
  return result.rows[0]!.id;
}

export async function usdtAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT a.id
     FROM assets a
     JOIN networks n ON n.id = a.network_id
     WHERE a.symbol = 'USDT' AND a.status = 'ACTIVE' AND n.code = 'TON_TESTNET'`,
  );
  return result.rows[0]!.id;
}

export async function tonTestnetNetworkId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM networks WHERE code = 'TON_TESTNET'`,
  );
  return result.rows[0]!.id;
}

export async function fundUserAvailable(
  pool: Pool,
  userId: string,
  amountAtomic: string,
): Promise<void> {
  const assetId = await usdtAssetId(pool);
  const key = randomUUID();
  await withLedgerTransaction(pool, async (client) => {
    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'PLATFORM_REWARD_EXPENSE',
      assetId,
    });
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId,
      ownerId: userId,
    });
    await postLedgerTransaction(client, {
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'phase9-fund',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase9-fund',
      idempotencyKey: `${key}-issue`,
      assetId,
      entries: [
        { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic },
        { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic },
      ],
    });
    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId,
      ownerId: userId,
    });
    await postLedgerTransaction(client, {
      transactionType: 'REWARD_MATURITY',
      businessReferenceType: 'phase9-fund-maturity',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase9-fund',
      idempotencyKey: `${key}-mature`,
      assetId,
      entries: [
        { ledgerAccountId: pending.id, direction: 'DEBIT', amountAtomic },
        { ledgerAccountId: available.id, direction: 'CREDIT', amountAtomic },
      ],
    });
  });
}

export async function createVerifiedPrimaryWallet(
  pool: Pool,
  userId: string,
  rawAddress: string,
): Promise<string> {
  const networkId = await tonTestnetNetworkId(pool);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO user_wallets (
       user_id, network_id, raw_address, friendly_address, is_primary, verified,
       verification_method, verified_at, became_primary_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $3, true, true, 'TON_PROOF', now(), now()
     ) RETURNING id`,
    [userId, networkId, rawAddress],
  );
  return result.rows[0]!.id;
}

export interface ProductionShapedAttemptFixture {
  readonly pool: Pool;
  readonly signPort: LocalEphemeralSignPort;
  readonly config: SignerRuntimeConfig;
  readonly withdrawalId: string;
  readonly attemptId: string;
  readonly hotWalletId: string;
  readonly publicKey: Buffer;
  readonly walletAddressRaw: string;
  readonly canonicalMessageHash: string;
}

/**
 * Builds a Phase-9 production-shaped attempt with a REAL canonical hash (not fake-hash:).
 */
export async function createProductionShapedSignableAttempt(
  pool: Pool,
): Promise<ProductionShapedAttemptFixture> {
  const signPort = new LocalEphemeralSignPort(SPIKE_SEED);
  const publicKey = await signPort.getPublicKey();
  const derived = deriveWalletV5R1({ publicKey, networkGlobalId: -3, workchain: 0 });
  const config = localSigningFixtureConfig({
    kmsMode: 'local_ephemeral',
    kmsKeyArn: null,
  });
  const engine = localWithdrawalEngineFixtureConfig();

  await withLedgerTransaction(pool, async (client) => {
    await seedLockedInitialWithdrawalRules(client, {
      assetId: await usdtAssetId(pool),
      networkId: await tonTestnetNetworkId(pool),
    });
  });
  const adminId = await createOwnerAdmin(pool);
  const userId = await createTestUser(pool, String(900_000 + Math.floor(Math.random() * 99_000)));
  const recipientRaw = '0:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  await createVerifiedPrimaryWallet(pool, userId, recipientRaw);
  await fundUserAvailable(pool, userId, '5000000');

  const networkId = await tonTestnetNetworkId(pool);
  const hot = await pool.query<{ id: string }>(
    `INSERT INTO hot_wallets (
       network_id, address, friendly_address, wallet_version, signer_type, signer_reference,
       status, payout_jetton_wallet_address, label
     ) VALUES (
       $1::uuid, $2, $3, 'v5R1', 'KMS', $5,
       'ACTIVE', $4, 'phase9-spike'
     ) RETURNING id`,
    [
      networkId,
      derived.addressRaw,
      derived.addressFriendly,
      SPIKE_JETTON_WALLET,
      SPIKE_SIGNER_REFERENCE,
    ],
  );
  const hotWalletId = hot.rows[0]!.id;

  const quote = await createWithdrawalQuote(pool, engine, {
    authenticatedUserId: userId,
    amountAtomic: '1100000',
  });
  const withdrawal = await createWithdrawalFromQuote(pool, engine, {
    authenticatedUserId: userId,
    quoteId: quote.id,
    idempotencyKey: randomUUID(),
  });

  // Risk may leave MANUAL_REVIEW — force path to APPROVED then QUEUED for signer spike.
  await pool.query(
    `UPDATE withdrawals SET state = 'MANUAL_REVIEW' WHERE id = $1::uuid AND state <> 'MANUAL_REVIEW'`,
    [withdrawal.id],
  );
  await decideWithdrawal(pool, engine, {
    withdrawalId: withdrawal.id,
    expectedState: 'MANUAL_REVIEW',
    decision: 'APPROVE',
    reason: 'phase9-spike-fixture',
    idempotencyKey: `phase9-approve-${withdrawal.id}`,
    adminUserId: adminId,
    decisionSource: 'API',
  });
  await pool.query(
    `UPDATE withdrawals SET state = 'QUEUED', queued_at = now() WHERE id = $1::uuid`,
    [withdrawal.id],
  );

  const wRow = await pool.query<{ net_amount_atomic: string }>(
    `SELECT net_amount_atomic::text AS net_amount_atomic FROM withdrawals WHERE id = $1::uuid`,
    [withdrawal.id],
  );
  const netAmountAtomic = BigInt(wRow.rows[0]!.net_amount_atomic);
  const expectedSeqno = 1;
  const queryId = 424242n;
  const validUntil = new Date(Date.now() + 600_000);

  const master = await pool.query<{ contract_identity: string }>(
    `SELECT contract_identity FROM assets WHERE id = $1::uuid`,
    [await usdtAssetId(pool)],
  );

  const intent = {
    publicKey,
    networkGlobalId: -3 as const,
    workchain: 0,
    subwalletNumber: 0,
    seqno: expectedSeqno,
    validUntil: Math.floor(validUntil.getTime() / 1000),
    queryId,
    netAmountAtomic,
    recipientAddress: recipientRaw,
    hotWalletAddress: derived.addressRaw,
    payoutJettonWalletAddress: SPIKE_JETTON_WALLET,
    jettonMasterIdentity: master.rows[0]!.contract_identity,
  };
  const canonical = await buildCanonicalSigningMessageAsync(intent);

  const fencing = await pool.connect();
  let fencingToken: bigint;
  try {
    await fencing.query('BEGIN');
    const lease = await acquireTestDispatchLease(fencing, hotWalletId, 'phase9-signer-tests');
    fencingToken = lease.fencingToken;
    await fencing.query('COMMIT');
  } catch (error) {
    await fencing.query('ROLLBACK');
    throw error;
  } finally {
    fencing.release();
  }

  const attempt = await pool.query<{ id: string }>(
    `INSERT INTO withdrawal_attempts (
       withdrawal_id, attempt_number, hot_wallet_id, expected_seqno, query_id, valid_until,
       canonical_message_hash, signer_key_reference, dispatch_fencing_token,
       broadcast_result_state, signing_started_at
     ) VALUES (
       $1::uuid, 1, $2::uuid, $3, $4, $5,
       $6, $7, $8,
       'PENDING', now()
     ) RETURNING id`,
    [
      withdrawal.id,
      hotWalletId,
      expectedSeqno,
      queryId.toString(),
      validUntil,
      canonical.canonicalMessageHashHex,
      SPIKE_SIGNER_REFERENCE,
      fencingToken.toString(),
    ],
  );

  return {
    pool,
    signPort,
    config,
    withdrawalId: withdrawal.id,
    attemptId: attempt.rows[0]!.id,
    hotWalletId,
    publicKey,
    walletAddressRaw: derived.addressRaw,
    canonicalMessageHash: canonical.canonicalMessageHashHex,
  };
}
