# ALEx Rewards Phase 5 Acceptance Report

Status: **PASS** — Phase 5 Reward Engine + bonus budgets complete; GitHub Actions `quality` (including Phase 5 gates) and `docker-smoke` are green on the accepted archival commit.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                             | Value                                                           |
| -------------------------------- | --------------------------------------------------------------- |
| Accepted archival commit         | `a7da07d623c63819344dc72ebb2266d7ad0bcc06`                      |
| Implementation commit            | `2108c7fd90c0b0a36338915b7780585c01ddbaa3`                      |
| GitHub Actions run               | https://github.com/iAlexx/alexreward11/actions/runs/34287585475 |
| `quality`                        | PASS — job `102266633613`                                       |
| `docker-smoke`                   | PASS — job `102267465402`                                       |
| New migration                    | `0013_reward_engine_integrity.sql`                              |
| Phase 4 accepted archival source | `34bb15455f98f9ae298289453f274d5f2f9d0ee2`                      |

Phase 6 has **not** started. Phase 5 is Reward Engine (simulated source) only.

## A. Scope delivered

- Integer FLOOR arithmetic + clamp + membership bonus FLOOR (ADR-013)
- Versioned reward rules; family = `code`; resolve fail-closed
- Quotes + `applied_economics` freeze + `source_started_at` protection
- Base + membership bonus budget reserve/consume/release
- Simulated `PROMOTION` source (`SIMULATED_REWARD_SOURCE`, BLOCKED)
- Issuance composing base + bonus ledger posts in one outer txn + outbox
- Idempotent maturity; guardrails (pause / exposure / margin)
- Docs: `docs/REWARDS.md`, ADR-012/013/014, this report

Explicitly **not** delivered: AdsGram monetary flow, withdrawals/payouts, TON/signer/KMS, public money HTTP APIs, Phase 6 engines.

## B. Schema

| Migration                          | Change                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0013_reward_engine_integrity.sql` | ACTIVE reward-rule family EXCLUDE; financial immutability triggers; quote `applied_economics` / `source_started_at` / `bonus_unavailable_policy` |

Migrations `0001`–`0012` unchanged.

## C. Tests

| Suite                            | Count  |
| -------------------------------- | ------ |
| Phase 5 arithmetic               | 6      |
| Phase 5 rules                    | 5      |
| Phase 5 quotes/budgets           | 4      |
| Phase 5 issuance                 | 3      |
| Phase 5 Founder/membership bonus | 4      |
| Phase 5 maturity                 | 2      |
| Phase 5 guardrails               | 3      |
| Phase 5 failure injection        | 2      |
| Phase 5 concurrency/composition  | 5      |
| **Phase 5 total**                | **34** |
| Phase 4 regression               | 41     |
| Phase 2 migration regression     | 27     |
| Phase 3 auth + throttle          | 21     |

## D–N. Gate checklist

| Gate                                      | Result |
| ----------------------------------------- | ------ |
| Integer-only FLOOR arithmetic             | PASS   |
| Quote freeze + started-source expiry skip | PASS   |
| Budget reserve base-only; bonus separate  | PASS   |
| Bonus policy fail-closed when in scope    | PASS   |
| Separate bonus event with null quote_id   | PASS   |
| One outer txn issuance + outbox           | PASS   |
| Maturity idempotent                       | PASS   |
| Concurrent budget/maturity/issuance       | PASS   |
| Base+bonus Phase 4 invariants PASS        | PASS   |
| Failure injection rollback                | PASS   |
| No AdsGram / AD_REVENUE posts             | PASS   |
| No Phase 6 engines                        | PASS   |
| `quality` / `docker-smoke`                | PASS   |

## O. Archive verification

Verified for accepted commit `a7da07d623c63819344dc72ebb2266d7ad0bcc06` using `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260909-020000`).

| Item                                                                   | Result                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Canonical source ZIP                                                   | `ALEx_Rewards_PHASE_05_REWARD_ENGINE_20260909-020000_a7da07d.zip`               |
| Canonical source SHA-256                                               | `47be46b3f7868c6dbdc9c0d926ad0efd850eacb0d6f343128e391ce908e37f06`              |
| Review-package ZIP                                                     | `PHASE_05_REWARD_ENGINE_PACKAGE_20260909-020000_a7da07d.zip`                    |
| Outer package SHA-256                                                  | See external `PACKAGE_SHA256.txt` beside the review package (not embedded here) |
| Source extraction / prohibited-path scan                               | PASS / PASS                                                                     |
| Review-package extraction / prohibited-path / nested source validation | PASS / PASS / PASS                                                              |
| Forward-slash ZIP entry names                                          | PASS — `PHASE_05_REWARD_ENGINE/...` only                                        |

Per `AGENTS.md` and `docs/PHASE_ARCHIVE.md`, the SHA-256 of the **outer** review package is published beside it in `PACKAGE_SHA256.txt` and is deliberately **not** embedded in this section.
