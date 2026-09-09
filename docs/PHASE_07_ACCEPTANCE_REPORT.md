# ALEx Rewards Phase 7 Acceptance Report — Withdrawal Engine (Fake Chain)

Status: **PASS** — Withdrawal engine with deterministic fake chain, fee/priority entitlements,
reservation/settlement/reconcile invariants implemented. Phase 6 remains closed. Phase 8 has
**not** started.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                     | Value                                                                           |
| ------------------------ | ------------------------------------------------------------------------------- |
| Phase 6 accepted commit  | `79fbf90b0d07ad786ee616ad1c7e51b7f1004d3c`                                      |
| Phase 7 start tip        | `3bf245d782416ef46c3685b5f7e8ad2b48494435` (Phase 6 companion/archive evidence) |
| Accepted Phase 7 commit  | `5efbf57a8133ea02c2ab99654e637815ce4fb282`                                      |
| GitHub Actions run       | https://github.com/iAlexx/alexreward11/actions/runs/34312445398                 |
| `quality`                | PASS — job `102341712336`                                                       |
| `docker-smoke`           | PASS — job `102342524358`                                                       |
| New migration            | `0017_withdrawal_engine_integrity.sql`                                          |
| Migrations `0001`–`0016` | **unchanged**                                                                   |

## A. Phase objective

Implement the full corrected withdrawal domain/state machine against a deterministic fake
blockchain/payout adapter: quotes, locked fees/limits, membership fee/priority entitlements,
Available→Reserved, V1 manual-review risk, Owner decide + Outbox workflow ID contract, attempts,
dispatch fencing, ambiguous-broadcast reconcile, settlement/release — with **no** real
signer/TON/KMS.

## B. Exact scope delivered

1. Quote lifecycle `OPEN` / `CONSUMED` / `CANCELLED` / `EXPIRED` (no reservation on quote).
2. Fixed-fee V1 path + locked V1.2 initial atomic values (local/test fixture provision).
3. `WITHDRAWAL_PLATFORM_FEE_DISCOUNT` resolution; FLOOR arithmetic; Founder alone = zero discount.
4. `PRIORITY_WITHDRAWAL_REVIEW` = queue order only (no review bypass).
5. Gross limits + `withdrawal_volume_periods` / reservations concurrency.
6. Frozen quote/withdrawal provenance + DB immutability / ACTIVE overlap EXCLUDE (`0017`).
7. `WITHDRAWAL_RESERVATION` at REQUESTED; `WITHDRAWAL_RELEASE` on definitive pre-broadcast REJECT;
   `WITHDRAWAL_SETTLEMENT` at CONFIRMED (fee revenue only then).
8. V1 risk never auto-approves → `MANUAL_REVIEW`; `decideWithdrawal` + Outbox (no sync Temporal).
9. Workflow ID `withdrawal/{withdrawalId}`; in-process `FakePayoutChain` pipeline for LOCAL/TEST;
   staging/production fail closed.
10. Attempts + dispatch fencing; possible-broadcast → `RECONCILE_REQUIRED` (Reserved untouched);
    append-only `withdrawal_payout_reconciliations`.
11. Authenticated APIs: POST quote, cancel quote, POST withdrawals, GET list/get.
12. Docs: `WITHDRAWALS.md`, LEDGER/DATABASE/SECURITY/DECISIONS/migrations README, this report.

### Explicit non-goals (not started)

Real Temporal worker wiring, Control Center / Telegram admin UI (Phase 8), real signer/KMS,
real TON/Jetton broadcast or Testnet payout, production treasury funding policy.

## C. Files/modules changed (high level)

| Area       | Packages / paths                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain     | `packages/withdrawals` (quotes, create, risk, decide, attempts, pipeline, reconcile, settlement, release, volume, entitlements, fake-chain, arithmetic, …) |
| API        | `apps/api` withdrawals controller (`/v1/withdrawals*`)                                                                                                     |
| Ledger     | composition via `@alex-rewards/ledger` (no Phase 4 schema change)                                                                                          |
| Migrations | `migrations/0017_withdrawal_engine_integrity.sql` only                                                                                                     |
| Docs       | `docs/WITHDRAWALS.md`, `LEDGER.md`, `DATABASE.md`, `SECURITY.md`, `DECISIONS.md` (ADR-017), `PHASE_07_ACCEPTANCE_REPORT.md`, `migrations/README.md`        |
| Tests      | `packages/withdrawals/test/phase7-*.test.ts` (+ optional arithmetic unit file)                                                                             |
| Tooling    | root `pnpm test:phase7`; CI Phase 7 gate wiring                                                                                                            |

