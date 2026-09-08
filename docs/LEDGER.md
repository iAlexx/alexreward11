# Ledger Core

Phase 4 implements the immutable PostgreSQL double-entry Ledger Core.

## Authority model

| Layer                                    | Role                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `ledger_transactions` + `ledger_entries` | **Financial source of truth** (immutable)                                                                             |
| `ledger_account_balances`                | Transactionally maintained projection, concurrency lock surface, rebuildable read model — **never independent truth** |
| `ledger_balance_snapshots`               | Performance/history projection only                                                                                   |
| Redis                                    | **Zero** ledger authority                                                                                             |

Corrections are **new** linked transactions (`reverses_transaction_id`). Originals are never updated or deleted.

## Account catalogue

Callers cannot invent `account_class` / `normal_side` / `owner_type`. Semantics are centralized in `@alex-rewards/ledger` catalogue:

| Type                                                                                                                                | Owner    | Class     | Side   |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- | ------ |
| `USER_*_LIABILITY`                                                                                                                  | USER     | LIABILITY | CREDIT |
| `*_REWARD_EXPENSE`, `MEMBERSHIP_BONUS_EXPENSE`, `TON_NETWORK_FEE_EXPENSE`, `SUPPORT_COMPENSATION_EXPENSE`, `EXPLICIT_PLATFORM_LOSS` | PLATFORM | EXPENSE   | DEBIT  |
| `WITHDRAWAL_FEE_REVENUE`, `AD_REVENUE`                                                                                              | PLATFORM | REVENUE   | CREDIT |
| `AD_NETWORK_RECEIVABLE`                                                                                                             | PLATFORM | ASSET     | DEBIT  |
| `HOT_WALLET_*_ASSET`                                                                                                                | WALLET   | ASSET     | DEBIT  |

`TREASURY_FUNDING_CLEARING` and `INVALID_TRAFFIC_RECOVERY` remain in the enum but **refuse silent provision** (`OWNER_DECISION_REQUIRED`) until an explicit Owner accounting decision (V1.2 §24).

`MEMBERSHIP_BONUS_EXPENSE` is provisionable for classification/tests. Phase 4 does **not** issue Founder/membership bonus domain events.

### Account-type / asset compatibility

Catalogue get-or-create and posting load **authoritative** asset rows from PostgreSQL (`id`, `symbol`, `network_id`, `is_native`, `status`, `contract_identity`) and enforce:

| Account type              | Required asset                           |
| ------------------------- | ---------------------------------------- |
| `HOT_WALLET_USDT_ASSET`   | ACTIVE non-native `USDT`                 |
| `HOT_WALLET_TON_ASSET`    | ACTIVE native `TON`                      |
| `TON_NETWORK_FEE_EXPENSE` | ACTIVE native `TON`                      |
| Other catalogue types     | Any ACTIVE asset (still single-asset tx) |

Posting or provisioning against a non-`ACTIVE` asset fails with `ASSET_INACTIVE`. Incompatible combinations fail with `ASSET_INCOMPATIBLE`. Callers cannot invent compatibility by string comparison alone.

## Atomic posting algorithm

`postLedgerTransaction(db, command)`:

1. Validate input; require ACTIVE asset; resolve accounts (catalogue get-or-create or by id).
2. Verify every account asset matches the transaction asset; amounts > 0.
3. Require debit total === credit total (bigint arithmetic only).
4. Lock `ledger_account_balances` in **deterministic ledger-account-ID order**.
5. Enforce idempotency + business-reference uniqueness (recover exact intent; conflict otherwise).
6. Apply normal-side deltas; reject protected Pending/Available/Reserved if resulting balance < 0.
7. Insert immutable transaction + entries; update projections (`version++` once per touched account, `last_ledger_transaction_id`).
8. Any failure rolls back everything.

Pass a `PoolClient` so domain + ledger + Outbox can share **one** PostgreSQL transaction. Pass a `Pool` to let the ledger open/commit its own transaction.

**Public `PostLedgerCommand` does not accept `reversesTransactionId`.** Linked reversals go through `reverseLedgerTransaction` → `postLedgerTransactionWithReversalLink`, which enforces exact economic reversal **before** insert.

## Balance math

- Debit-normal: `balance = debits − credits`
- Credit-normal: `balance = credits − debits`
- Per-entry delta from `account.normal_side` + `entry.direction` only (never ad-hoc signs outside the primitive)

## Idempotency & business reference

- Authoritative uniqueness: `(idempotency_scope, idempotency_key)` and `(transaction_type, business_reference_type, business_reference_id)`
- Exact retry → return original posted transaction (`created: false`)
- Same key / different intent → `IDEMPOTENCY_CONFLICT` or `BUSINESS_REFERENCE_CONFLICT`
- Intent fingerprint is an **order-independent economic multiset** (`ledgerAccountId`, `direction`, `amountAtomic`). Caller `entryIndex` / array order is **not** part of financial identity.
- Inserts use SAVEPOINT so unique violations do not abort the outer composition transaction

## Reversals

- Prefer `reverseLedgerTransaction`: builds swapped entries and posts via the guarded linked path
- Exact reversal validation (order-safe multiset): same accounts, same amounts, every DEBIT↔CREDIT; no extras/missing lines
- Malformed linked attempts fail with `REVERSAL_INVALID` **before** `ledger_transactions` insert — they do **not** consume the one-reversal unique slot
- Migration `0012` unique index: at most one direct reversal per original
- Concurrent double-reversal → exactly one economic reversal

## Projection rebuild & invariants

### Semantics (no migration `0013`)

PostgreSQL may assign the **same** `posted_at` to multiple `ledger_transactions` created inside one outer DB transaction. Therefore UUID/`entry_index` ordering is **not** durable financial chronology across same-timestamp ties.

| Field                        | Meaning                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `balance_atomic`             | Exact rebuild from immutable entries using normal-side deltas                                                                                              |
| `version`                    | Count of **DISTINCT** posted ledger transactions that touched the account (multi-line tx counts once)                                                      |
| `last_ledger_transaction_id` | Must be `NULL` iff no financial history; if set, must touch the account and belong to the latest `posted_at` cohort (any candidate in a tie is acceptable) |

Rebuild/compare are **tie-aware**: they do not invent a total order by random UUID among same-`posted_at` rows. Invariant checker compares stored `version` to independently counted distinct transactions and validates last-pointer without false CRITICAL on same-timestamp multi-posts.

`checkLedgerInvariants` is read-only. It also flags transactions with fewer than two entries, unrelated last pointers, zero-history metadata drift, unbalanced txs, asset mismatches, negative protected buckets, and non-exact reversals.

## Schema (Phase 4)

- Does **not** edit `0001`–`0012` for this correction
- No `0013` added — projection chronology uses Option 1 (tie-aware validation)
- Historical `0012_ledger_integrity.sql` remains: one-reversal unique index; structural immutability trigger on `ledger_accounts` (status still mutable)

## Money representation

- PostgreSQL `BIGINT` atomic units only
- Domain uses `bigint`; API/contracts use `amountAtomic` **string**
- Rejects 0, decimals, fractions, NaN, Infinity, unsafe JS `Number`

## Security

No public endpoint accepts arbitrary ledger mutations. Phase 3 auth does not authorize direct ledger posting. Logs may include transaction/account/asset IDs and amount strings — never tokens, initData, or claim codes.

## Production DB permissions

Application roles used for posting must not hold `UPDATE`/`DELETE` on `ledger_transactions` / `ledger_entries`. Database triggers (`app_reject_row_mutation`) remain mandatory defense-in-depth.
