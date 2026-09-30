# Explicit SQL migrations

Phase 1 intentionally contained no SQL migration. Phase 2 adds the approved database
baseline as ordered, immutable explicit SQL files named `NNNN_lower_snake_case.sql`.
`scripts/validate-migrations.mjs` enforces naming, strictly increasing ordering,
`BEGIN;`/`COMMIT;` transaction markers and the prohibition on a mutable `users.balance`
column.

Phase 2 is **schema only**. No reward issuance, ledger posting, withdrawal, payout or
provider business behaviour is implemented here.

## Phase 2 baseline

| File                                                 | Contents                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001_extensions_enums.sql`                          | `pgcrypto`, `btree_gist`, `schema_migrations`, shared helper functions, all ENUM types                                                                                                                                                                       |
| `0002_networks_assets_users.sql`                     | networks, assets, users, profiles, settings, sessions, wallets, ton_proof nonces                                                                                                                                                                             |
| `0003_ads_and_rewards.sql`                           | providers, manifests, units, ad sessions and evidence, daily counters, reward rules/quotes/budgets/events/maturities                                                                                                                                         |
| `0004_ledger.sql`                                    | immutable double-entry ledger, balance projection, balance snapshots                                                                                                                                                                                         |
| `0005_withdrawals_and_hot_wallet.sql`                | fee/limit rule versions, quotes, withdrawals, approvals, attempts, chain correlation, hot wallets, leases                                                                                                                                                    |
| `0006_risk_referral_tasks_missions.sql`              | risk rules/profiles/snapshots/events, fraud flags, referral graph, tasks, mission engine                                                                                                                                                                     |
| `0007_admin_audit_system.sql`                        | admin identity/RBAC/credentials/sessions/action tokens, audit log, Telegram + payout publications, Outbox/Inbox, idempotency keys, config versions                                                                                                           |
| `0008_membership_entitlements.sql`                   | membership plans, entitlements, benefit rule versions, user memberships, claim codes, grant history, bonus budgets                                                                                                                                           |
| `0009_provider_v12_ops.sql`                          | provider contracts, limit rules, country rules, routing policy versions, certification, settlement, reporting imports, trust snapshots, eligibility decisions                                                                                                |
| `0010_review_notifications_flags_reconciliation.sql` | support, review cases, notifications and campaigns, feature flags, exposure limits, reconciliation                                                                                                                                                           |
| `0011_seed_local_fixtures.sql`                       | LOCAL FIXTURE ONLY reference data                                                                                                                                                                                                                            |
| `0012_ledger_integrity.sql`                          | Phase 4: one-reversal-per-original unique index; ledger_accounts structural immutability trigger                                                                                                                                                             |
| `0013_reward_engine_integrity.sql`                   | Phase 5: reward-rule ACTIVE overlap EXCLUDE; financial immutability triggers; quote applied_economics / source_started_at / bonus policy                                                                                                                     |
| `0014_phase5_financial_corrections.sql`              | Phase 5 correction: simulated_reward_sources; frozen quote trigger; multi-period bonus reservations; economic exposure period counters                                                                                                                       |
| `0015_budget_period_utc_window_integrity.sql`        | Phase 5 narrow: canonical HOUR/UTC_DAY/UTC_MONTH window CHECKs for reward + membership bonus budget periods                                                                                                                                                  |
| `0016_wallet_proof_nonce_lifecycle.sql`              | Phase 6: `invalidated_at` / `invalidation_reason` so CONSUMED vs SECURITY_INVALIDATED stay distinct for primary-wallet change                                                                                                                                |
| `0017_withdrawal_engine_integrity.sql`               | Phase 7: withdrawal quote/withdrawal provenance; fee/limit ACTIVE overlap EXCLUDE + financial immutability triggers; frozen quotes; `withdrawal_volume_periods` / reservations; append-only `withdrawal_payout_reconciliations`; attempt intent immutability |
| `0018_membership_plan_entitlement_rule_binding.sql`  | Phase 7.1: `membership_plan_entitlements` trigger binding rule entitlement/plan to mapping (no new tables)                                                                                                                                                   |
| `0019_control_center_security_integrity.sql`         | Phase 8: `CONTROL_CENTER_AUDIT` / `CONTROL_CENTER_SYSTEM` purposes; action-token expected_state, destination/chat/topic, nonce, confirmation parent; OWNER permission catalog                                                                                |
| `0020_signer_read_boundary.sql`                      | Phase 9: Hot Wallet payout Jetton wallet snapshot column; narrow `signer_withdrawal_attempt_signing_v`; `alex_rewards_signer_ro` read-only role                                                                                                              |
| `0021_phase10_broadcast_evidence.sql`                | Phase 10: additive nullable `signed_external_message_boc` / `broadcast_submitted_at` / `broadcast_ambiguity_class` on `withdrawal_attempts` (intent immutability from 0017 unchanged)                                                                        |
| `0022_external_message_identity.sql`                 | Phase 10: additive nullable signed Wallet request BOC, final External-In cell hash, and Tonkeeper-normalized message hash evidence                                                                                                                           |
| `0023_attempt_requires_state_init.sql`               | Phase 10: additive `requires_state_init` on `withdrawal_attempts` + signer view (StateInit bound to proven uninit admission, not seqno=0 alone)                                                                                                              |
| `0024_owner_admin_auth_hardening.sql`                | Owner admin auth: additive `totp_last_accepted_step` on `admin_credentials`; `admin_auth_throttle` for persistent attempt lockouts                                                                                                                           |
| `0025_single_owner_authority.sql`                    | M0: `admin_owner_authority` singleton seat + trigger + partial unique index — at most one effective OWNER binding; vacant seat = pre-bootstrap; revoke does not enable informal transfer                                                                         |
| `0026_owner_bootstrap_grants.sql`                    | M1 Stage B: `owner_bootstrap_grants` / `owner_bootstrap_attempts` enrollment ledger (no secrets)                                                                                                                                                             |
| `0027_signer_login_isolation.sql`                    | Phase 10 S-05: dedicated LOGIN `alex_rewards_signer` inheriting `alex_rewards_signer_ro`; password provisioned outside migrations                                                                                                                             |
| `0028_owner_bootstrap_attempt_nonce_attempt_wide.sql`| Owner bootstrap attempt-wide nonce integrity                                                                                                                                                                                                                 |
| `0029_hot_wallet_jetton_asset.sql`                   | Hot wallet Jetton asset binding                                                                                                                                                                                                                              |
| `0030_phase11_adsgram_foundation.sql`                | Phase 11: AdsGram provider foundation (BLOCKED monetary) + quote↔session FK correction                                                                                                                                                                       |
| `0031_phase13_admin_webauthn_challenges.sql`         | Phase 13: `admin_webauthn_challenges` one-time WebAuthn ceremony rows (no RP ID defaults)                                                                                                                                                                    |
| `0032`–`0043`                                        | Phase 13/14 forward migrations (admin WebAuthn session bind, fraud/risk/trust/eligibility integrity)                                                                                                                                                         |
| `0044_phase15_referral_rule_integrity.sql`           | Phase 15 Step 1: `referral_rule_versions` + edge/code/reward-event integrity; `reward_rules.referral_eligible` (no seeds / no money)                                                                                                                          |
| `0045_phase15_referral_reference_hardening.sql`      | Phase 15 Step 1.1: terminal edge provenance freeze; orphan referral-rule FK fail-closed; VALIDATE edge/reward-event rule FKs                                                                                                                                 |
| `0046_phase15_referral_rate_provenance.sql`          | Phase 15 Step 4: `referral_reward_events` rate_source + membership entitlement provenance (no seeds / no money)                                                                                                                                              |
| `0047_phase15_referral_reward_issuance.sql`          | Phase 15 Step 5: `referral_reward_decisions` + `referral_bonus_exposure_reservations` (no production budget seed / no money)                                                                                                                                 |
| `0048_phase15_referral_code_policy.sql`              | Phase 15 Step 7: `referral_code_policy_versions` + `referral_codes.generation_policy_version` (no production alphabet/length seed)                                                                                                                          |
| `0049_phase15_referral_remediation.sql`              | Phase 15 remediation: referenced code-policy effective_to safe closure; `referral_reward_decisions` rule/membership provenance columns (no production seeds / no money)                                                                                    |
| `0050_phase15_telegram_referral_transport.sql`       | Phase 15 micro-fix: Telegram start-param transport — code_length <= 60; alphabet [A-Za-z0-9_-] only (no seeds / no rewrite)                                                                                                                              |
| `0051_phase16_mission_integrity.sql`                 | Phase 16 Step 1: mission_* authority + semantic freeze, ACTIVE GiST exclusion, safe end_at, progress/claims integrity + append-only events; task_reward_events append-only (no seeds / no money)                                                          |
| `0052_phase16_mission_lifecycle_hardening.sql`       | Phase 16 Step 1.1: started_at one-shot; progress-event FOR SHARE + `[start_at,end_at)` window; safe end_at includes contribution occurred_at; claim-event actor provenance (no seeds / no money)                                                           |
| `0053_phase16_mission_reward_issuance.sql`           | Phase 16 Step 5: `mission_reward_decisions` + mission budget/exposure reservations (no production budget seed / no money)                                                                                                                                   |
| `0054_phase16_mission_runtime_financial_hardening.sql` | Phase 16 remediation: multi-exposure reservations + decision provenance; streak producer checkpoints (no production seeds / no money)                                                                                                                    |
| `0055_phase16_final_integrity.sql`                     | Phase 16 final: append-only UPDATE/DELETE rejection on `mission_reward_decision_exposure_periods` (no seeds / no money)                                                                                                                                  |
| `0056_phase17_payout_publication_integrity.sql` | Phase 17 Step 1: `payout_publication_status` + delivery lease/privacy fields; immutability + transition guards; no seeds / no Telegram send / no historical backfill |
| `0057_phase17_publication_identity_freeze.sql` | Phase 17 Step 1.1: freeze identity after SENDING; lease-only-SENDING; truthful identity_frozen_at; no seeds / no Telegram send |
| `0058_phase17_publication_delivery_snapshot.sql` | Phase 17 Step 2: delivery snapshot columns + tighter SENDING/AMBIGUOUS/PUBLISHED CHECK; DB-owned SENDING clocks; freeze message/explorer/send_request; no seeds / no Telegram send |
| `0054_phase16_mission_runtime_financial_hardening.sql` | Phase 16 MEGA remediation: multi-exposure reservations per claim, decision↔exposure provenance, streak producer fairness checkpoints (no seeds / no money)                                                                                                  |

Migrations `0001`–`0026` remain immutable. Signer login isolation is added only by
forward migration `0027` (local provision script sets password; ops credential rotation
requires separate Owner approval — see `docs/SIGNER_DB_PRIVILEGE_ISOLATION.md`).

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
