# Database

PostgreSQL is the financial source of truth for ALEx Rewards. Phase 2 delivers the complete
V1.2 relational baseline as ordered, immutable explicit SQL migrations in `migrations/`.

Phase 2 delivered the **schema** baseline. Phase 4 implements Ledger Core posting in
`@alex-rewards/ledger` (see `docs/LEDGER.md`) and adds forward migration
`0012_ledger_integrity.sql`. Migrations `0001`–`0012` remain immutable after acceptance.
Phase 5 adds `0013_reward_engine_integrity.sql` for Reward Engine financial integrity,
`0014_phase5_financial_corrections.sql` for simulated source registry, frozen quote protection,
multi-period bonus reservations, and atomic exposure period counters, and
`0015_budget_period_utc_window_integrity.sql` for canonical UTC budget window CHECKs.
Phase 6 adds `0016_wallet_proof_nonce_lifecycle.sql` so open `ton_proof` challenges can be
security-invalidated (distinct from successful consumption) when the primary wallet changes.
Migrations `0001`–`0015` remain immutable after acceptance. Withdrawals, payouts, provider adapters,
and KMS signing remain out of scope until later Owner-approved phases.

## Migration inventory

| File                                                 | Contents                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_extensions_enums.sql`                          | `pgcrypto`, `btree_gist`, `schema_migrations`, shared helper functions, every ENUM type                                                              |
| `0002_networks_assets_users.sql`                     | networks, assets, users, profiles, settings, sessions, payout wallets, ton_proof nonces                                                              |
| `0003_ads_and_rewards.sql`                           | providers, manifests, units, ad sessions and evidence, daily counters, reward rules/quotes/budgets/events/maturities                                 |
| `0004_ledger.sql`                                    | immutable double-entry ledger, balance projection, balance snapshots                                                                                 |
| `0005_withdrawals_and_hot_wallet.sql`                | fee/limit rule versions, quotes, withdrawals, approvals, attempts, chain correlation, hot wallets, dispatch leases                                   |
| `0006_risk_referral_tasks_missions.sql`              | risk rules/profiles/snapshots/events, fraud flags, referral graph, tasks, mission engine                                                             |
| `0007_admin_audit_system.sql`                        | admin identity/RBAC/credentials/sessions/action tokens, audit log, Telegram and payout publications, Outbox/Inbox, idempotency keys, config versions |
| `0008_membership_entitlements.sql`                   | membership plans, entitlements, benefit rule versions, user memberships, claim codes, grant history, bonus budgets                                   |
| `0009_provider_v12_ops.sql`                          | provider contracts, limit rules, country rules, routing policy versions, certification, settlement, reporting imports, trust, eligibility            |
| `0010_review_notifications_flags_reconciliation.sql` | support, review cases, notifications and campaigns, feature flags, exposure limits, reconciliation                                                   |
| `0011_seed_local_fixtures.sql`                       | LOCAL FIXTURE ONLY reference data                                                                                                                    |
| `0012_ledger_integrity.sql`                          | Phase 4: one-reversal-per-original unique index; ledger_accounts structural immutability                                                             |
| `0013_reward_engine_integrity.sql`                   | Phase 5: ACTIVE reward-rule family overlap EXCLUDE; financial-rule immutability; quote reconstruction / started-source fields                        |
| `0014_phase5_financial_corrections.sql`              | Phase 5 correction: `simulated_reward_sources`; frozen `reward_quotes` trigger; multi-period bonus reservations; economic exposure period counters   |
| `0015_budget_period_utc_window_integrity.sql`        | Phase 5 narrow: canonical HOUR / UTC_DAY / UTC_MONTH window CHECKs on reward + membership bonus budget periods                                       |
| `0016_wallet_proof_nonce_lifecycle.sql`              | Phase 6: nonce `invalidated_at` / `invalidation_reason`; open-index excludes consumed and invalidated rows                                           |

## Schema ownership

Each table has exactly one owning domain. Cross-domain writes go through that domain's command
path, never through direct table access from another boundary.

| Domain                | Owns                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platform config       | `networks`, `assets`, `system_config_versions`, `feature_flags`, `feature_flag_versions`, `telegram_destinations`                                       |
| Identity              | `users`, `user_profiles`, `user_settings`, `user_sessions`, `user_wallets`, `user_wallet_proof_nonces`                                                  |
| Ads                   | `ad_providers`, `ad_provider_manifests`, `ad_units`, `ad_sessions`, `ad_client_events`, `ad_session_signals`, `ad_provider_events`, `ad_daily_counters` |
| Rewards               | `reward_rules`, `reward_quotes`, `reward_budget_periods`, `reward_budget_reservations`, `reward_events`, `reward_maturities`                            |
| Ledger                | `ledger_accounts`, `ledger_transactions`, `ledger_entries`, `ledger_account_balances`, `ledger_balance_snapshots`                                       |
| Withdrawals / payouts | `withdrawal_*`, `withdrawals`, `blockchain_transactions`, `chain_observations`, `hot_wallets`, `hot_wallet_*`                                           |
| Risk and fraud        | `risk_*`, `fraud_flags`, `wallet_relationships`, `network_signals`, `trust_snapshots`, `eligibility_decisions`                                          |
| Growth                | `referral_*`, `task_*`, `user_task_progress`, `mission_*`                                                                                               |
| Membership            | `membership_*`, `entitlements`, `user_memberships`                                                                                                      |
| Provider operations   | `provider_*`                                                                                                                                            |
| Admin and audit       | `admin_*`, `audit_logs`, `payout_publications`, `telegram_publications`                                                                                 |
| Messaging plumbing    | `outbox_events`, `inbox_events`, `idempotency_keys`                                                                                                     |
| Support and review    | `support_*`, `review_cases`, `review_case_events`, `notifications`, `notification_*`                                                                    |
| Reconciliation        | `reconciliation_*`, `economic_exposure_limits`                                                                                                          |

## ERD (logical)

Phase 2 owns schema only. The diagram below is the ownership and authority graph, not a posting
or payout flow. Money truth is always `ledger_transactions` → `ledger_entries`; projections and
evidence tables never become independent financial authorities.

```mermaid
flowchart LR
  subgraph Identity
    users
    user_profiles
    user_sessions
    user_wallets
  end

  subgraph AdsEvidence["Ads evidence input"]
    ad_sessions
    ad_client_events
    ad_provider_events
  end

  subgraph RewardsFoundations["Rewards foundations"]
    reward_quotes
    reward_events
    reward_maturities
  end

  subgraph LedgerTruth["Ledger money truth"]
    ledger_accounts
    ledger_transactions
    ledger_entries
    ledger_account_balances
  end

  subgraph WithdrawalsFoundations["Withdrawals foundations"]
    withdrawals
    withdrawal_approvals
    hot_wallets
  end

  subgraph Membership
    membership_plans
    user_memberships
    membership_claim_codes
  end

  subgraph ProviderOps["Provider operations"]
    provider_contracts
    provider_limit_rules
    provider_certification_results
  end

  subgraph Messaging["Delivery foundations"]
    outbox_events
    inbox_events
    idempotency_keys
  end

  users --> user_profiles
  users --> user_sessions
  users --> user_wallets
  users --> user_memberships
  users --> ad_sessions
  users --> reward_events
  users --> withdrawals
  users --> ledger_accounts

  ad_sessions --> ad_client_events
  ad_sessions --> ad_provider_events
  ad_sessions -.->|evidence only| reward_quotes
  reward_quotes -.->|Phase 3+ posting| ledger_transactions
  reward_events -.->|Phase 3+ posting| ledger_transactions
  ledger_transactions --> ledger_entries
  ledger_accounts --> ledger_entries
  ledger_accounts --> ledger_account_balances

  withdrawals -.->|Phase 5+ posting| ledger_transactions
  withdrawals --> withdrawal_approvals
  withdrawals --> hot_wallets

  membership_plans --> user_memberships
  membership_claim_codes --> user_memberships

  provider_contracts --> provider_limit_rules
  provider_contracts --> provider_certification_results

  ledger_transactions -.-> outbox_events
  inbox_events -.->|callback input only| ad_provider_events
  idempotency_keys -.->|request dedupe| ledger_transactions
