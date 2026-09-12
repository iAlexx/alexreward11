/**
 * Shared Phase 8 Control Center test helpers.
 * Destructive against PHASE8_DATABASE_URL (or PHASE8_CONTROL_CENTER_TESTS=1 + DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';

import { migrateDatabase } from '@alex-rewards/db';
import {
  checkLedgerInvariants,
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '@alex-rewards/ledger';
import {
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  localWithdrawalEngineFixtureConfig,
  seedLockedInitialWithdrawalRules,
} from '@alex-rewards/withdrawals';
import { Client, Pool } from 'pg';

import {
  CONTROL_CENTER_DESTINATION_PURPOSES,
  localControlCenterFixtureConfig,
  upsertTestDestination,
  type ControlCenterDestinationPurpose,
  type ControlCenterRuntimeConfig,
} from '../src/index.js';

export { upsertTestDestination };

const explicitUrl = process.env.PHASE8_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE8_CONTROL_CENTER_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase8DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export const OWNER_TELEGRAM_USER_ID = '900001';
export const CONTROL_CHAT_ID = '-1009000000001';
export const APPROVALS_TOPIC_ID = '101';

export const engineConfig = localWithdrawalEngineFixtureConfig();
export const ccConfig: ControlCenterRuntimeConfig = localControlCenterFixtureConfig([
  OWNER_TELEGRAM_USER_ID,
]);

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

export async function createTestUser(
  pool: Pool,
  telegramUserId: string,
): Promise<{ userId: string; telegramUserId: string }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO users (telegram_user_id, preferred_locale)
     VALUES ($1::bigint, 'en')
     RETURNING id`,
    [telegramUserId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert failed');
  return { userId: id, telegramUserId };
}

export async function createOwnerAdmin(
  pool: Pool,
  telegramUserId = OWNER_TELEGRAM_USER_ID,
): Promise<{ adminUserId: string; telegramUserId: string }> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status, telegram_user_id)
     VALUES ($1, 'Phase8 Owner', 'ACTIVE', $2::bigint)
     RETURNING id`,
    [`phase8-owner-${randomUUID()}@example.local`, telegramUserId],
  );
  const adminUserId = result.rows[0]?.id;
  if (adminUserId === undefined) throw new Error('admin insert failed');

  const role = await pool.query<{ id: string }>(
    `SELECT id FROM admin_roles WHERE code = 'OWNER' AND status = 'ACTIVE'`,
  );
  const roleId = role.rows[0]?.id;
  if (roleId === undefined) throw new Error('OWNER role missing');

  await pool.query(
    `INSERT INTO admin_role_bindings (admin_user_id, role_id)
     VALUES ($1::uuid, $2::uuid)
     ON CONFLICT DO NOTHING`,
    [adminUserId, roleId],
  );

  return { adminUserId, telegramUserId };
}

export async function seedAllControlCenterDestinations(
  pool: Pool,
  input?: {
    readonly chatId?: string;
    readonly enabled?: boolean;
    readonly environment?: 'LOCAL' | 'DEV' | 'STAGING' | 'PRODUCTION';
  },
): Promise<Record<ControlCenterDestinationPurpose, string>> {
  const chatId = input?.chatId ?? CONTROL_CHAT_ID;
  const enabled = input?.enabled ?? true;
  const environment = input?.environment ?? 'LOCAL';
  const ids = {} as Record<ControlCenterDestinationPurpose, string>;
  let topic = 100;
  for (const purpose of CONTROL_CENTER_DESTINATION_PURPOSES) {
    topic += 1;
    const dest = await upsertTestDestination(pool, {
      environment,
      purpose,
      chatId,
      topicThreadId: String(purpose === 'CONTROL_CENTER_APPROVALS' ? APPROVALS_TOPIC_ID : topic),
      enabled,
      title: purpose,
    });
    ids[purpose] = dest.id;
  }
  return ids;
}

export async function usdtAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT a.id
     FROM assets a
     JOIN networks n ON n.id = a.network_id
     WHERE a.symbol = 'USDT' AND a.status = 'ACTIVE' AND n.code = 'TON_TESTNET'`,
  );
  if ((result.rowCount ?? 0) !== 1) throw new Error('expected ACTIVE TON_TESTNET USDT');
  return result.rows[0]!.id;
}

export async function tonTestnetNetworkId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM networks WHERE code = 'TON_TESTNET'`,
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('TON_TESTNET missing');
  return id;
}

export async function bindVerifiedPrimaryWallet(pool: Pool, userId: string): Promise<string> {
  const netId = await tonTestnetNetworkId(pool);
  const suffix = randomUUID().replace(/-/g, '');
  const raw = `0:${suffix}${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const friendly = `EQ${raw.slice(2, 50)}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO user_wallets (
       user_id, network_id, chain, raw_address, friendly_address,
       is_primary, verified, verification_method, verified_at, became_primary_at
     ) VALUES (
       $1::uuid, $2::uuid, 'TON', $3, $4,
       true, true, 'TON_PROOF', now(), now()
     )
     RETURNING id`,
    [userId, netId, raw, friendly],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('wallet insert failed');
  return id;
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
      businessReferenceType: 'phase8-fund',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase8-fund',
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
      businessReferenceType: 'phase8-fund-maturity',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase8-fund',
      idempotencyKey: `${key}-mature`,
      assetId,
      entries: [
        { ledgerAccountId: pending.id, direction: 'DEBIT', amountAtomic },
        { ledgerAccountId: available.id, direction: 'CREDIT', amountAtomic },
      ],
    });
  });
}

export async function ensureTestHotWallet(pool: Pool): Promise<string> {
  const netId = await tonTestnetNetworkId(pool);
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM hot_wallets
     WHERE network_id = $1::uuid AND status = 'ACTIVE'
       AND signer_reference LIKE 'TEST_ONLY_FAKE%'`,
    [netId],
  );
  if (existing.rows[0] !== undefined) return existing.rows[0].id;
  const address = `0:hot${randomUUID().replace(/-/g, '')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO hot_wallets (
       network_id, address, friendly_address, wallet_version,
       signer_type, signer_reference, status, label
     ) VALUES (
       $1::uuid, $2, $3, 'v5R1',
       'KMS', 'TEST_ONLY_FAKE_HOT_1', 'ACTIVE', 'phase8-test-hot'
     )
     RETURNING id`,
    [netId, address, `EQ${address.slice(2, 50)}`],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('hot wallet insert failed');
  return id;
}

export async function seedPhase8Base(pool: Pool): Promise<{
  adminUserId: string;
  assetId: string;
  networkId: string;
  destinations: Record<ControlCenterDestinationPurpose, string>;
}> {
  const assetId = await usdtAssetId(pool);
  const networkId = await tonTestnetNetworkId(pool);
  await withLedgerTransaction(pool, async (client) =>
    seedLockedInitialWithdrawalRules(client, { assetId, networkId }),
  );
  await ensureTestHotWallet(pool);
  const { adminUserId } = await createOwnerAdmin(pool);
  const destinations = await seedAllControlCenterDestinations(pool);
  return { adminUserId, assetId, networkId, destinations };
}

/** Create MANUAL_REVIEW withdrawal ready for Owner Telegram decide. */
export async function createManualReviewWithdrawal(
  pool: Pool,
  userId: string,
  amountAtomic = '500000',
): Promise<{ withdrawalId: string; state: string }> {
  await fundUserAvailable(pool, userId, '5000000');
  await bindVerifiedPrimaryWallet(pool, userId);
  const quote = await createWithdrawalQuote(pool, engineConfig, {
    authenticatedUserId: userId,
    amountAtomic,
  });
  const withdrawal = await createWithdrawalFromQuote(pool, engineConfig, {
    authenticatedUserId: userId,
    quoteId: quote.id,
    idempotencyKey: randomUUID(),
  });
  // createWithdrawalFromQuote applies V1 risk → MANUAL_REVIEW for ordinary accounts.
  if (withdrawal.state !== 'MANUAL_REVIEW') {
    throw new Error(`expected MANUAL_REVIEW, got ${withdrawal.state}`);
  }
  return { withdrawalId: withdrawal.id, state: withdrawal.state };
}

