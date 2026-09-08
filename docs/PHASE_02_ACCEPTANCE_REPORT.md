# ALEx Rewards Phase 2 Acceptance Report

Status: **PASS** — Phase 2 database baseline is complete; GitHub Actions `quality` and `docker-smoke` are green on the accepted archival commit. Dual archive packaging follows; Phase 3 must not start until Owner approval.

Date: 2026-09-08

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**. Version 1.1 safety baseline remains in force where unchanged.

| Item                               | Value                                                           |
| ---------------------------------- | --------------------------------------------------------------- |
| Final accepted archival commit SHA | `c57684c850c654e681369ccbd79a8c36035aea23`                      |
| GitHub Actions run                 | https://github.com/iAlexx/alexreward11/actions/runs/34185365578 |
| `quality`                          | PASS — job `101932520340`                                       |
| `docker-smoke`                     | PASS — job `101932856990`                                       |

Phase 3 has not started. Phase 2 is **schema only**.

## A. Exact scope of Phase 2

Delivered:

- The complete V1.2 relational baseline as 11 ordered, immutable explicit SQL migrations in `migrations/`.
- Migration bookkeeping (`schema_migrations`), shared helper functions, and the append-only guard trigger.
- A migration runner (`scripts/migrate.mjs`, `pnpm db:migrate`) and the same logic exported programmatically from `@alex-rewards/db` as `migrateDatabase()`.
- LOCAL FIXTURE ONLY seed data: TON testnet network, a placeholder testnet USDT asset and native TON, the `STANDARD` and `FOUNDER_LIFETIME` plans, the entitlement vocabulary, the RBAC role vocabulary, and LOCAL feature flags that all default to disabled.
- A database-backed verification suite proving the schema's financial and security invariants.
- Documentation: `docs/DATABASE.md` (including the logical ERD), `migrations/README.md`, and this report.

Explicitly **not** delivered, and forbidden until the Owner approves the relevant later phase:

- No ledger posting engine, reward issuance, reward maturity processing, or reversal engine.
- No withdrawal request, risk decision, approval, quote consumption, payout dispatch, or TON broadcast logic.
- No AdsGram or any other provider adapter, callback verification, or monetary issuance.
- No KMS signing capability; `apps/signer` remains isolated and signing-disabled.
- No membership purchase, claim-code issuance/consumption service, or entitlement resolver.
- No admin authentication, RBAC enforcement, or Control Center actions.
- No production reward/payout rule rows were seeded in Phase 2. Initial values already locked by V1.2 remain authoritative and will be instantiated/versioned by their owning implementation phase. Values explicitly marked `OWNER_DECISION_REQUIRED` or proposed remain unset.

No Phase 3+ behaviour is present in this commit.

## B. Schema inventory

| Metric                                                 | Count |
| ------------------------------------------------------ | ----: |
| Migration files                                        |    11 |
| SQL lines                                              | 3,879 |
| Tables (including `schema_migrations`)                 |   108 |
| ENUM types                                             |    97 |
| Indexes (explicit `CREATE [UNIQUE] INDEX`)             |   106 |
| Triggers                                               |    86 |
| Append-only guard triggers (`app_reject_row_mutation`) |    23 |
| `UNIQUE NULLS NOT DISTINCT` constraints                |    16 |
| `EXCLUDE USING gist` no-overlap constraints            |     4 |
| Atomic money columns (`%_atomic`, all `BIGINT`)        |    77 |

Per-file contents are tabulated in `docs/DATABASE.md` and `migrations/README.md`.

## C. Files changed

Added:

- `migrations/0001_extensions_enums.sql` … `migrations/0011_seed_local_fixtures.sql`
- `scripts/migrate.mjs`
- `packages/db/src/migrate.ts`
- `packages/db/test/phase2-migrations.test.ts`
- `docs/PHASE_02_ACCEPTANCE_REPORT.md`

Modified:

- `package.json` — added `db:migrate`, `db:migrate:test`, and `test:phase2`.
- `packages/db/package.json` — `test` is now `vitest run` (the `--passWithNoTests` escape hatch is gone) and `test:phase2` runs the migration suite.
- `packages/db/src/index.ts` — exports `migrateDatabase`, `listMigrationFiles`, and `defaultMigrationsDirectory` alongside the existing pool/probe helpers.
- `scripts/validate-migrations.mjs` — reports "Phase 2 SQL migrations" and now rejects any qualified `users.balance` reference and any `*balance*` column defined on `users`, ignoring SQL comments.
- `migrations/README.md`, `docs/DATABASE.md` — Phase 2 schema documentation and logical ERD.
- `AGENTS.md` — records that the Phase 2 schema may exist while the posting, reward, and withdrawal engines remain forbidden.
- `.github/workflows/ci.yaml` — `quality` provisions PostgreSQL 18.6 and runs `pnpm test:phase2`.

