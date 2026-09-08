/**
 * Phase 2 database baseline verification.
 *
 * This suite is destructive: it drops and recreates the `public` schema before
 * applying `migrations/*.sql` from zero. It therefore only runs against a
 * database that was explicitly nominated for it:
 *
 *   * `PHASE2_DATABASE_URL` — a dedicated Phase 2 test database, or
 *   * `DATABASE_URL` together with `PHASE2_MIGRATION_TESTS=1` (what
 *     `pnpm --filter @alex-rewards/db test:phase2` sets).
 *
 * With neither present the suite is skipped so a routine `pnpm test` can never
 * wipe a developer's local database.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { QueryResult } from 'pg';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrationsDirectory = fileURLToPath(new URL('../../../migrations/', import.meta.url));

const explicitUrl = process.env.PHASE2_DATABASE_URL ?? '';
const optedInUrl =
  process.env.PHASE2_MIGRATION_TESTS === '1' ? (process.env.DATABASE_URL ?? '') : '';
const databaseUrl = explicitUrl !== '' ? explicitUrl : optedInUrl;

const EXPECTED_MIGRATION_COUNT = 13;

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const EXCLUSION_VIOLATION = '23P01';
const RESTRICT_VIOLATION = '23001';

/** Every table the V1.2 Phase 2 baseline must create. */
const REQUIRED_TABLES = [
  // 0001 bookkeeping
  'schema_migrations',
  // 0002 networks, assets, users
  'networks',
  'assets',
  'users',
  'user_profiles',
  'user_settings',
  'user_sessions',
  'user_wallets',
  'user_wallet_proof_nonces',
  // 0003 ads and rewards
  'ad_providers',
  'ad_provider_manifests',
  'ad_units',
  'reward_rules',
  'reward_budget_periods',
  'reward_quotes',
  'reward_budget_reservations',
  'ad_sessions',
  'ad_client_events',
  'ad_session_signals',
  'ad_provider_events',
  'ad_daily_counters',
  'reward_events',
  'reward_maturities',
  // 0004 ledger
  'ledger_accounts',
  'ledger_transactions',
  'ledger_entries',
  'ledger_account_balances',
  'ledger_balance_snapshots',
  // 0005 withdrawals and hot wallet
  'withdrawal_fee_rules',
  'withdrawal_limit_rules',
  'hot_wallets',
  'hot_wallet_dispatch_leases',
  'withdrawal_quotes',
  'withdrawals',
  'withdrawal_approvals',
  'withdrawal_attempts',
  'blockchain_transactions',
  'chain_observations',
  'hot_wallet_snapshots',
  // 0006 risk, referral, tasks, missions
  'risk_rule_versions',
  'risk_profiles',
  'risk_snapshots',
  'risk_events',
  'fraud_flags',
  'wallet_relationships',
  'network_signals',
  'referral_codes',
  'referral_edges',
  'referral_reward_events',
  'task_definitions',
  'task_definition_versions',
  'user_task_progress',
  'task_reward_events',
  'mission_definitions',
  'mission_versions',
  'mission_progress',
  'mission_claims',
  // 0007 admin, audit, system
  'admin_users',
  'admin_roles',
  'admin_permissions',
  'admin_role_permissions',
  'admin_role_bindings',
  'admin_credentials',
  'admin_recovery_codes',
  'admin_sessions',
  'admin_action_tokens',
  'audit_logs',
  'telegram_destinations',
  'telegram_publications',
  'payout_publications',
  'outbox_events',
  'inbox_events',
  'idempotency_keys',
  'system_config_versions',
  // 0008 membership and entitlements
  'membership_plans',
  'entitlements',
  'membership_benefit_rule_versions',
  'membership_plan_entitlements',
  'user_memberships',
  'membership_claim_codes',
  'membership_grant_events',
  'membership_bonus_budget_periods',
  'membership_bonus_budget_reservations',
  // 0009 provider V1.2 operations
  'provider_contracts',
  'provider_limit_rules',
  'provider_country_rules',
  'provider_routing_policy_versions',
  'provider_certification_runs',
  'provider_certification_results',
  'provider_settlement_periods',
  'provider_settlement_items',
  'provider_reporting_imports',
  'trust_snapshots',
  'eligibility_decisions',
  // 0010 review, notifications, flags, reconciliation
  'support_tickets',
  'support_messages',
  'support_events',
  'review_cases',
  'review_case_events',
  'notification_campaigns',
  'notifications',
  'notification_deliveries',
  'feature_flags',
  'feature_flag_versions',
  'economic_exposure_limits',
  'reconciliation_runs',
  'reconciliation_items',
  'reconciliation_issues',
] as const;