```

Dashed edges mark **future phase behaviour** that the schema must support without implementing in
Phase 2. Solid edges are foreign-key / ownership relationships already present in the migrations.

## Authority semantics

**The ledger is money truth.** `ledger_transactions` and `ledger_entries` are the only
authoritative record of user and platform money. Both reject `UPDATE` and `DELETE` through the
`app_reject_row_mutation()` trigger, all amounts are positive `BIGINT` atomic units with the sign
carried by `direction`, and a correction is a new reversal transaction linked through
`reverses_transaction_id`. An original transaction is never mutated into a "reversed" state.

**There is no mutable authoritative balance.** `users` deliberately has no `balance` column and no
balance shortcut of any other name. Pending, Available and Reserved buckets are derived from
ledger entries. `ledger_account_balances` and `ledger_balance_snapshots` are transactionally
maintained projections used for row locking and fast reads; both are fully rebuildable from
entries and are never an independent source of truth. Projection `version` equals the count of
DISTINCT ledger transactions that touched the account. `last_ledger_transaction_id` is validated
tie-aware when multiple posts share one PostgreSQL `posted_at` (no `0013` posting-sequence column).
`scripts/validate-migrations.mjs` fails the
build if any migration introduces `users.balance` or a `*balance*` column on `users`.

**Evidence is not money.** `ad_client_events`, `ad_session_signals`, `ad_provider_events`,
`inbox_events` and provider reporting imports record what was observed. They never credit a user;
only a posted ledger transaction does.

**`review_cases` are an operational projection.** The unified review queue is a control surface
over existing domain state. Acting on a case calls the authoritative domain command and must pass
its state, permission and invariant checks. Resolving a case never rewrites domain history, and a
case row is never itself the reason a payout or reward is valid.

**Redis is never an authority.** Redis holds caches, rate-limit counters, locks and queue-adjacent
state. Losing all of Redis must not change any financial outcome. Authoritative counters live in
PostgreSQL (`ad_daily_counters` is the daily counter authority), authoritative idempotency lives in
`idempotency_keys` and the ledger's `(idempotency_scope, idempotency_key)` constraint, and
cross-service delivery goes through the transactional `outbox_events` / `inbox_events` pattern.

**Rules are versioned data, not code.** Reward economics, fees, withdrawal limits, provider limits,
country rules, routing weights and membership benefits are all effective-dated rule versions with a
recorded source, reason and approver. Changing a documented provider limit is a new approved rule
version, never an application code change. Production financial values are
`OWNER_DECISION_REQUIRED` and are never seeded.

## Nullable uniqueness strategy

Two different behaviours are needed from `NULL` in unique keys, so both are used deliberately.

`UNIQUE NULLS NOT DISTINCT` is used where a `NULL` means "the one global/platform-scoped row" and a
second such row must collide:

- `ledger_accounts_identity_key` — a PLATFORM account has `owner_id IS NULL`, so two PLATFORM
  accounts of the same `account_type` and `asset_id` are rejected.
- `ledger_transactions_business_reference_key`, `assets_identity_key`,
  `inbox_events_external_key`, `telegram_destinations_target_key`,
  `telegram_publications_subject_key`, `membership_benefit_rule_versions_key`,
  `membership_bonus_budget_periods_key`, `provider_limit_rules_version_key`,
  `provider_settlement_items_key`.

Plain `UNIQUE` (SQL-standard, `NULL`s distinct) is used where `NULL` means "not applicable" and
many rows may legitimately have it:

- `user_memberships_founder_number_key` — Founder numbers are unique and permanent, while every
  non-Founder membership (for example every `STANDARD` plan row) carries `founder_number IS NULL`,
  and any number of those may coexist.
- `membership_claim_codes_reserved_number_key`, `membership_claim_codes_grant_key`,
  `admin_users_telegram_user_id_key`, `user_sessions_refresh_token_hash_key`,
  `outbox_events_dedupe_key`.

Partial unique indexes express "at most one live row" without deleting history:

- `user_memberships_one_active_per_plan_idx` — one `ACTIVE` membership per user per plan.
- `membership_claim_codes_one_per_user_idx` — a user may consume at most one claim code, ever.
- `user_wallets_one_primary_per_network_idx`, `review_cases_one_open_per_resource_idx`.

`EXCLUDE USING gist` constraints stop two `ACTIVE` versions of the same effective-dated dimension
from overlapping in time (`provider_limit_rules`, `provider_country_rules`,
`membership_plan_entitlements`). These require the `btree_gist` extension from `0001`.

## Rollback and recovery

**Migrations are forward-only. There are no down migrations.** Every migration file is a single
transaction that records its own version in `schema_migrations`, so a migration that fails leaves
the database exactly at the previous version with nothing partially applied — retry after fixing
the file.

A migration that has already committed is never reversed in place. Recovery is:

1. Stop writes to the affected domain (feature-flag kill switch where one exists).
2. Restore the pre-release backup snapshot into a new instance, or use point-in-time recovery to
   the timestamp immediately before the release.
3. Re-apply migrations forward against the restored instance (`pnpm db:migrate`), including any
   new corrective migration.
4. Reconcile: the ledger is authoritative, so projections (`ledger_account_balances`,
   `ledger_balance_snapshots`, counters) are rebuilt from `ledger_entries` rather than trusted.
5. Record the incident and the corrective migration in `docs/DECISIONS.md`.

A defect in an applied migration is corrected by a **new numbered migration**, never by editing a
migration that has shipped. Editing a shipped file would leave already-migrated databases silently
divergent because `schema_migrations` would still report the version as applied.

See `docs/DISASTER_RECOVERY.md` for backup retention, RPO/RTO targets and the restore drill.

## Migrating locally

Start PostgreSQL and apply every pending migration:

```powershell
pnpm dev:infra
pnpm db:migrate            # uses DATABASE_URL
```

`scripts/migrate.mjs` also accepts an explicit target:

```powershell
node scripts/migrate.mjs --database-url postgresql://alex_rewards:local-alex-rewards-only@localhost:5432/alex_rewards
```

The same logic is exported from `@alex-rewards/db` for programmatic use:

```ts
import { migrateDatabase } from '@alex-rewards/db';