## D. Database migrations

| Migration                              | Change                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0017_withdrawal_engine_integrity.sql` | Quote/withdrawal provenance columns; fee/limit ACTIVE `EXCLUDE`; financial immutability triggers; frozen quotes; withdrawal structural set-once ledger ids; attempt intent immutability; `withdrawal_volume_periods` + reservations; append-only `withdrawal_payout_reconciliations` |

**Migrations `0001`–`0016` unchanged.**

## E. Commands executed

Placeholder list (fill exact local/CI invocations at archival time):

```text
pnpm verify
pnpm test:phase2   # 27/27
pnpm test:phase3   # 21/21
pnpm test:phase4   # 41/41
pnpm test:phase5   # 55/55
pnpm test:phase6   # 35/35
pnpm test:phase7   # 70/70
```

## F. Test evidence

Official `pnpm test:phase7` gate (6 files) — counts from green local run:

| Suite                   | Count  |
| ----------------------- | ------ |
| phase7 fee-limit-quote  | **16** |
| reservation-concurrency | **11** |
| risk-manual             | **9**  |
| fake-chain-reconcile    | **12** |
| failure-injection       | **8**  |
| state-machine           | **14** |
| **Total `test:phase7`** | **70** |

Optional unit suite (not in official `test:phase7` script): `phase7-arithmetic.test.ts` — **5**
tests (FLOOR discount / net / atomic parse). Mentioned separately; official gate remains **70**.

| Prior phase regression | Count | Status        |
| ---------------------- | ----- | ------------- |
| Phase 2                | 27    | PASS (re-run) |
| Phase 3                | 21    | PASS (re-run) |
| Phase 4                | 41    | PASS (re-run) |
| Phase 5                | 55    | PASS (re-run) |
| Phase 6                | 35    | PASS (re-run) |

## G. Build/health

| Check                                        | Result                               |
| -------------------------------------------- | ------------------------------------ |
| Typecheck / build / lint (via `pnpm verify`) | PASS (local)                         |
| App health endpoints                         | Covered by docker-smoke in CI        |
| Migrations apply cleanly through `0017`      | PASS (local migrate + Phase 2 gates) |

## H. CI

| Item                   | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| GitHub Actions run URL | https://github.com/iAlexx/alexreward11/actions/runs/34312445398 |
| `quality`              | PASS — job `102341712336`                                       |
| `docker-smoke`         | PASS — job `102342524358`                                       |

## I. Known deviations

- Phase 7 uses an **in-process** `FakePayoutChain` + Outbox-driven pipeline as a Temporal
  substitute for LOCAL/TEST (ADR-017). A real Temporal worker may later wrap the same activities
  without changing workflow ID `withdrawal/{withdrawalId}`.
- Fake chain and acknowledged `TREASURY_FUNDING_CLEARING` hot-wallet funding are test/local
  harness paths only — not production payout or treasury policy.
- No real signer/TON/KMS in Phase 7 by design.

## J. Open blockers / tech debt

- Wire production Temporal worker to consume `withdrawal.approved` Outbox (same workflow ID).
- Phase 8 Control Center / Owner action-token surface for `decideWithdrawal`.
- Production fee/limit rule provisioning (not seeded by `0017`).
- Real Testnet signer/payout deferred to later phases.

## K. Security / financial invariants checklist

| Invariant                                                 | Status |
| --------------------------------------------------------- | ------ |
| Quote money snapshot immutable after insert               | PASS   |
| No reservation on OPEN quote                              | PASS   |
| Fee entitlement version reconstructable                   | PASS   |
| Priority reconstructable; cannot bypass review            | PASS   |
| Founder without entitlement: no special fee behavior      | PASS   |
| Gross limits unaffected by fee discount                   | PASS   |
| Available→Reserved atomic; no double reserve              | PASS   |
| Volume concurrency PostgreSQL-authoritative               | PASS   |
| V1 risk never auto-approves                               | PASS   |
| Possible-broadcast preserves Reserved; no blind resend    | PASS   |
| Reconcile append-only; reject needs DEFINITIVE_NONPAYMENT | PASS   |
| Release full gross once; settlement fee only at CONFIRMED | PASS   |
| Fake chain impossible in staging/production               | PASS   |
| No real signing/broadcast / secrets in DB                 | PASS   |

## L. Rollback / recovery

- Migrations forward-only: defect after `0017` → new corrective migration; do not edit
  `0001`–`0017` in place once shipped.
- Kill-switch / feature flags for withdrawals where configured; stop new creates first.
- Ledger is money truth: rebuild projections from entries; do not trust Redis counters.
- Ambiguous payouts stay Reserved until durable reconciliation; never silent Available return.
- Restore path: pre-release backup / PITR, then re-apply migrations forward (`docs/DATABASE.md`,
  `docs/DISASTER_RECOVERY.md`).

## M. Exact accepted SHA

`5efbf57a8133ea02c2ab99654e637815ce4fb282`

## N. PASS/FAIL — Owner section 66 gates

| Gate                                                                | Result                            |
| ------------------------------------------------------------------- | --------------------------------- |
| Quote lifecycle correct                                             | PASS                              |
| Quote money snapshot immutable                                      | PASS                              |
| Fixed fee exact                                                     | PASS                              |
| Initial locked limits exact                                         | PASS                              |
| Fee entitlement version reconstructable                             | PASS                              |
| Priority entitlement version reconstructable                        | PASS                              |
| Founder without entitlement → no special financial behavior         | PASS                              |
| Gross limits unaffected by fee discount                             | PASS                              |
| Available → Reserved atomic                                         | PASS                              |
| Duplicate request cannot double reserve                             | PASS                              |
| 100-concurrent test cannot overdraw Available                       | PASS                              |
| User/hot-wallet volume concurrency safe                             | PASS                              |
| V1 risk policy never auto-approves                                  | PASS                              |
| Manual approval idempotent                                          | PASS                              |
| Priority cannot bypass review state                                 | PASS                              |
| Deterministic workflow starts through Outbox                        | PASS                              |
| One workflow per withdrawal                                         | PASS                              |
| Attempt duplication prevented                                       | PASS                              |
| Definite pre-broadcast failure safely retryable                     | PASS                              |
| Possible-broadcast ambiguity always reconciles                      | PASS                              |
| Ambiguous payout preserves Reserved                                 | PASS                              |
| No blind resend exists                                              | PASS                              |
| Definitive pre-broadcast rejection releases full gross exactly once | PASS                              |
| Confirmation settles Reserved/net/fee exactly once                  | PASS                              |
| Fee revenue recognized only at confirmation                         | PASS                              |
| Fake chain impossible in staging/production                         | PASS                              |
| No real signing/broadcast introduced                                | PASS                              |
| Previous phases remain green                                        | PASS (2/3/4/5/6 = 27/21/41/55/35) |
| `quality` PASS                                                      | PASS                              |
| `docker-smoke` PASS                                                 | PASS                              |
| No Phase 8 work introduced                                          | PASS                              |

## O. Archive verification

Section O is included **before** packaging. Outer review-package SHA256 is recorded only in
external `PACKAGE_SHA256.txt` (not embedded here — self-reference is impossible).

| Item                                | Result                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Canonical source ZIP                | `ALEx_Rewards_PHASE_07_WITHDRAWAL_ENGINE_FAKE_CHAIN_20260909-075200_5efbf57.zip` |
| Canonical source SHA256             | `a90a634320b9cecf6ea4523d274fb9cc5497eb8a9e9696f73844734aa4f897cf`               |
| Final review-package ZIP            | `PHASE_07_WITHDRAWAL_ENGINE_FAKE_CHAIN_PACKAGE_20260909-075200_5efbf57.zip`      |
| Source extraction                   | PASS                                                                             |
| Source prohibited-path scan         | PASS                                                                             |
| Review-package extraction           | PASS                                                                             |
| Review-package prohibited-path scan | PASS                                                                             |
| Nested canonical source validation  | PASS                                                                             |
| Forward-slash ZIP entry validation  | PASS                                                                             |
| Exact accepted commit               | `5efbf57a8133ea02c2ab99654e637815ce4fb282`                                       |
| External `PACKAGE_SHA256.txt`       | Authoritative outer hash beside the package                                      |

Verified with `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260909-075200`).

**No Phase 8 work started.**
