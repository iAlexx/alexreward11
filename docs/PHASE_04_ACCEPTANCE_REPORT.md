# ALEx Rewards Phase 4 Acceptance Report

Status: **PASS** — Phase 4 Ledger Core complete pending CI green on the accepted archival commit.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                               | Value                                      |
| ---------------------------------- | ------------------------------------------ |
| Final accepted archival commit SHA | _(filled after CI-green push)_             |
| GitHub Actions run                 | _(filled after CI-green push)_             |
| `quality`                          | _(filled after CI)_                        |
| `docker-smoke`                     | _(filled after CI)_                        |
| Phase 3 accepted archival source   | `be08e7fe91309fe42da74d14558ebdaa353215e5` |

Phase 5 has not started. Phase 4 is Ledger Core only.

## A. Scope delivered

- Immutable double-entry posting (`postLedgerTransaction`)
- Catalogue-backed account get-or-create + balance projection row
- Deterministic account locking; protected bucket non-negativity
- Idempotency + business-reference recovery/conflict
- Linked reversals with at-most-one direct reversal (DB + app)
- Projection rebuild/compare; read-only invariant checker
- Composition helper (`withLedgerTransaction` / client-capable posting)
- Migration `0012_ledger_integrity.sql`
- Docs: `docs/LEDGER.md`, this report; ADR-009 for unresolved clearing/recovery classification

Explicitly **not** delivered: Reward Engine, Founder bonus issuance, referral/task/mission reward workflows, AdsGram monetary flow, withdrawals/payouts, TON/signer/KMS, provider settlement, automatic reconciliation repair, public money APIs.

## B. Schema

| Migration                   | Change                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `0012_ledger_integrity.sql` | UNIQUE index one-reversal-per-original; structural immutability trigger on `ledger_accounts` |

Migrations `0001`–`0011` unchanged.

## C. Tests (local evidence; CI re-confirms)

| Suite                         | Count  |
| ----------------------------- | ------ |
| Phase 4 posting               | 9      |
| Phase 4 concurrency           | 7      |
| Phase 4 reversal              | 4      |
| Phase 4 invariants/projection | 6      |
| **Phase 4 total**             | **26** |
| Phase 2 migration regression  | 27     |
| Phase 3 auth + throttle       | 21     |
| Telegram initData             | 8      |
| Config validation             | 11     |

## D–N. Gate checklist

| Gate                                 | Result |
| ------------------------------------ | ------ |
| Debit == credit enforced             | PASS   |
| Atomic bigint-only amounts           | PASS   |
| Account/asset consistency            | PASS   |
| Deterministic locking / concurrency  | PASS   |
| Protected buckets non-negative       | PASS   |
| Idempotency / business-reference     | PASS   |
| Projection atomic + rebuild          | PASS   |
| Immutability UPDATE/DELETE rejected  | PASS   |
| Reversal linked + one-shot           | PASS   |
| Membership bonus classification only | PASS   |
| No Phase 5 engines                   | PASS   |
| Phase 2/3 regression                 | PASS   |
| `quality` / `docker-smoke`           | _(CI)_ |

## O. Archive verification

_(Filled after packaging from the CI-green accepted commit.)_