/** Column-name fragments that would signal a mutable balance shortcut on `users`. */
const FORBIDDEN_USER_COLUMN_PATTERN =
  /(^|_)(balance|balances|available|pending|reserved|credits?|points|atomic)($|_)/i;

function migrationFileNames(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

function readMigration(fileName: string): string {
  return readFileSync(join(migrationsDirectory, fileName), 'utf8');
}

function firstRow<T>(result: QueryResult<T>): T {
  const row = result.rows[0];
  if (row === undefined) throw new Error('expected the query to return at least one row');
  return row;
}

describe.skipIf(databaseUrl === '')('Phase 2 database baseline', () => {
  let client: Client;
  let telegramSeq = 990_000_000;

  let usdtAssetId = '';
  let founderPlanId = '';
  let standardPlanId = '';
  let adminUserId = '';
  let providerId = '';

  async function applyAll(): Promise<string[]> {
    const applied: string[] = [];
    for (const fileName of migrationFileNames()) {
      const version = fileName.replace(/\.sql$/, '');
      const bookkeeping = await client.query<{ present: boolean }>(
        `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`,
      );
      if (firstRow(bookkeeping).present) {
        const already = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
          version,
        ]);
        if (already.rowCount !== null && already.rowCount > 0) continue;
      }
      await client.query(readMigration(fileName));
      applied.push(version);
    }
    return applied;
  }

  async function expectPgError(promise: Promise<unknown>, sqlState: string): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    expect(caught, `expected the statement to fail with SQLSTATE ${sqlState}`).toBeDefined();
    expect((caught as { code?: string }).code).toBe(sqlState);
  }

  async function createUser(): Promise<string> {
    telegramSeq += 1;
    const result = await client.query<{ id: string }>(
      'INSERT INTO users (telegram_user_id) VALUES ($1) RETURNING id',
      [telegramSeq],
    );
    return firstRow(result).id;
  }

  async function createMembership(
    userId: string,
    planId: string,
    source = 'OWNER_GRANT',
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO user_memberships (user_id, membership_plan_id, status, source)
       VALUES ($1, $2, 'ACTIVE', $3)
       RETURNING id`,
      [userId, planId, source],
    );
    return firstRow(result).id;
  }

  async function createClaimCode(label: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO membership_claim_codes (code_hash, membership_plan_id, created_by_admin_id)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`local-test-code-hash-${label}`, founderPlanId, adminUserId],
    );
    return firstRow(result).id;
  }

  async function createLedgerTransaction(businessReferenceType: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (
         transaction_type, business_reference_type, idempotency_scope, idempotency_key, asset_id
       ) VALUES ('MANUAL_CORRECTION', $1, 'phase2-test', $1, $2)
       RETURNING id`,
      [businessReferenceType, usdtAssetId],
    );
    return firstRow(result).id;
  }

  async function createPlatformAccount(accountType: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ledger_accounts (
         owner_type, owner_id, account_type, account_class, normal_side, asset_id
       ) VALUES ('PLATFORM', NULL, $1, 'EXPENSE', 'DEBIT', $2)
       RETURNING id`,
      [accountType, usdtAssetId],
    );
    return firstRow(result).id;
  }

  async function createUserLiabilityAccount(userId: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO ledger_accounts (
         owner_type, owner_id, account_type, account_class, normal_side, asset_id
       ) VALUES ('USER', $1, 'USER_AVAILABLE_LIABILITY', 'LIABILITY', 'CREDIT', $2)
       RETURNING id`,
      [userId, usdtAssetId],
    );
    return firstRow(result).id;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl, application_name: 'alex-rewards-tests' });
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
    await applyAll();

    usdtAssetId = firstRow(
      await client.query<{ id: string }>(`SELECT id FROM assets WHERE symbol = 'USDT'`),
    ).id;
    founderPlanId = firstRow(
      await client.query<{ id: string }>(
        `SELECT id FROM membership_plans WHERE code = 'FOUNDER_LIFETIME'`,
      ),
    ).id;
    standardPlanId = firstRow(
      await client.query<{ id: string }>(`SELECT id FROM membership_plans WHERE code = 'STANDARD'`),
    ).id;
    adminUserId = firstRow(
      await client.query<{ id: string }>(
        `INSERT INTO admin_users (email, display_name)
         VALUES ('phase2-tests@local.invalid', 'Phase 2 test operator')
         RETURNING id`,
      ),
    ).id;
    providerId = firstRow(
      await client.query<{ id: string }>(
        `INSERT INTO ad_providers (code, name)
         VALUES ('LOCAL_TEST_PROVIDER', 'Local test provider')
         RETURNING id`,
      ),
    ).id;
  }, 180_000);

  afterAll(async () => {
    await client?.end();
  });

  // -------------------------------------------------------------------------
  // Migration runner
  // -------------------------------------------------------------------------

  it('migrates cleanly from zero and records every migration version', async () => {
    const fileVersions = migrationFileNames().map((name) => name.replace(/\.sql$/, ''));
    expect(fileVersions).toHaveLength(EXPECTED_MIGRATION_COUNT);

    const recorded = await client.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(recorded.rows.map((row) => row.version)).toEqual(fileVersions);
  });

  it('is idempotent: a second apply and a re-run of the seed change nothing', async () => {
    const appliedOnSecondRun = await applyAll();
    expect(appliedOnSecondRun).toEqual([]);

    // The seed migration is re-executed directly, bypassing the version guard.
    await client.query(readMigration('0011_seed_local_fixtures.sql'));

    const counts = firstRow(
      await client.query<{
        migrations: number;
        networks: number;
        assets: number;
        plans: number;
        entitlements: number;
        roles: number;
        flags: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM schema_migrations) AS migrations,
           (SELECT count(*)::int FROM networks) AS networks,
           (SELECT count(*)::int FROM assets) AS assets,
           (SELECT count(*)::int FROM membership_plans) AS plans,
           (SELECT count(*)::int FROM entitlements) AS entitlements,
           (SELECT count(*)::int FROM admin_roles) AS roles,
           (SELECT count(*)::int FROM feature_flags) AS flags`,
      ),
    );
    expect(counts.migrations).toBe(EXPECTED_MIGRATION_COUNT);
    expect(counts.networks).toBe(1);
    expect(counts.assets).toBe(2);
    expect(counts.plans).toBe(2);
    expect(counts.entitlements).toBe(10);
    expect(counts.roles).toBe(5);
    expect(counts.flags).toBe(10);
  });

  // -------------------------------------------------------------------------
  // No mutable authoritative balance
  // -------------------------------------------------------------------------

  it('does not create a users.balance column', async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain('balance');
    expect(names).toContain('telegram_user_id');
  });

  it('does not create any mutable balance shortcut column on users', async () => {
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'`,
    );
    const offenders = columns.rows
      .map((row) => row.column_name)
      .filter((name) => FORBIDDEN_USER_COLUMN_PATTERN.test(name));
    expect(offenders).toEqual([]);
  });

  it('keeps users.withdrawal_status on the enum with an ALLOWED default', async () => {
    const column = firstRow(
      await client.query<{ udt_name: string; column_default: string; is_nullable: string }>(
        `SELECT udt_name, column_default, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'users'
           AND column_name = 'withdrawal_status'`,
      ),
    );
    expect(column.udt_name).toBe('user_withdrawal_access_status');
    expect(column.is_nullable).toBe('NO');
    expect(column.column_default).toContain('ALLOWED');
  });

  // -------------------------------------------------------------------------
  // Membership and Founder identity
  // -------------------------------------------------------------------------

  it('rejects a duplicate founder_number', async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();
    await client.query(
      `INSERT INTO user_memberships (user_id, membership_plan_id, founder_number, status, source)
       VALUES ($1, $2, 1001, 'ACTIVE', 'OWNER_GRANT')`,
      [firstUser, founderPlanId],
    );
    await expectPgError(
      client.query(
        `INSERT INTO user_memberships (user_id, membership_plan_id, founder_number, status, source)
         VALUES ($1, $2, 1001, 'ACTIVE', 'OWNER_GRANT')`,
        [secondUser, founderPlanId],
      ),
      UNIQUE_VIOLATION,
    );
  });

  it('allows many NULL founder_number rows for non-Founder memberships', async () => {
    const firstUser = await createUser();
    const secondUser = await createUser();
    const thirdUser = await createUser();
    await createMembership(firstUser, standardPlanId);
    await createMembership(secondUser, standardPlanId);
    await createMembership(thirdUser, standardPlanId);

    const nulls = firstRow(
      await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM user_memberships
         WHERE founder_number IS NULL AND membership_plan_id = $1`,
        [standardPlanId],
      ),
    );
    expect(nulls.n).toBeGreaterThanOrEqual(3);
  });

  it('rejects a second ACTIVE membership for the same user and plan', async () => {
    const userId = await createUser();
    await createMembership(userId, standardPlanId);
    await expectPgError(
      client.query(
        `INSERT INTO user_memberships (user_id, membership_plan_id, status, source)
         VALUES ($1, $2, 'ACTIVE', 'OWNER_GRANT')`,
        [userId, standardPlanId],
      ),
      UNIQUE_VIOLATION,
    );

    // A superseded (non-ACTIVE) history row for the same pair stays legal.
    const historyRow = await client.query(
      `INSERT INTO user_memberships (user_id, membership_plan_id, status, source, revoked_at)
       VALUES ($1, $2, 'REVOKED', 'OWNER_GRANT', now())`,
      [userId, standardPlanId],
    );
    expect(historyRow.rowCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Claim codes
  // -------------------------------------------------------------------------

  it('requires an issuing admin and rejects a duplicate claim code hash', async () => {
    await createClaimCode('duplicate');
    await expectPgError(
      client.query(
        `INSERT INTO membership_claim_codes (code_hash, membership_plan_id, created_by_admin_id)
         VALUES ($1, $2, $3)`,
        ['local-test-code-hash-duplicate', founderPlanId, adminUserId],
      ),
      UNIQUE_VIOLATION,
    );

    const createdBy = firstRow(
      await client.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'membership_claim_codes'
           AND column_name = 'created_by_admin_id'`,
      ),
    );
    expect(createdBy.is_nullable).toBe('NO');
  });

  it('rejects a consumed_at without both the consuming user and the granted membership', async () => {
    await expectPgError(
      client.query(
        `INSERT INTO membership_claim_codes (
           code_hash, membership_plan_id, created_by_admin_id, consumed_at
         ) VALUES ($1, $2, $3, now())`,
        ['local-test-code-hash-half-consumed', founderPlanId, adminUserId],
      ),
      CHECK_VIOLATION,
    );

    const codeId = await createClaimCode('partial-update');
    const userId = await createUser();
    await expectPgError(
      client.query(
        `UPDATE membership_claim_codes
         SET consumed_at = now(), consumed_by_user_id = $2
         WHERE id = $1`,
        [codeId, userId],
      ),
      CHECK_VIOLATION,
    );
  });

  it('consumes a claim code exactly once', async () => {
    const codeId = await createClaimCode('single-use');
    const firstUser = await createUser();
    const secondUser = await createUser();
    const firstMembership = await createMembership(firstUser, founderPlanId, 'CLAIM_CODE');
    const secondMembership = await createMembership(secondUser, founderPlanId, 'CLAIM_CODE');

    const consume = `UPDATE membership_claim_codes
       SET consumed_at = now(), consumed_by_user_id = $2, granted_membership_id = $3
       WHERE id = $1 AND consumed_at IS NULL`;

    const first = await client.query(consume, [codeId, firstUser, firstMembership]);
    expect(first.rowCount).toBe(1);

    // The guarded update is the atomic single-use step: a replay matches no row.
    const replay = await client.query(consume, [codeId, secondUser, secondMembership]);
    expect(replay.rowCount).toBe(0);

    // A second code can never be bound to an already granted membership.
    const otherCodeId = await createClaimCode('duplicate-grant');
    await expectPgError(
      client.query(consume, [otherCodeId, secondUser, firstMembership]),
      UNIQUE_VIOLATION,
    );
  });

  it('rejects one user consuming two claim codes', async () => {
    const firstCodeId = await createClaimCode('user-first');
    const secondCodeId = await createClaimCode('user-second');
    const userId = await createUser();
    const founderMembership = await createMembership(userId, founderPlanId, 'CLAIM_CODE');
    const standardMembership = await createMembership(userId, standardPlanId, 'CLAIM_CODE');

    const consume = `UPDATE membership_claim_codes
       SET consumed_at = now(), consumed_by_user_id = $2, granted_membership_id = $3
       WHERE id = $1 AND consumed_at IS NULL`;

    const first = await client.query(consume, [firstCodeId, userId, founderMembership]);
    expect(first.rowCount).toBe(1);

    await expectPgError(
      client.query(consume, [secondCodeId, userId, standardMembership]),
      UNIQUE_VIOLATION,
    );
  });

  // -------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------

  it('rejects two PLATFORM accounts of the same type and asset with a NULL owner', async () => {
    await createPlatformAccount('PLATFORM_REWARD_EXPENSE');
    await expectPgError(createPlatformAccount('PLATFORM_REWARD_EXPENSE'), UNIQUE_VIOLATION);

    const identityKey = firstRow(
      await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'ledger_accounts_identity_key'`,
      ),
    );
    expect(identityKey.def).toMatch(/NULLS NOT DISTINCT/i);
  });

  it('requires a PLATFORM account to have a NULL owner and others to have one', async () => {
    await expectPgError(
      client.query(
        `INSERT INTO ledger_accounts (
           owner_type, owner_id, account_type, account_class, normal_side, asset_id
         ) VALUES ('PLATFORM', app_generate_uuid(), 'AD_REVENUE', 'REVENUE', 'CREDIT', $1)`,
        [usdtAssetId],
      ),
      CHECK_VIOLATION,
    );
    await expectPgError(
      client.query(
        `INSERT INTO ledger_accounts (
           owner_type, owner_id, account_type, account_class, normal_side, asset_id
         ) VALUES ('USER', NULL, 'USER_PENDING_LIABILITY', 'LIABILITY', 'CREDIT', $1)`,
        [usdtAssetId],
      ),
      CHECK_VIOLATION,
    );
  });

  it('rejects a ledger entry with a non-positive amount_atomic', async () => {
    const transactionId = await createLedgerTransaction('phase2-test-non-positive');
    const debitAccountId = await createPlatformAccount('MISSION_REWARD_EXPENSE');

    const insertEntry = (amount: string, entryIndex: number) =>
      client.query(
        `INSERT INTO ledger_entries (
           ledger_transaction_id, ledger_account_id, direction, amount_atomic, entry_index
         ) VALUES ($1, $2, 'DEBIT', $3, $4)`,
        [transactionId, debitAccountId, amount, entryIndex],
      );

    await expectPgError(insertEntry('0', 0), CHECK_VIOLATION);
    await expectPgError(insertEntry('-1', 1), CHECK_VIOLATION);

    const checks = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'ledger_entries'::regclass AND contype = 'c'`,
    );
    expect(checks.rows.some((row) => /amount_atomic > 0/i.test(row.def))).toBe(true);
  });

  it('rejects UPDATE and DELETE on posted ledger entries and transactions', async () => {
    const transactionId = await createLedgerTransaction('phase2-test-immutability');
    const userId = await createUser();
    const debitAccountId = await createPlatformAccount('REFERRAL_REWARD_EXPENSE');
    const creditAccountId = await createUserLiabilityAccount(userId);

    await client.query(
      `INSERT INTO ledger_entries (
         ledger_transaction_id, ledger_account_id, direction, amount_atomic, entry_index
       ) VALUES ($1, $2, 'DEBIT', 1000, 0), ($1, $3, 'CREDIT', 1000, 1)`,
      [transactionId, debitAccountId, creditAccountId],
    );

    let caught: unknown;
    try {
      await client.query(
        'UPDATE ledger_entries SET amount_atomic = 1 WHERE ledger_transaction_id = $1',
        [transactionId],
      );
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe(RESTRICT_VIOLATION);
    expect((caught as { message?: string }).message).toMatch(/append-only/i);

    await expectPgError(
      client.query('DELETE FROM ledger_entries WHERE ledger_transaction_id = $1', [transactionId]),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      client.query(`UPDATE ledger_transactions SET metadata = '{}'::jsonb WHERE id = $1`, [
        transactionId,
      ]),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      client.query('DELETE FROM ledger_transactions WHERE id = $1', [transactionId]),
      RESTRICT_VIOLATION,
    );
  });

  // -------------------------------------------------------------------------
  // Provider limit rules
  // -------------------------------------------------------------------------

  it('rejects overlapping ACTIVE provider limit windows', async () => {
    const insertActive = (ruleVersion: number, validFrom: Date) =>
      client.query(
        `INSERT INTO provider_limit_rules (
           provider_id, limit_scope, limit_metric, limit_window, max_count,
           rule_version, status, valid_from, source_type, source_reference
         ) VALUES ($1, 'PLATFORM_SOFT', 'REQUEST', 'UTC_DAY', 30, $2, 'ACTIVE', $3,
                   'OFFICIAL_DOCUMENTATION', 'local-test-provider-docs')`,
        [providerId, ruleVersion, validFrom],
      );

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const first = await insertActive(1, yesterday);
    expect(first.rowCount).toBe(1);
    await expectPgError(insertActive(2, new Date()), EXCLUSION_VIOLATION);
  });

  it('rejects a duplicate provider limit rule version key', async () => {
    const insertDraft = () =>
      client.query(
        `INSERT INTO provider_limit_rules (
           provider_id, limit_scope, limit_metric, limit_window, max_count,
           rule_version, status, source_type, source_reference
         ) VALUES ($1, 'PLATFORM_SOFT', 'SUCCESS', 'HOUR', 5, 1, 'DRAFT',
                   'WRITTEN_SUPPORT', 'local-test-provider-support')`,
        [providerId],
      );

    const first = await insertDraft();
    expect(first.rowCount).toBe(1);
    await expectPgError(insertDraft(), UNIQUE_VIOLATION);
  });

  it('requires an approver before a hard provider limit becomes ACTIVE', async () => {
    await expectPgError(
      client.query(
        `INSERT INTO provider_limit_rules (
           provider_id, limit_scope, limit_metric, limit_window, max_count,
           rule_version, status, source_type, source_reference
         ) VALUES ($1, 'PROVIDER_HARD', 'REQUEST', 'ROLLING_24H', 100, 1, 'ACTIVE',
                   'CONTRACT', 'local-test-contract-clause')`,
        [providerId],
      ),
      CHECK_VIOLATION,
    );

    const approved = await client.query(
      `INSERT INTO provider_limit_rules (
         provider_id, limit_scope, limit_metric, limit_window, max_count,
         rule_version, status, source_type, source_reference, approved_by_admin_id, approved_at
       ) VALUES ($1, 'PROVIDER_HARD', 'REQUEST', 'ROLLING_24H', 100, 1, 'ACTIVE',
                 'CONTRACT', 'local-test-contract-clause', $2, now())`,
      [providerId, adminUserId],
    );
    expect(approved.rowCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Outbox / Inbox / idempotency
  // -------------------------------------------------------------------------

  it('rejects a duplicate outbox dedupe key', async () => {
    const insert = () =>
      client.query(
        `INSERT INTO outbox_events (aggregate_type, event_type, dedupe_key)
         VALUES ('PHASE2_TEST', 'PHASE2_TEST_EVENT', 'phase2-test-dedupe')`,
      );
    expect((await insert()).rowCount).toBe(1);
    await expectPgError(insert(), UNIQUE_VIOLATION);
  });

  it('rejects a duplicate inbox event including a NULL external id', async () => {
    const insert = () =>
      client.query(
        `INSERT INTO inbox_events (source, source_reference, event_type, payload_hash)
         VALUES ('PROVIDER', 'phase2-test-callback', 'PHASE2_TEST_EVENT', 'phase2-test-hash')`,
      );
    expect((await insert()).rowCount).toBe(1);
    await expectPgError(insert(), UNIQUE_VIOLATION);

    const externalKey = firstRow(
      await client.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conname = 'inbox_events_external_key'`,
      ),
    );
    expect(externalKey.def).toMatch(/NULLS NOT DISTINCT/i);
  });

  it('rejects a duplicate idempotency key within a scope', async () => {
    const insert = () =>
      client.query(
        `INSERT INTO idempotency_keys (scope, idempotency_key, request_hash)
         VALUES ('phase2-test', 'phase2-test-key', 'phase2-test-request-hash')`,
      );
    expect((await insert()).rowCount).toBe(1);
    await expectPgError(insert(), UNIQUE_VIOLATION);
  });

  it('declares the Outbox, Inbox and idempotency uniqueness constraints', async () => {
    const constraints = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conname IN (
         'outbox_events_dedupe_key',
         'inbox_events_external_key',
         'idempotency_keys_scope_key',
         'ledger_transactions_idempotency_key'
       )`,
    );
    expect(constraints.rows.map((row) => row.conname).sort()).toEqual([
      'idempotency_keys_scope_key',
      'inbox_events_external_key',
      'ledger_transactions_idempotency_key',
      'outbox_events_dedupe_key',
    ]);
  });

  // -------------------------------------------------------------------------
  // Schema shape
  // -------------------------------------------------------------------------

  it('creates every required V1.2 table', async () => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const present = new Set(tables.rows.map((row) => row.table_name));
    const missing = REQUIRED_TABLES.filter((name) => !present.has(name));
    expect(missing).toEqual([]);
  });

  it('stores every atomic money column as BIGINT', async () => {
    const columns = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name LIKE '%\\_atomic'
       ORDER BY table_name, column_name`,
    );
    expect(columns.rows.length).toBeGreaterThan(20);
    const wrongType = columns.rows.filter((row) => row.data_type !== 'bigint');
    expect(wrongType).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Seed hygiene
  // -------------------------------------------------------------------------

  it('marks the seed migration as local fixtures and keeps it free of secrets', () => {
    const seed = readMigration('0011_seed_local_fixtures.sql');
    expect(seed).toMatch(/LOCAL FIXTURE ONLY/);
    expect(seed.match(/LOCAL FIXTURE ONLY/g)?.length ?? 0).toBeGreaterThanOrEqual(5);

    const secretPatterns: readonly [string, RegExp][] = [
      ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
      ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
      ['GitHub token', /\bgh[oprsu]_[A-Za-z0-9_]{30,}\b/],
      ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
      ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
      ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
      ['Stripe live key', /\bsk_live_[A-Za-z0-9]{10,}\b/],
      ['mnemonic material', /\bmnemonic\b/i],
      ['TON contract address', /\b[EU]Q[A-Za-z0-9_-]{46}\b/],
    ];
    const findings = secretPatterns
      .filter(([, pattern]) => pattern.test(seed))
      .map(([label]) => label);
    expect(findings).toEqual([]);
  });

  it('seeds no admin user, credential, session or production financial value', async () => {
    const counts = firstRow(
      await client.query<{ credentials: number; admin_sessions: number; benefit_rules: number }>(
        `SELECT
           (SELECT count(*)::int FROM admin_credentials) AS credentials,
           (SELECT count(*)::int FROM admin_sessions) AS admin_sessions,
           (SELECT count(*)::int FROM membership_benefit_rule_versions) AS benefit_rules`,
      ),
    );
    expect(counts.credentials).toBe(0);
    expect(counts.admin_sessions).toBe(0);
    expect(counts.benefit_rules).toBe(0);
  });
});
