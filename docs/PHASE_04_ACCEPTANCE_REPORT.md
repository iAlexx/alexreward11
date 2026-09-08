# ALEx Rewards Phase 4 Acceptance Report

Status: **PASS** — Phase 4 Ledger Core is complete; GitHub Actions `quality` and `docker-smoke` are green on the accepted archival commit.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                               | Value                                                           |
| ---------------------------------- | --------------------------------------------------------------- |
| Final accepted archival commit SHA | `084c204af3c1d1869946cde7368de3eb3e0f4b30`                      |
| GitHub Actions run                 | https://github.com/iAlexx/alexreward11/actions/runs/34280114227 |
| `quality`                          | PASS — job `102242573176`                                       |
| `docker-smoke`                     | PASS — job `102243390316`                                       |
| Phase 3 accepted archival source   | `be08e7fe91309fe42da74d14558ebdaa353215e5`                      |

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

## C. Tests

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
| `quality` / `docker-smoke`           | PASS   |

## O. Archive verification

Verified for exact accepted commit `084c204af3c1d1869946cde7368de3eb3e0f4b30` using `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260909-001800`).

| Item                                                                   | Result                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Canonical source ZIP                                                   | `ALEx_Rewards_PHASE_04_LEDGER_CORE_20260909-001800_084c204.zip`                 |
| Canonical source SHA-256                                               | `5209422bef7416725655e81aab33de109abb869e029a2a1b5851d53617d86203`              |
| Review-package ZIP                                                     | `PHASE_04_LEDGER_CORE_PACKAGE_20260909-001800_084c204.zip`                      |
| Outer package SHA-256                                                  | See external `PACKAGE_SHA256.txt` beside the review package (not embedded here) |
| `MANIFEST.md` / `SHA256SUMS.txt`                                       | PASS — companion checksums match source ZIP, report, and manifest               |
| Source extraction / prohibited-path scan                               | PASS / PASS                                                                     |
| Review-package extraction / prohibited-path / nested source validation | PASS / PASS / PASS                                                              |
| Forward-slash ZIP entry names                                          | PASS — `PHASE_04_LEDGER_CORE/...` only                                          |

Per `AGENTS.md` and `docs/PHASE_ARCHIVE.md`, the SHA-256 of the **outer** review package is published beside it in `PACKAGE_SHA256.txt` and is deliberately **not** embedded in this section.