`phase-archives/` was not modified.

## D. Authority and invariant decisions

- **The ledger is money truth.** `ledger_transactions` and `ledger_entries` reject `UPDATE` and `DELETE` at the database level. Amounts are positive `BIGINT` atomic units; `direction` carries the sign. Corrections are new reversal transactions linked by `reverses_transaction_id`.
- **No mutable authoritative balance exists.** `users` has no `balance` column and no shortcut of any other name. `ledger_account_balances` and `ledger_balance_snapshots` are transactionally maintained, fully rebuildable projections.
- **Evidence never credits money.** Client events, provider signals, inbox callbacks, and provider reporting imports are inputs to verification and reconciliation only.
- **`review_cases` is an operational projection.** Acting on a case calls the authoritative domain command and passes its state, permission, and invariant checks.
- **Redis is never an authority.** Authoritative counters (`ad_daily_counters`), idempotency (`idempotency_keys`, `ledger_transactions_idempotency_key`), and cross-service delivery (`outbox_events` / `inbox_events`) all live in PostgreSQL.
- **Rules are versioned data.** Economics, fees, limits, country rules, routing weights, and membership benefits are effective-dated versions carrying a source, reason, and approver. `provider_limit_rules` additionally refuses to make a `PROVIDER_HARD` or `CONTRACT` limit `ACTIVE` without an approver.
- **Founder status is a membership benefit product.** No equity, ownership, debt instrument, guaranteed return, or promise to recover the purchase price is expressed anywhere in the schema. Founder status never implies trusted, and trust never overrides a critical fraud block.
- **Only hashes, verifiers, and secret-manager references are stored.** No password, seed phrase, private key, provider secret, or raw bearer token is written to PostgreSQL.

## E. Nullable uniqueness strategy

`UNIQUE NULLS NOT DISTINCT` is used where `NULL` means "the single platform-scoped row" and a second one must collide — notably `ledger_accounts_identity_key`, so two PLATFORM accounts of the same type and asset with `owner_id IS NULL` are rejected.

Plain `UNIQUE` is used where `NULL` means "not applicable" — notably `user_memberships_founder_number_key`, where Founder numbers are unique and permanent while every non-Founder membership carries `founder_number IS NULL` and any number of those may coexist.

Partial unique indexes express "at most one live row" without deleting history (one `ACTIVE` membership per user per plan, one consumed claim code per user, one primary wallet per user per network, one open review case per resource).

`EXCLUDE USING gist` prevents two `ACTIVE` versions of the same effective-dated dimension from overlapping in time.

The full mapping is in `docs/DATABASE.md`.

## F. Rollback and recovery

Migrations are forward-only; there are no down migrations. Each file is a single transaction that records its own version, so a failed migration leaves the database at the previous version with nothing partially applied.

A committed migration is never reversed in place. Recovery is: stop writes, restore the pre-release backup or use point-in-time recovery, re-apply migrations forward (including a new corrective migration), rebuild projections from `ledger_entries`, and record the decision in `docs/DECISIONS.md`. A shipped migration file is never edited, because already-migrated databases would silently diverge while still reporting the version as applied.

## G. Tests

`packages/db/test/phase2-migrations.test.ts` drops and recreates the `public` schema, applies all migrations from zero, and asserts:

