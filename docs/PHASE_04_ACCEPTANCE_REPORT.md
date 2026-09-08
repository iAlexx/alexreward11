# ALEx Rewards Phase 4 Acceptance Report

Status: **PASS (CORRECTED)** — Phase 4 Ledger Core financial-core gaps closed; GitHub Actions `quality` and `docker-smoke` are green on the corrected archival commit.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                               | Value                                                           |
| ---------------------------------- | --------------------------------------------------------------- |
| Corrected accepted archival commit | `34bb15455f98f9ae298289453f274d5f2f9d0ee2`                      |
| GitHub Actions run                 | https://github.com/iAlexx/alexreward11/actions/runs/34282823991 |
| `quality`                          | PASS — job `102251394280`                                       |
| `docker-smoke`                     | PASS — job `102252252565`                                       |
| Historical Phase 4 archive (keep)  | `084c204af3c1d1869946cde7368de3eb3e0f4b30`                      |
| Phase 3 accepted archival source   | `be08e7fe91309fe42da74d14558ebdaa353215e5`                      |
| New migration                      | **no migration added**                                          |

Phase 5 has not started. Phase 4 is Ledger Core only. No Reward Engine / real rewards / Founder bonuses / withdrawals / payouts / provider money.

## Correction summary (Owner review gaps closed)

1. **Direct reversal bypass closed** — `reversesTransactionId` removed from public `PostLedgerCommand`. Linked reversals only via `reverseLedgerTransaction` → `postLedgerTransactionWithReversalLink` with order-safe exact economic multiset validation **before** insert (`REVERSAL_INVALID` does not consume the unique slot).
2. **Projection version / last-pointer** — Option 1 (ADR-010): `version` = DISTINCT transactions; last pointer tie-aware for same `posted_at`; no false CRITICAL on multi-post outer transactions; no `0013`.
3. **Account-type / asset compatibility** — centralized PostgreSQL asset metadata checks for hot-wallet USDT/TON and TON fee expense; `ASSET_INACTIVE` / `ASSET_INCOMPATIBLE`.
4. **Business-reference concurrency proof** — concurrent same biz-ref + different idempotency keys (same intent recovers; different intent → one winner + `BUSINESS_REFERENCE_CONFLICT`). Same-idempotency concurrency test retained.
5. **Idempotency canonicalization** — intent fingerprint ignores caller entry order / `entryIndex`.

## A. Scope delivered

- Immutable double-entry posting (`postLedgerTransaction`)
- Guarded linked reversal posting (`postLedgerTransactionWithReversalLink` / `reverseLedgerTransaction`)
- Catalogue-backed account get-or-create + asset compatibility + ACTIVE asset enforcement
- Deterministic account locking; protected bucket non-negativity
- Idempotency + business-reference recovery/conflict (order-independent intent)
- Projection rebuild/compare (balance + version + tie-aware last pointer); read-only invariant checker
- Composition helper (`withLedgerTransaction` / client-capable posting)
- Migration `0012_ledger_integrity.sql` (unchanged); **no `0013`**
- Docs: `docs/LEDGER.md`, `docs/DATABASE.md`, ADR-010/011, this report

Explicitly **not** delivered: Reward Engine, Founder bonus issuance, referral/task/mission reward workflows, AdsGram monetary flow, withdrawals/payouts, TON/signer/KMS, provider settlement, automatic reconciliation repair, public money APIs.

## B. Schema

| Migration                   | Change                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| `0012_ledger_integrity.sql` | UNIQUE index one-reversal-per-original; structural immutability trigger on `ledger_accounts` |

Migrations `0001`–`0012` unchanged for this correction. **No migration added.**

## C. Tests

| Suite                         | Count  |
| ----------------------------- | ------ |
| Phase 4 posting               | 10     |
| Phase 4 concurrency           | 8      |
| Phase 4 reversal              | 8      |
| Phase 4 invariants/projection | 10     |
| Phase 4 asset compatibility   | 5      |
| **Phase 4 total**             | **41** |
| Phase 2 migration regression  | 27     |
| Phase 3 auth + throttle       | 21     |

## D–N. Gate checklist

| Gate                                          | Result |
| --------------------------------------------- | ------ |
| Debit == credit enforced                      | PASS   |
| Atomic bigint-only amounts                    | PASS   |
| Account/asset consistency + compatibility     | PASS   |
| Active-asset requirement                      | PASS   |
| Deterministic locking / concurrency           | PASS   |
| Protected buckets non-negative                | PASS   |
| Idempotency / business-reference              | PASS   |
| Biz-ref concurrency (distinct idem keys)      | PASS   |
| Malformed linked reversal rejected pre-insert | PASS   |
| Same-outer-txn multi-post projection          | PASS   |
| Projection atomic + rebuild (tie-aware)       | PASS   |
| Immutability UPDATE/DELETE rejected           | PASS   |
| Reversal linked + one-shot                    | PASS   |
| Membership bonus classification only          | PASS   |
| No Phase 5 engines                            | PASS   |
| Phase 2/3 regression                          | PASS   |
| `quality` / `docker-smoke`                    | PASS   |

## O. Archive verification

Historical package for `084c204…` remains under `phase-archives/PHASE_04_LEDGER_CORE/` and must not be deleted.

Verified for corrected accepted commit `34bb15455f98f9ae298289453f274d5f2f9d0ee2` using `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260908-215851`).

| Item                                                                   | Result                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Canonical source ZIP                                                   | `ALEx_Rewards_PHASE_04_LEDGER_CORE_20260908-215851_34bb154.zip`                 |
| Canonical source SHA-256                                               | `06f50da1be2f6b23f452047c95ec51916cbc21cfa4345503eb26f1a293177110`              |
| Review-package ZIP                                                     | `PHASE_04_LEDGER_CORE_PACKAGE_20260908-215851_34bb154.zip`                      |
| Outer package SHA-256                                                  | See external `PACKAGE_SHA256.txt` beside the review package (not embedded here) |
| `MANIFEST.md` / `SHA256SUMS.txt`                                       | PASS — companion checksums match source ZIP, report, and manifest               |
| Source extraction / prohibited-path scan                               | PASS / PASS                                                                     |
| Review-package extraction / prohibited-path / nested source validation | PASS / PASS / PASS                                                              |
| Forward-slash ZIP entry names                                          | PASS — `PHASE_04_LEDGER_CORE/...` only                                          |
| Historical `084c204` archive retained                                  | PASS                                                                            |

Per `AGENTS.md` and `docs/PHASE_ARCHIVE.md`, the SHA-256 of the **outer** review package is published beside it in `PACKAGE_SHA256.txt` and is deliberately **not** embedded in this section.
