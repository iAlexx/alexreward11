/**
 * Shared Phase 7 withdrawal-engine test helpers.
 * Destructive against PHASE7_DATABASE_URL (or PHASE7_WITHDRAWAL_TESTS=1 + DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';

import { migrateDatabase } from '@alex-rewards/db';
import {
  checkLedgerInvariants,
  compareProjectionsToStored,
  getOrCreateLedgerAccount,
  postLedgerTransaction,
  withLedgerTransaction,
} from '@alex-rewards/ledger';
import { Client, type Pool, type PoolClient } from 'pg';

import {
  createWithdrawalFromQuote,
  createWithdrawalQuote,
  decideWithdrawal,
  localWithdrawalEngineFixtureConfig,
  seedLockedInitialWithdrawalRules,
  type WithdrawalEngineConfig,
} from '../src/index.js';

const explicitUrl = process.env.PHASE7_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE7_WITHDRAWAL_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
export const phase7DatabaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

export const engineConfig = localWithdrawalEngineFixtureConfig();
/** @deprecated Prefer engineConfig — kept for existing call sites. */
export const withdrawalConfig = engineConfig;

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

export async function createOwnerAdmin(pool: Pool, email?: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO admin_users (email, display_name, status)
     VALUES ($1, 'Phase7 Owner Admin', 'ACTIVE')
     RETURNING id`,
    [email ?? `phase7-admin-${randomUUID()}@example.local`],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('admin insert failed');
  return id;
}

/** @deprecated Prefer createOwnerAdmin */
export const createTestAdmin = createOwnerAdmin;

export async function usdtAssetId(pool: Pool): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT a.id
     FROM assets a
     JOIN networks n ON n.id = a.network_id
     WHERE a.symbol = 'USDT'
       AND a.status = 'ACTIVE'
       AND n.code = 'TON_TESTNET'`,
  );
  if ((result.rowCount ?? 0) !== 1) {
    throw new Error('expected exactly one ACTIVE TON_TESTNET USDT asset');
  }
  return result.rows[0]!.id;
}