1. Clean migrate from zero records all 11 versions in file order.
2. Re-running `applyAll` applies nothing, and re-executing the seed migration directly changes no row count.
3. `users` has no `balance` column.
4. `users` has no mutable balance shortcut column under any name.
5. `users.withdrawal_status` is `user_withdrawal_access_status NOT NULL DEFAULT 'ALLOWED'`.
6. A duplicate `founder_number` is rejected.
7. Multiple `NULL` `founder_number` values are accepted for `STANDARD` memberships.
8. A second `ACTIVE` membership for the same user and plan is rejected, while a non-`ACTIVE` history row is accepted.
9. `membership_claim_codes.created_by_admin_id` is `NOT NULL`, and a duplicate `code_hash` is rejected.
10. A `consumed_at` without both the consuming user and the granted membership is rejected on `INSERT` and on `UPDATE`.
11. A claim code is consumed exactly once: the guarded update matches one row, a replay matches zero rows, and binding a second code to an already granted membership is rejected.
12. One user cannot consume two claim codes.
13. Two PLATFORM `ledger_accounts` with a `NULL` owner, the same type, and the same asset collide under `NULLS NOT DISTINCT`; the owner-presence `CHECK` is enforced in both directions.
14. `ledger_entries.amount_atomic` rejects `0` and `-1`, and the `> 0` `CHECK` is present.
15. `UPDATE` and `DELETE` are rejected on `ledger_entries` and `ledger_transactions` with SQLSTATE `23001` and an "append-only" message.
16. Overlapping `ACTIVE` `provider_limit_rules` windows are rejected by the exclusion constraint; a duplicate version key is rejected; an unapproved `PROVIDER_HARD` rule cannot become `ACTIVE`.
17. `outbox_events`, `inbox_events` (including a `NULL` external id), and `idempotency_keys` reject duplicates, and the named constraints exist.
18. All 108 required V1.2 tables exist.
19. Every `%_atomic` column is `BIGINT`.
20. The seed migration carries LOCAL FIXTURE ONLY markers and matches no secret pattern, and seeds no admin credential, admin session, or benefit rule value.

The suite is destructive, so it runs only when `PHASE2_DATABASE_URL` is set, or when `DATABASE_URL` is combined with `PHASE2_MIGRATION_TESTS=1` (what `pnpm test:phase2` sets). Otherwise it is skipped so a routine `pnpm test` cannot wipe a developer's database.

**Result: 27/27 passed** against the pinned PostgreSQL `18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280` in a throwaway container. The migrated database was independently inspected and reported 11 recorded migration versions, 108 base tables, and 97 ENUM types. Both entry points were exercised: `PHASE2_DATABASE_URL` set directly, and `pnpm test:phase2` against `DATABASE_URL`. Without either signal the suite reports 27 skipped and `pnpm test` stays green.

The runner was verified separately against two further empty databases:

- `node scripts/migrate.mjs` applied all 11 migrations, and a second run applied 0 (`previouslyApplied: 11, appliedNow: 0`).
- `migrateDatabase()` exported from the built `@alex-rewards/db` returned all 11 versions on the first call and an empty `appliedNow` on the second.

## H. Static gates

Executed locally on this host:

| Gate                 | Command                    | Result                                                                                      |
| -------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| Full verify          | `pnpm verify`              | PASS — format, lint, typecheck, test, archive tests, build, boundaries, migrations, secrets |
| Migration validation | `pnpm validate:migrations` | PASS — 11 Phase 2 SQL migrations                                                            |
| Secret-pattern scan  | `pnpm security:secrets`    | PASS                                                                                        |
| Dependency audit     | `pnpm security:audit`      | PASS — no known high+ vulnerabilities                                                       |
| Phase 2 DB suite     | `pnpm test:phase2`         | PASS — 27/27 against PostgreSQL 18.6                                                        |

