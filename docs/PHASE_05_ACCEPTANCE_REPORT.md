# ALEx Rewards Phase 5 Acceptance Report

Status: **PASS (pending CI fill on archival commit)** — Reward Engine + bonus budgets implemented with migration `0013`; local gates green.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                             | Value                                      |
| -------------------------------- | ------------------------------------------ |
| Accepted archival commit         | _(filled after push + green CI)_           |
| GitHub Actions run               | _(filled after green CI)_                  |
| `quality`                        | _(pending)_                                |
| `docker-smoke`                   | _(pending)_                                |
| New migration                    | `0013_reward_engine_integrity.sql`         |
| Phase 4 accepted archival source | `34bb15455f98f9ae298289453f274d5f2f9d0ee2` |

Phase 6 has **not** started. Phase 5 is Reward Engine (simulated source) only. No AdsGram production money, withdrawals, TON/signer/KMS, or public money APIs.

## A. Scope delivered

- Integer FLOOR arithmetic + clamp + membership bonus FLOOR (ADR-013)
- Versioned reward rules; family = `code`; resolve fail-closed on 0 or >1 ACTIVE matches
- Quotes + `applied_economics` freeze + `source_started_at` expiry protection
- Base + membership bonus budget reserve/consume/release (separate tables)
- Simulated `PROMOTION` source (`SIMULATED_REWARD_SOURCE`, `production_monetary_status = BLOCKED`)
- Issuance composing base + bonus ledger posts in one outer txn + outbox
- Idempotent maturity (`reward-maturity/{id}`)
- Guardrails (pause flags, exposure limits, margin breaker)
- Docs: `docs/REWARDS.md`, ADR-012/013/014, this report

## B. Schema

| Migration                          | Change                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0013_reward_engine_integrity.sql` | ACTIVE reward-rule family EXCLUDE; financial immutability triggers; quote `applied_economics` / `source_started_at` / `bonus_unavailable_policy` |

Migrations `0001`–`0012` unchanged.

## C. Tests (local)

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
| `pnpm verify` / audit / smoke (local)     | PASS   |
| `quality` / `docker-smoke`                | _(CI)_ |

## O. Archive verification

_Filled after archival packaging of the CI-green commit._