export async function truncatePhase8Tables(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      review_case_events,
      review_cases,
      admin_action_tokens,
      telegram_publications,
      telegram_destinations,
      membership_grant_events,
      membership_claim_codes,
      user_memberships,
      withdrawal_payout_reconciliations,
      withdrawal_volume_reservations,
      withdrawal_volume_periods,
      withdrawal_attempts,
      withdrawal_approvals,
      withdrawals,
      withdrawal_quotes,
      hot_wallet_dispatch_leases,
      hot_wallets,
      outbox_events,
      audit_logs,
      risk_snapshots,
      membership_plan_entitlements,
      membership_benefit_rule_versions,
      user_wallets,
      ledger_entries,
      ledger_account_balances,
      ledger_transactions,
      ledger_accounts,
      withdrawal_fee_rules,
      withdrawal_limit_rules,
      admin_role_bindings,
      admin_users,
      users
    RESTART IDENTITY CASCADE
  `);
}

export async function assertLedgerUntouchedByFounderGrant(pool: Pool): Promise<void> {
  const ledgerTx = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM ledger_transactions
     WHERE business_reference_type ILIKE '%founder%'
        OR business_reference_type ILIKE '%membership%'`,
  );
  if (Number(ledgerTx.rows[0]?.c ?? '1') !== 0) {
    throw new Error('Founder grant must not create ledger transactions');
  }
  const invariants = await checkLedgerInvariants(pool);
  if (!invariants.ok) {
    throw new Error(
      `ledger invariants failed after founder admin: ${JSON.stringify(invariants.findings)}`,
    );
  }
}

export function approvalsCallbackContext(overrides?: {
  readonly telegramUserId?: string;
  readonly chatId?: string;
  readonly topicThreadId?: string | null;
}) {
  return {
    telegramUserId: overrides?.telegramUserId ?? OWNER_TELEGRAM_USER_ID,
    chatId: overrides?.chatId ?? CONTROL_CHAT_ID,
    topicThreadId:
      overrides?.topicThreadId === undefined ? APPROVALS_TOPIC_ID : overrides.topicThreadId,
  };
}