Remote gate (archival commit `c57684c850c654e681369ccbd79a8c36035aea23`): GitHub Actions run [34185365578](https://github.com/iAlexx/alexreward11/actions/runs/34185365578) — `quality` PASS (`101932520340`, including `pnpm verify` and `pnpm test:phase2` against Postgres 18.6) and `docker-smoke` PASS (`101932856990`).

The migration validator was additionally exercised against a negative fixture containing a `balance_atomic` column on `users`; it failed the build as required and passed again once the fixture was removed.

## I. Local migration procedure

```powershell
pnpm dev:infra
pnpm db:migrate
node scripts/migrate.mjs --database-url <url>   # explicit target
pnpm test:phase2                                 # destructive verification suite
```

`migrateDatabase(connectionString)` from `@alex-rewards/db` performs the same work programmatically.

## J. Security posture

- No secret, credential, seed phrase, private key, bot token, chat identifier, or signer reference appears in any migration.
- No mainnet identifier is seeded. The USDT contract identity in `0011` is the deliberately invalid placeholder `LOCAL-TESTONLY-PLACEHOLDER-USDT-JETTON-MASTER`; the controlled testnet Jetton master and the allowlisted mainnet USDT Jetton master remain deployment-controlled production blockers.
- No admin user, credential, recovery code, or session is seeded. Only the role vocabulary is created, and only `OWNER` is `ACTIVE`.
- All LOCAL feature flags, including every kill switch, are seeded disabled.
- Session, refresh, claim-code, recovery-code, and action-token material is stored as hashes or verifiers only.
- `user_settings` enforces `security_notifications_enabled` by `CHECK`; `notification_campaigns` refuses the `SECURITY` category so mandatory security notices cannot be routed through the campaign tool.

## K. Deviations from the specification

None affecting semantics. One naming clarification is carried forward from `migrations/README.md`: spec §99 lists `roles`, `permissions`, and `admin_role_bindings`; they exist as `admin_roles`, `admin_permissions`, `admin_role_permissions`, and `admin_role_bindings` so the admin authority family stays unambiguous in a single shared schema.

One tooling refinement beyond the literal instruction: the Phase 2 test suite requires an explicit opt-in before it will drop a schema, because `pnpm verify:local` exports `DATABASE_URL` from `.env` and would otherwise destroy a developer's local database during a routine verification run.

## L. Unresolved issues and technical debt

1. `db:migrate` and `db:migrate:test` currently resolve to the same runner. A dedicated throwaway test-database target remains a convenience improvement only; CI already provisions Postgres 18.6 and runs `pnpm test:phase2` in the `quality` job.
2. `scripts/migrate.mjs` resolves `pg` from the `@alex-rewards/db` workspace rather than a root dependency, so the root script stays runnable without adding a second copy of the driver to the lockfile. Promoting the runner into the `db` package would remove the indirection.

No source-level critical TODO, placeholder security implementation, mutable `users.balance`, signing capability, or Phase 3 business implementation is present.

## M. Acceptance criteria

| Phase 2 acceptance criterion                                   | Result |
| -------------------------------------------------------------- | ------ |
| Complete V1.2 schema exists as ordered explicit SQL migrations | PASS   |
| Clean migrate from zero succeeds                               | PASS   |
| Migrations are idempotent and forward-only                     | PASS   |
| No mutable authoritative balance anywhere                      | PASS   |
| Ledger immutability enforced by the database                   | PASS   |
| Membership, Founder, and claim-code invariants enforced        | PASS   |
| Provider limit versioning and no-overlap enforced              | PASS   |
| Outbox/Inbox/idempotency uniqueness enforced                   | PASS   |
| Seed contains no secret and no production value                | PASS   |
| No Phase 3+ behaviour introduced                               | PASS   |
| `quality` CI green on the archival commit                      | PASS   |
| `docker-smoke` CI green on the archival commit                 | PASS   |

## N. Acceptance conclusion

**PASS.** The Phase 2 schema, tooling, tests, and documentation are complete. Every local gate passes, all 27 database invariant assertions pass against the pinned PostgreSQL 18.6, and GitHub Actions `quality` + `docker-smoke` are green on archival commit `c57684c850c654e681369ccbd79a8c36035aea23` (run `34185365578`). Dual archive packaging and Section O complete the Owner review package. Phase 3 must not begin until explicit Owner approval after that package is presented.

## O. Archive verification

Verified for exact accepted commit `c57684c850c654e681369ccbd79a8c36035aea23` using `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260908-040500`). The outer review package was regenerated after documentation clarification commit `ac2817b00ae7578bcf947fc9dc89044fa5ff38ca` (CI run `34226156238`) so companions reflect locked V1.2 initial-value wording; the sealed canonical source ZIP was not rebuilt.

| Item                                                                   | Result                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Canonical source ZIP                                                   | `ALEx_Rewards_PHASE_02_DATABASE_BASELINE_20260908-040500_c57684c.zip`           |
| Canonical source SHA-256                                               | `f7cc68813f96c583f9d5dfc74de5b06579f3893576729ff929d388cef1efbe10` (unchanged)  |
| Review-package ZIP                                                     | `PHASE_02_DATABASE_BASELINE_PACKAGE_20260908-040500_c57684c.zip`                |
| Outer package SHA-256                                                  | See external `PACKAGE_SHA256.txt` beside the review package (not embedded here) |
| `MANIFEST.md` / `SHA256SUMS.txt`                                       | PASS — companion checksums match source ZIP, report, and manifest               |
| Source extraction / prohibited-path scan                               | PASS / PASS                                                                     |
| Review-package extraction / prohibited-path / nested source validation | PASS / PASS / PASS                                                              |
| Forward-slash ZIP entry names                                          | PASS — `PHASE_02_DATABASE_BASELINE/...` only                                    |

Per `AGENTS.md` and `docs/PHASE_ARCHIVE.md`, the SHA-256 of the **outer** review package is published beside it in `PACKAGE_SHA256.txt` and is deliberately **not** embedded in this section.
