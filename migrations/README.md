# Explicit SQL migrations

Phase 1 intentionally contained no SQL migration. Phase 2 adds the approved database
baseline as ordered, immutable explicit SQL files named `NNNN_lower_snake_case.sql`.
`scripts/validate-migrations.mjs` enforces naming, strictly increasing ordering,
`BEGIN;`/`COMMIT;` transaction markers and the prohibition on a mutable `users.balance`
column.

Phase 2 is **schema only**. No reward issuance, ledger posting, withdrawal, payout or
provider business behaviour is implemented here.

## Phase 2 baseline

| File                                                 | Contents                                                                                                                                                      |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0001_extensions_enums.sql`                          | `pgcrypto`, `btree_gist`, `schema_migrations`, shared helper functions, all ENUM types                                                                        |
| `0002_networks_assets_users.sql`                     | networks, assets, users, profiles, settings, sessions, wallets, ton_proof nonces                                                                              |
| `0003_ads_and_rewards.sql`                           | providers, manifests, units, ad sessions and evidence, daily counters, reward rules/quotes/budgets/events/maturities                                          |
| `0004_ledger.sql`                                    | immutable double-entry ledger, balance projection, balance snapshots                                                                                          |
| `0005_withdrawals_and_hot_wallet.sql`                | fee/limit rule versions, quotes, withdrawals, approvals, attempts, chain correlation, hot wallets, leases                                                     |
| `0006_risk_referral_tasks_missions.sql`              | risk rules/profiles/snapshots/events, fraud flags, referral graph, tasks, mission engine                                                                      |
| `0007_admin_audit_system.sql`                        | admin identity/RBAC/credentials/sessions/action tokens, audit log, Telegram + payout publications, Outbox/Inbox, idempotency keys, config versions            |
| `0008_membership_entitlements.sql`                   | membership plans, entitlements, benefit rule versions, user memberships, claim codes, grant history, bonus budgets                                            |
| `0009_provider_v12_ops.sql`                          | provider contracts, limit rules, country rules, routing policy versions, certification, settlement, reporting imports, trust snapshots, eligibility decisions |
| `0010_review_notifications_flags_reconciliation.sql` | support, review cases, notifications and campaigns, feature flags, exposure limits, reconciliation                                                            |
| `0011_seed_local_fixtures.sql`                       | LOCAL FIXTURE ONLY reference data                                                                                                                             |
| `0012_ledger_integrity.sql`                          | Phase 4: one-reversal-per-original unique index; ledger_accounts structural immutability trigger                                                              |
| `0013_reward_engine_integrity.sql`                   | Phase 5: reward-rule ACTIVE overlap EXCLUDE; financial immutability triggers; quote applied_economics / source_started_at / bonus policy                      |

## Conventions

- Money is `BIGINT` in atomic units with a `_atomic` suffix. Amounts that must be
  positive carry `CHECK (... > 0)`; balances, fees and projections may be zero.
- There is no authoritative mutable user balance anywhere. Pending, Available and
  Reserved are derived from `ledger_entries` through `ledger_account_balances`.
- Primary keys are `UUID DEFAULT app_generate_uuid()`. That helper resolves to
  `pg_catalog.uuidv7()` on PostgreSQL 18 and falls back to `gen_random_uuid()` on
  older servers, so the same DDL runs on both.
- Domain enumerations are PostgreSQL `ENUM` types. Free-form text columns are used only
  where the vocabulary is provider- or integration-defined.
- Immutable and append-only tables (ledger transactions/entries, audit logs, chain
  observations, risk and trust snapshots, grant/review/support history) reject `UPDATE`
  and `DELETE` through the `app_reject_row_mutation()` trigger.
- Effective-dated rule tables use versioned rows plus `EXCLUDE USING gist` constraints so
  two `ACTIVE` versions of the same dimension can never overlap in time.
- Production financial values (reward economics, fees, limits, budgets, Founder bonus
  rates) are stored as approved rule versions at runtime. None are baked into the schema
  and none are seeded.

## Ordering and foreign keys

Files apply in ascending numeric order and each one is a single transaction. A few
foreign keys point at tables created in a later file; those constraints are attached with
`ALTER TABLE ... ADD CONSTRAINT` in the migration that creates the target table:

- `0004` attaches `reward_events` to `ledger_transactions`.
- `0006` attaches `withdrawals.risk_snapshot_id` to `risk_snapshots`.
- `0007` attaches the ad evidence tables to `inbox_events` and every `*_admin_id` column
  created in `0003`, `0005` and `0006` to `admin_users`.
- `0008` attaches `reward_quotes.membership_id` and
  `mission_versions.required_membership_plan_id` to the membership tables.

Naming clarification: spec §99 lists `roles`, `permissions` and `admin_role_bindings`.
They exist here as `admin_roles`, `admin_permissions`, `admin_role_permissions` and
`admin_role_bindings` so the admin authority family stays unambiguous in a single shared
schema. Semantics are unchanged.

## Local fixtures

`0011_seed_local_fixtures.sql` inserts only local/test reference data: the TON testnet
network, a placeholder testnet USDT asset with `decimals = 6`, native TON, the `STANDARD`
and `FOUNDER_LIFETIME` plans, the entitlement vocabulary, the RBAC role vocabulary and
LOCAL feature flags that all default to disabled. It contains no mainnet identifier, no
real Jetton master address, no secret and no admin account. Every insert is idempotent, so
re-running it against a seeded database is safe.

## Applying and rolling back

Apply files in order inside a single transaction each, for example:

```sh
for f in migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

Each file records itself in `schema_migrations`. Because every file is transactional, a
failed migration leaves the database at the previous version with nothing partially
applied. Forward-only recovery is the rule: there are no down migrations, and a defect is
corrected by a new numbered migration. Restoring from a backup snapshot taken before the
release is the rollback path for a migration that has already committed.
