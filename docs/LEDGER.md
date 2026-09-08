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

## Atomic posting algorithm

`postLedgerTransaction(db, command)`:

1. Validate input; resolve asset and accounts (catalogue get-or-create or by id).
2. Verify every account asset matches the transaction asset; amounts > 0.
3. Require debit total === credit total (bigint arithmetic only).
4. Lock `ledger_account_balances` in **deterministic ledger-account-ID order**.
5. Enforce idempotency + business-reference uniqueness (recover exact intent; conflict otherwise).
6. Apply normal-side deltas; reject protected Pending/Available/Reserved if resulting balance < 0.
7. Insert immutable transaction + entries; update projections (`version++`, `last_ledger_transaction_id`).
8. Any failure rolls back everything.

Pass a `PoolClient` so domain + ledger + Outbox can share **one** PostgreSQL transaction. Pass a `Pool` to let the ledger open/commit its own transaction.

## Balance math

- Debit-normal: `balance = debits − credits`
- Credit-normal: `balance = credits − debits`
- Per-entry delta from `account.normal_side` + `entry.direction` only (never ad-hoc signs outside the primitive)

## Idempotency & business reference

- Authoritative uniqueness: `(idempotency_scope, idempotency_key)` and `(transaction_type, business_reference_type, business_reference_id)`
- Exact retry → return original posted transaction (`created: false`)
- Same key / different intent → `IDEMPOTENCY_CONFLICT` or `BUSINESS_REFERENCE_CONFLICT`
- Inserts use SAVEPOINT so unique violations do not abort the outer composition transaction

## Reversals

- New transaction; directions swapped; same amounts/asset; `reverses_transaction_id` set
- Migration `0012` unique index: at most one direct reversal per original
- Concurrent double-reversal → exactly one economic reversal

## Projection rebuild & invariants

- `rebuildAccountProjections` / `compareProjectionsToStored` — read-only; never auto-repair
- `checkLedgerInvariants` — CRITICAL findings for unbalanced txs, asset mismatch, negative protected buckets, projection drift, multi-reversal, etc.

## Schema (Phase 4)

- Does **not** edit `0001`–`0011`
- Adds `0012_ledger_integrity.sql`: one-reversal unique index; structural immutability trigger on `ledger_accounts` (status still mutable)

## Money representation

- PostgreSQL `BIGINT` atomic units only
- Domain uses `bigint`; API/contracts use `amountAtomic` **string**
- Rejects 0, negatives, fractions, NaN, Infinity, unsafe JS `Number`

## Security

No public endpoint accepts arbitrary ledger mutations. Phase 3 auth does not authorize direct ledger posting. Logs may include transaction/account/asset IDs and amount strings — never tokens, initData, or claim codes.

## Production DB permissions

Application roles used for posting must not hold `UPDATE`/`DELETE` on `ledger_transactions` / `ledger_entries`. Database triggers (`app_reject_row_mutation`) remain mandatory defense-in-depth.