const result = await migrateDatabase(process.env.DATABASE_URL);
```

Applying an already-migrated database is a no-op: applied versions are skipped, and
`0011_seed_local_fixtures.sql` is written so that re-running it inserts nothing new.

### Phase 2 migration tests

`packages/db/test/phase2-migrations.test.ts` proves the baseline end to end: a clean migrate from
zero, idempotent re-apply, the absence of any balance shortcut, Founder-number and single-active-
membership uniqueness, atomic claim-code consumption, ledger immutability and positive-amount
enforcement, `NULLS NOT DISTINCT` platform-account collision, provider limit overlap and version
uniqueness, Outbox/Inbox/idempotency uniqueness, the full required-table set, `BIGINT` typing of
every `%_atomic` column, and seed-fixture hygiene.

The suite is **destructive** — it runs `DROP SCHEMA public CASCADE` before applying migrations — so
it only runs against a database that was explicitly nominated for it:

```powershell
# Preferred: a dedicated Phase 2 test database.
$env:PHASE2_DATABASE_URL = 'postgresql://alex_rewards:local-alex-rewards-only@localhost:5432/alex_rewards_phase2'
pnpm test:phase2

# Or opt in explicitly for the database in DATABASE_URL.
pnpm test:phase2   # sets PHASE2_MIGRATION_TESTS=1
```

With neither `PHASE2_DATABASE_URL` nor `PHASE2_MIGRATION_TESTS=1` present the suite is skipped, so
a routine `pnpm test` can never wipe a developer's database.

## Conventions

- Money is `BIGINT` in atomic units with an `_atomic` suffix. Amounts that must be positive carry
  `CHECK (... > 0)`; balances, fees and projections may be zero or negative where that is
  meaningful.
- Primary keys are `UUID DEFAULT app_generate_uuid()`, which resolves to `pg_catalog.uuidv7()` on
  PostgreSQL 18 and falls back to `gen_random_uuid()` on older servers.
- Timestamps are `TIMESTAMPTZ`. `updated_at` is maintained by the `app_set_updated_at()` trigger.
- Domain vocabularies are PostgreSQL `ENUM` types; free text is used only where the vocabulary is
  provider- or integration-defined.
- Append-only tables (ledger transactions and entries, audit logs, chain observations, risk and
  trust snapshots, grant/review/support history) reject `UPDATE` and `DELETE` by trigger.
- Only hashes, verifiers and secret-manager references are stored. No password, seed phrase,
  private key, provider secret or raw bearer token is ever written to PostgreSQL.