export async function networkId(pool: Pool, code = 'TON_TESTNET'): Promise<string> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM networks WHERE code = $1`, [
    code,
  ]);
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`${code} network missing`);
  return id;
}

export async function tonTestnetNetworkId(pool: Pool): Promise<string> {
  return networkId(pool, 'TON_TESTNET');
}

export async function balanceOf(pool: Pool, accountId: string): Promise<bigint> {
  const result = await pool.query<{ balance_atomic: string }>(
    `SELECT balance_atomic::text AS balance_atomic
     FROM ledger_account_balances WHERE ledger_account_id = $1`,
    [accountId],
  );
  return BigInt(result.rows[0]?.balance_atomic ?? '0');
}

export async function userBucketBalance(
  pool: Pool,
  userId: string,
  assetId: string,
  accountType: 'USER_AVAILABLE_LIABILITY' | 'USER_RESERVED_LIABILITY' | 'USER_PENDING_LIABILITY',
): Promise<bigint> {
  const result = await pool.query<{ balance_atomic: string }>(
    `SELECT b.balance_atomic::text AS balance_atomic
     FROM ledger_accounts a
     JOIN ledger_account_balances b ON b.ledger_account_id = a.id
     WHERE a.owner_id = $1::uuid AND a.asset_id = $2::uuid AND a.account_type = $3`,
    [userId, assetId, accountType],
  );
  return BigInt(result.rows[0]?.balance_atomic ?? '0');
}

export async function platformAccountBalance(
  pool: Pool,
  accountType: string,
  assetId: string,
  ownerId?: string,
): Promise<bigint> {
  const result = await pool.query<{ balance_atomic: string }>(
    `SELECT b.balance_atomic::text AS balance_atomic
     FROM ledger_accounts a
     JOIN ledger_account_balances b ON b.ledger_account_id = a.id
     WHERE a.account_type = $1::ledger_account_type
       AND a.asset_id = $2::uuid
       AND (($3::uuid IS NULL AND a.owner_id IS NULL) OR a.owner_id = $3::uuid)`,
    [accountType, assetId, ownerId ?? null],
  );
  return BigInt(result.rows[0]?.balance_atomic ?? '0');
}

export async function assertLedgerBalanced(pool: Pool): Promise<void> {
  const invariants = await checkLedgerInvariants(pool);
  if (!invariants.ok) {
    const projection = invariants.findings
      .filter((f) => f.code === 'PROJECTION_MISMATCH')
      .slice(0, 3)
      .map((f) => f.details);
    throw new Error(
      `ledger invariants failed: ${invariants.findings.map((f) => f.code).join(',')}` +
        (projection.length > 0 ? `; ${JSON.stringify(projection)}` : ''),
    );
  }
  const comparison = await compareProjectionsToStored(pool);
  if (!comparison.ok) {
    throw new Error(`projection rebuild mismatch count=${comparison.mismatches.length}`);
  }
}

/**
 * Credit USER_AVAILABLE via REWARD_ISSUANCE + REWARD_MATURITY (ledger-authoritative).
 * Prefer `(pool, userId, amountAtomic)` form; object form kept for call-site flexibility.
 */
export async function fundUserAvailable(
  poolOrInput:
    | Pool
    | {
        pool: Pool;
        userId: string;
        assetId?: string;
        amountAtomic: string;
        key?: string;
      },
  userId?: string,
  amountAtomic?: string,
): Promise<{ availableId: string }> {
  const input =
    typeof poolOrInput === 'object' && poolOrInput !== null && 'pool' in poolOrInput
      ? poolOrInput
      : {
          pool: poolOrInput,
          userId: userId!,
          amountAtomic: amountAtomic!,
        };
  const assetId = input.assetId ?? (await usdtAssetId(input.pool));
  const key = input.key ?? randomUUID();
  return withLedgerTransaction(input.pool, async (client) => {
    const expense = await getOrCreateLedgerAccount(client, {
      accountType: 'PLATFORM_REWARD_EXPENSE',
      assetId,
    });
    const pending = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_PENDING_LIABILITY',
      assetId,
      ownerId: input.userId,
    });
    await postLedgerTransaction(client, {
      transactionType: 'REWARD_ISSUANCE',
      businessReferenceType: 'phase7-fund',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase7-fund',
      idempotencyKey: `${key}-issue`,
      assetId,
      entries: [
        { ledgerAccountId: expense.id, direction: 'DEBIT', amountAtomic: input.amountAtomic },
        { ledgerAccountId: pending.id, direction: 'CREDIT', amountAtomic: input.amountAtomic },
      ],
    });
    const available = await getOrCreateLedgerAccount(client, {
      accountType: 'USER_AVAILABLE_LIABILITY',
      assetId,
      ownerId: input.userId,
    });
    await postLedgerTransaction(client, {
      transactionType: 'REWARD_MATURITY',
      businessReferenceType: 'phase7-fund-maturity',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase7-fund',
      idempotencyKey: `${key}-mature`,
      assetId,
      entries: [
        { ledgerAccountId: pending.id, direction: 'DEBIT', amountAtomic: input.amountAtomic },
        { ledgerAccountId: available.id, direction: 'CREDIT', amountAtomic: input.amountAtomic },
      ],
    });
    return { availableId: available.id };
  });
}

/** Fund hot-wallet USDT asset via TREASURY_FUNDING_CLEARING (harness-only acknowledge). */
export async function fundHotWalletUsdt(
  pool: Pool,
  hotWalletId: string,
  amountAtomic: string,
): Promise<void> {
  const assetId = await usdtAssetId(pool);
  await withLedgerTransaction(pool, async (client) => {
    const hot = await getOrCreateLedgerAccount(client, {
      accountType: 'HOT_WALLET_USDT_ASSET',
      assetId,
      ownerId: hotWalletId,
    });
    const treasury = await getOrCreateLedgerAccount(client, {
      accountType: 'TREASURY_FUNDING_CLEARING',
      assetId,
      acknowledgeUnresolvedAccounting: true,
    });
    await postLedgerTransaction(client, {
      transactionType: 'HOT_WALLET_FUNDING',
      businessReferenceType: 'phase7-hot-fund',
      businessReferenceId: randomUUID(),
      idempotencyScope: 'phase7-hot-fund',
      idempotencyKey: randomUUID(),
      assetId,
      entries: [
        { ledgerAccountId: hot.id, direction: 'DEBIT', amountAtomic },
        { ledgerAccountId: treasury.id, direction: 'CREDIT', amountAtomic },
      ],
    });
  });
}

export async function bindVerifiedPrimaryWallet(
  pool: Pool,
  userId: string,
  networkIdArg?: string,
): Promise<string> {
  const netId = networkIdArg ?? (await tonTestnetNetworkId(pool));
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

/** @deprecated Prefer bindVerifiedPrimaryWallet */
export async function createVerifiedPrimaryWallet(
  pool: Pool,
  input: { userId: string; networkId: string; rawAddress?: string },
): Promise<string> {
  if (input.rawAddress !== undefined) {
    const friendly = `EQ${input.rawAddress.slice(2, 50)}`;
    const result = await pool.query<{ id: string }>(
      `INSERT INTO user_wallets (
         user_id, network_id, chain, raw_address, friendly_address,
         is_primary, verified, verification_method, verified_at, became_primary_at
       ) VALUES (
         $1::uuid, $2::uuid, 'TON', $3, $4,
         true, true, 'TON_PROOF', now(), now()
       )
       RETURNING id`,
      [input.userId, input.networkId, input.rawAddress, friendly],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('wallet insert failed');
    return id;
  }
  return bindVerifiedPrimaryWallet(pool, input.userId, input.networkId);
}

/**
 * Ensure exactly one ACTIVE TEST_ONLY_FAKE* hot wallet.
 * Returns existing if one; fails if multiple ACTIVE TEST_ONLY.
 */
export async function ensureTestHotWallet(pool: Pool, networkIdArg?: string): Promise<string> {
  const netId = networkIdArg ?? (await tonTestnetNetworkId(pool));
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM hot_wallets
     WHERE network_id = $1::uuid
       AND status = 'ACTIVE'
       AND signer_reference LIKE 'TEST_ONLY_FAKE%'`,
    [netId],
  );
  if (existing.rowCount !== null && existing.rowCount > 1) {
    throw new Error('multiple ACTIVE TEST_ONLY hot wallets');
  }
  if (existing.rows[0] !== undefined) {
    return existing.rows[0].id;
  }
  const address = `0:hot${randomUUID().replace(/-/g, '')}`;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO hot_wallets (
       network_id, address, friendly_address, wallet_version,
       signer_type, signer_reference, status, label
     ) VALUES (
       $1::uuid, $2, $3, 'v5R1',
       'KMS', 'TEST_ONLY_FAKE_HOT_1', 'ACTIVE', 'phase7-test-hot'
     )
     RETURNING id`,
    [netId, address, `EQ${address.slice(2, 50)}`],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('hot wallet insert failed');
  return id;
}

/**
 * Ensure exactly one ACTIVE FALLBACK_ENCRYPTED payout Hot Wallet for non-fake create.
 * Retires ACTIVE TEST_ONLY_FAKE* rows on the network so fake-mode rows cannot confuse
 * volume assignment; does not invent TEST_ONLY_FAKE signer references.
 */
export async function ensureEncryptedPayoutHotWallet(
  pool: Pool,
  input: {
    readonly networkId?: string;
    readonly address: string;
    readonly friendlyAddress: string;
    readonly signerReference: string;
    readonly payoutJettonWalletAddress: string;
    readonly label?: string;
  },
): Promise<string> {
  if (input.signerReference.startsWith('TEST_ONLY_FAKE')) {
    throw new Error('encrypted payout Hot Wallet must not use TEST_ONLY_FAKE signer_reference');
  }
  const netId = input.networkId ?? (await tonTestnetNetworkId(pool));
  await pool.query(
    `UPDATE hot_wallets
     SET status = 'RETIRED', retired_at = COALESCE(retired_at, now()), updated_at = now()
     WHERE network_id = $1::uuid
       AND status = 'ACTIVE'
       AND signer_reference LIKE 'TEST_ONLY_FAKE%'`,
    [netId],
  );

  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM hot_wallets
     WHERE network_id = $1::uuid
       AND status = 'ACTIVE'
       AND signer_type = 'FALLBACK_ENCRYPTED'`,
    [netId],
  );
  if (existing.rowCount !== null && existing.rowCount > 1) {
    throw new Error('multiple ACTIVE FALLBACK_ENCRYPTED hot wallets');
  }
  if (existing.rows[0] !== undefined) {
    await pool.query(
      `UPDATE hot_wallets SET
         address = $2,
         friendly_address = $3,
         signer_reference = $4,
         payout_jetton_wallet_address = $5,
         signer_type = 'FALLBACK_ENCRYPTED',
         updated_at = now()
       WHERE id = $1::uuid`,
      [
        existing.rows[0].id,
        input.address,
        input.friendlyAddress,
        input.signerReference,
        input.payoutJettonWalletAddress,
      ],
    );
    return existing.rows[0].id;
  }

  const result = await pool.query<{ id: string }>(
    `INSERT INTO hot_wallets (
       network_id, address, friendly_address, wallet_version,
       signer_type, signer_reference, status, payout_jetton_wallet_address, label
     ) VALUES (
       $1::uuid, $2, $3, 'v5R1',
       'FALLBACK_ENCRYPTED', $4, 'ACTIVE', $5, $6
     )
     RETURNING id`,
    [
      netId,
      input.address,
      input.friendlyAddress,
      input.signerReference,
      input.payoutJettonWalletAddress,
      input.label ?? 'phase10-encrypted-hot',
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('encrypted hot wallet insert failed');
  return id;
}

/** @deprecated Prefer ensureTestHotWallet */
export async function createTestOnlyFakeHotWallet(
  pool: Pool,
  networkIdArg: string,
): Promise<string> {
  return ensureTestHotWallet(pool, networkIdArg);
}

export async function seedRules(pool: Pool): Promise<{
  feeRuleId: string;
  limitRuleId: string;
  assetId: string;
  networkId: string;
}> {
  const assetId = await usdtAssetId(pool);
  const netId = await tonTestnetNetworkId(pool);
  const rules = await withLedgerTransaction(pool, async (client) =>
    seedLockedInitialWithdrawalRules(client, { assetId, networkId: netId }),
  );
  return { ...rules, assetId, networkId: netId };
}

export async function claimFounderForUser(pool: Pool, userId: string): Promise<string> {
  const plan = await pool.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME plan missing');
  const result = await pool.query<{ id: string }>(
    `INSERT INTO user_memberships (
       user_id, membership_plan_id, status, source, claimed_at, founder_number
     ) VALUES (
       $1::uuid, $2::uuid, 'ACTIVE', 'OWNER_GRANT', now(),
       nextval('founder_number_seq')
     )
     RETURNING id`,
    [userId, planId],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('membership insert failed');
  return id;
}

/** Bind a synthetic ACTIVE fee-discount entitlement to FOUNDER_LIFETIME. */
export async function seedFounderFeeDiscount(
  client: PoolClient,
  input: { discountBps: number; assetId?: string; ruleVersion?: number; planCode?: string },
): Promise<{ ruleVersionId: string; planId: string; entitlementId: string }> {
  const plan = await client.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = $1`,
    [input.planCode ?? 'FOUNDER_LIFETIME'],
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('membership plan missing');
  const ent = await client.query<{ id: string }>(
    `SELECT id FROM entitlements WHERE code = 'WITHDRAWAL_PLATFORM_FEE_DISCOUNT'`,
  );
  const entitlementId = ent.rows[0]?.id;
  if (entitlementId === undefined) throw new Error('fee discount entitlement missing');

  const version = await client.query<{ id: string }>(
    `INSERT INTO membership_benefit_rule_versions (
       entitlement_id, membership_plan_id, rule_version, value_bps, asset_id,
       status, effective_from, reason
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5::uuid,
       'ACTIVE', now(), 'PHASE7 TEST synthetic fee discount'
     )
     RETURNING id`,
    [entitlementId, planId, input.ruleVersion ?? 1, input.discountBps, input.assetId ?? null],
  );
  const ruleVersionId = version.rows[0]?.id;
  if (ruleVersionId === undefined) throw new Error('benefit rule insert failed');

  await client.query(
    `INSERT INTO membership_plan_entitlements (
       membership_plan_id, entitlement_id, rule_version_id, valid_from, status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
    [planId, entitlementId, ruleVersionId],
  );
  return { ruleVersionId, planId, entitlementId };
}

export async function seedFounderPriorityReview(
  client: PoolClient,
): Promise<{ ruleVersionId: string }> {
  const plan = await client.query<{ id: string }>(
    `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
  );
  const planId = plan.rows[0]?.id;
  if (planId === undefined) throw new Error('FOUNDER_LIFETIME missing');
  const ent = await client.query<{ id: string }>(
    `SELECT id FROM entitlements WHERE code = 'PRIORITY_WITHDRAWAL_REVIEW'`,
  );
  const entitlementId = ent.rows[0]?.id;
  if (entitlementId === undefined) throw new Error('priority entitlement missing');

  const version = await client.query<{ id: string }>(
    `INSERT INTO membership_benefit_rule_versions (
       entitlement_id, membership_plan_id, rule_version, value_boolean,
       status, effective_from, reason
     ) VALUES (
       $1::uuid, $2::uuid, 1, true,
       'ACTIVE', now(), 'PHASE7 TEST priority review'
     )
     RETURNING id`,
    [entitlementId, planId],
  );
  const ruleVersionId = version.rows[0]?.id;
  if (ruleVersionId === undefined) throw new Error('priority rule insert failed');

  await client.query(
    `INSERT INTO membership_plan_entitlements (
       membership_plan_id, entitlement_id, rule_version_id, valid_from, status
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 'ACTIVE')`,
    [planId, entitlementId, ruleVersionId],
  );
  return { ruleVersionId };
}

export async function seedPhase7Base(pool: Pool): Promise<{
  assetId: string;
  networkId: string;
  feeRuleId: string;
  limitRuleId: string;
  hotWalletId: string;
  adminUserId: string;
}> {
  const rules = await seedRules(pool);
  const hotWalletId = await ensureTestHotWallet(pool, rules.networkId);
  const adminUserId = await createOwnerAdmin(pool);
  return {
    assetId: rules.assetId,
    networkId: rules.networkId,
    feeRuleId: rules.feeRuleId,
    limitRuleId: rules.limitRuleId,
    hotWalletId,
    adminUserId,
  };
}

export async function quoteAndCreate(
  pool: Pool,
  userId: string,
  amountAtomic: string,
  idempotencyKey: string,
  config: WithdrawalEngineConfig = engineConfig,
): Promise<{ quoteId: string; withdrawalId: string; state: string }> {
  const quote = await createWithdrawalQuote(pool, config, {
    authenticatedUserId: userId,
    amountAtomic,
  });
  const withdrawal = await createWithdrawalFromQuote(pool, config, {
    authenticatedUserId: userId,
    quoteId: quote.id,
    idempotencyKey,
  });
  return {
    quoteId: quote.id,
    withdrawalId: withdrawal.id,
    state: withdrawal.state,
  };
}

export async function approveWithdrawal(
  pool: Pool,
  adminId: string,
  withdrawalId: string,
  idempotencyKey?: string,
  config: WithdrawalEngineConfig = engineConfig,
): Promise<void> {
  await decideWithdrawal(pool, config, {
    withdrawalId,
    expectedState: 'MANUAL_REVIEW',
    decision: 'APPROVE',
    trustedOwnerActorContext: { adminUserId: adminId },
    reason: 'phase7-approve',
    idempotencyKey: idempotencyKey ?? randomUUID(),
  });
}

/** Quote → create → Owner APPROVE with funded Available + hot wallet. */
export async function createApprovedWithdrawal(
  pool: Pool,
  input: {
    userId: string;
    networkId: string;
    assetId: string;
    adminUserId: string;
    hotWalletId: string;
    amountAtomic: string;
    /** Defaults to fake-chain fixture config (Phase 7). Pass fakeChainEnabled:false for Phase 10. */
    engineConfig?: WithdrawalEngineConfig;
  },
): Promise<string> {
  const config = input.engineConfig ?? engineConfig;
  await fundUserAvailable({
    pool,
    userId: input.userId,
    assetId: input.assetId,
    amountAtomic: '5000000',
    key: randomUUID(),
  });
  await fundHotWalletUsdt(pool, input.hotWalletId, '10000000');
  const { withdrawalId } = await quoteAndCreate(
    pool,
    input.userId,
    input.amountAtomic,
    randomUUID(),
    config,
  );
  await approveWithdrawal(pool, input.adminUserId, withdrawalId, undefined, config);
  return withdrawalId;
}

export async function truncateWithdrawalTables(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
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
      user_memberships,
      user_wallets,
      ledger_entries,
      ledger_account_balances,
      ledger_transactions,
      ledger_accounts,
      withdrawal_fee_rules,
      withdrawal_limit_rules,
      admin_users,
      users
    RESTART IDENTITY CASCADE
  `);
}
