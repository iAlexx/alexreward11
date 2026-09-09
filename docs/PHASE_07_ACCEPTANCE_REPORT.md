# ALEx Rewards Phase 7 Acceptance Report — Withdrawal Engine (Fake Chain)

Status: **PASS** — Withdrawal engine with Outbox → Temporal workflow, deterministic fake payout
activities, fee/priority entitlements, reservation/settlement/reconcile invariants. Phase 6 remains
closed. Phase 8 has **not** started.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                                 | Value                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Phase 6 accepted commit              | `79fbf90b0d07ad786ee616ad1c7e51b7f1004d3c`                                                   |
| Phase 7 start tip                    | `3bf245d782416ef46c3685b5f7e8ad2b48494435` (Phase 6 companion/archive evidence)              |
| Historical Phase 7 archival tip      | `5efbf57a8133ea02c2ab99654e637815ce4fb282` (retained; Owner correction required)             |
| Historical companion (Section O)     | `dc6c3b0778ac51087089dc588079a4ac725b17d6` (docs-only; not archival source)                  |
| Prior corrected candidate (retained) | `9cb695dab9477e50d8761e32f65496a716222a6b`                                                   |
| Corrected accepted Phase 7 commit    | `3d4f57bc4b94b04911a59504e51b4ccd43655a26`                                                   |
| GitHub Actions run                   | https://github.com/iAlexx/alexreward11/actions/runs/34381430961                              |
| `quality`                            | PASS — job `102566980042`                                                                    |
| `docker-smoke`                       | PASS — job `102568451618`                                                                    |
| Migrations                           | `0017_withdrawal_engine_integrity.sql` + `0018_membership_plan_entitlement_rule_binding.sql` |
| Migrations `0001`–`0018`             | **unchanged** by this provenance correction (no new migration)                               |

## A. Phase objective

Implement the full corrected withdrawal domain/state machine against a deterministic fake
blockchain/payout adapter: quotes, locked fees/limits, membership fee/priority entitlements,
Available→Reserved, V1 manual-review risk, Owner decide + Outbox → Temporal workflow ID
`withdrawal/{withdrawalId}`, attempts, dispatch fencing, ambiguous-broadcast reconcile,
settlement/release — with **no** real signer/TON/KMS.

## B. Exact scope delivered

1. Quote lifecycle `OPEN` / `CONSUMED` / `CANCELLED` / `EXPIRED` (no reservation on quote).
2. Fixed-fee V1 path + locked V1.2 initial atomic values (local/test fixture provision).
3. `WITHDRAWAL_PLATFORM_FEE_DISCOUNT` resolution with entitlement↔rule binding integrity; FLOOR
   arithmetic; Founder alone = zero discount.
4. `PRIORITY_WITHDRAWAL_REVIEW` = queue order only (INTERNAL BOOLEAN; no review bypass).
5. Gross limits + `withdrawal_volume_periods` / reservations concurrency.
6. Frozen quote/withdrawal provenance + DB immutability / ACTIVE overlap EXCLUDE (`0017`).
7. `WITHDRAWAL_RESERVATION` at REQUESTED; `WITHDRAWAL_RELEASE` on definitive pre-broadcast REJECT;
   `WITHDRAWAL_SETTLEMENT` at CONFIRMED (fee revenue only then).
8. V1 risk never auto-approves → `MANUAL_REVIEW`; `decideWithdrawal` + Outbox (no sync Temporal).
9. Outbox relay → Temporal `withdrawalPayoutWorkflow` with ID `withdrawal/{withdrawalId}`;
   AlreadyStarted = recovery; Temporal down leaves Outbox retryable; fake activities LOCAL/TEST.
10. Attempts + dispatch fencing; possible-broadcast → `RECONCILE_REQUIRED` (Reserved untouched);
    append-only reconciliations from **adapter-sourced branded** observations only (exact
    withdrawal/attempt bind; plain observation objects are not authority).
11. Typed withdrawal config keys; staging/production fail closed (no silent LOCAL fixtures).
12. Network-scoped asset resolution (`network_id` + symbol + ACTIVE; USDT non-native).
13. Authenticated APIs: POST quote, cancel quote, POST withdrawals, GET list/get.
14. Docs: `WITHDRAWALS.md`, LEDGER/DATABASE/SECURITY/DECISIONS/migrations README, this report.

### Explicit non-goals (not started)

Control Center / Telegram admin UI (Phase 8), real signer/KMS, real TON/Jetton broadcast or
Testnet payout, production treasury funding policy.

## C. Files/modules changed (high level)

| Area       | Packages / paths                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Domain     | `packages/withdrawals` (quotes, create, risk, decide, attempts, pipeline, reconcile, settlement, release, volume, entitlements, fake-chain, outbox-relay, …) |
| Worker     | `apps/worker` Temporal workflows + activities + Outbox poll                                                                                                  |
| Config     | `packages/config` typed `WITHDRAWAL_*` keys (API + worker)                                                                                                   |
| API        | `apps/api` withdrawals controller (`/v1/withdrawals*`)                                                                                                       |
| Ledger     | composition via `@alex-rewards/ledger` (no Phase 4 schema change)                                                                                            |
| Migrations | `0017` (historical) + forward `0018_membership_plan_entitlement_rule_binding.sql`                                                                            |
| Docs       | `docs/WITHDRAWALS.md`, `DATABASE.md`, `DECISIONS.md` (ADR-017), this report, `migrations/README.md`                                                          |
| Tests      | `packages/withdrawals/test/phase7-*.test.ts` including Temporal + authority corrections                                                                      |
| Tooling    | root `pnpm test:phase7`; CI Phase 7 gate wiring                                                                                                              |

## D. Database migrations

| Migration                                           | Change                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0017_withdrawal_engine_integrity.sql`              | Quote/withdrawal provenance columns; fee/limit ACTIVE `EXCLUDE`; financial immutability triggers; frozen quotes; withdrawal structural set-once ledger ids; attempt intent immutability; `withdrawal_volume_periods` + reservations; append-only `withdrawal_payout_reconciliations` |
| `0018_membership_plan_entitlement_rule_binding.sql` | BEFORE INSERT/UPDATE trigger: plan entitlement mapping must match benefit-rule entitlement_id and plan-compatible membership_plan_id                                                                                                                                                 |

**Migrations `0001`–`0017` unchanged** by this correction pass.

## E. Commands executed

```text
pnpm verify
pnpm test:phase2   # 27/27
pnpm test:phase3   # 21/21 (CI; local may skip throttle without REDIS_URL)
pnpm test:phase4   # 41/41
pnpm test:phase5   # 55/55
pnpm test:phase6   # 35/35
pnpm test:phase7   # 107/107
dependency audit / secret scan / migration validation / architecture boundary / docker-smoke
```

## F. Test evidence

Official `pnpm test:phase7` = **107** tests:

| Suite                                                  | Count |
| ------------------------------------------------------ | ----- |
| fee/limit/quote                                        | 16    |
| reservation/concurrency                                | 11    |
| risk/manual                                            | 9     |
| fake-chain reconcile                                   | 12    |
| failure injection                                      | 8     |
| state machine                                          | 14    |
| Temporal Outbox integration                            | 8     |
| authority corrections                                  | 16    |
| reconcile provenance (adapter brand + attempt binding) | 13    |

Prior Phase 7 baseline of **70** remains green; **+8** Temporal; **+16** authority; **+13** provenance.

Optional unit suite (not in official `test:phase7` script): `phase7-arithmetic.test.ts` — **5**
tests (FLOOR discount / net / atomic parse).

| Prior phase regression | Count | Status        |
| ---------------------- | ----- | ------------- |
| Phase 2                | 27    | PASS (re-run) |
| Phase 3                | 21    | PASS (CI)     |
| Phase 4                | 41    | PASS (re-run) |
| Phase 5                | 55    | PASS (re-run) |
| Phase 6                | 35    | PASS (re-run) |

## G. Build/health

| Check                                        | Result                               |
| -------------------------------------------- | ------------------------------------ |
| Typecheck / build / lint (via `pnpm verify`) | PASS (local)                         |
| App health endpoints                         | Covered by docker-smoke in CI        |
| Migrations apply cleanly through `0018`      | PASS (local migrate + Phase 2 gates) |

## H. CI

| Item                   | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| GitHub Actions run URL | https://github.com/iAlexx/alexreward11/actions/runs/34381430961 |
| `quality`              | PASS — job `102566980042`                                       |
| `docker-smoke`         | PASS — job `102568451618`                                       |

## I. Known deviations

- Fake chain and acknowledged `TREASURY_FUNDING_CLEARING` hot-wallet funding are test/local
  harness paths only — not production payout or treasury policy.
- No real signer/TON/KMS in Phase 7 by design.
- Historical ADR-017 “Temporal deferred” language is superseded: Outbox → Temporal is implemented;
  fake activities remain LOCAL/TEST only.

## J. Open blockers / tech debt

- Phase 8 Control Center / Owner action-token surface for `decideWithdrawal`.
- Production fee/limit rule provisioning (not seeded by `0017`).
- Real Testnet signer/payout deferred to later phases.

## K. Security / financial invariants checklist

| Invariant                                                   | Status |
| ----------------------------------------------------------- | ------ |
| Quote money snapshot immutable after insert                 | PASS   |
| No reservation on OPEN quote                                | PASS   |
| Fee entitlement version reconstructable + binding-safe      | PASS   |
| Priority reconstructable; cannot bypass review              | PASS   |
| Founder without entitlement: no special fee behavior        | PASS   |
| Gross limits unaffected by fee discount                     | PASS   |
| Available→Reserved atomic; no double reserve                | PASS   |
| Volume concurrency PostgreSQL-authoritative                 | PASS   |
| V1 risk never auto-approves                                 | PASS   |
| Outbox → Temporal `withdrawal/{id}`; no sync Temporal in TX | PASS   |
| Reconcile from branded adapter observation + attempt bind   | PASS   |
| Plain caller observation cannot definitive-prove / settle   | PASS   |
| Possible-broadcast preserves Reserved; no blind resend      | PASS   |
| Reconcile from authoritative observation only               | PASS   |
| Release full gross once; settlement fee only at CONFIRMED   | PASS   |
| Network-scoped asset resolution fail-closed                 | PASS   |
| Staging/production withdrawal config fail-closed            | PASS   |
| Fake chain impossible in staging/production                 | PASS   |
| No real signing/broadcast / secrets in Temporal history     | PASS   |

## L. Rollback / recovery

- Migrations forward-only: defect after `0018` → new corrective migration; do not edit
  `0001`–`0018` in place once shipped.
- Kill-switch / feature flags for withdrawals where configured; stop new creates first.
- Ledger is money truth: rebuild projections from entries; do not trust Redis counters.
- Ambiguous payouts stay Reserved until durable reconciliation; never silent Available return.
- Restore path: pre-release backup / PITR, then re-apply migrations forward (`docs/DATABASE.md`,
  `docs/DISASTER_RECOVERY.md`).

## M. Exact accepted SHA

`3d4f57bc4b94b04911a59504e51b4ccd43655a26` (prior corrected candidate retained: `9cb695dab9477e50d8761e32f65496a716222a6b`; historical `5efbf57a8133ea02c2ab99654e637815ce4fb282`)

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
| Deterministic workflow starts through Outbox → Temporal             | PASS                              |
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

Section O is filled after packaging. Outer review-package SHA256 is recorded only in
external `PACKAGE_SHA256.txt` (not embedded here — self-reference is impossible).

| Item                                | Result                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| Canonical source ZIP                | `ALEx_Rewards_PHASE_07_WITHDRAWAL_ENGINE_FAKE_CHAIN_20260909-201907_3d4f57b.zip` |
| Canonical source SHA256             | `0ee38ab05de236fa8125cd1994085d8bb10ee0aca77e618a3e1750823a0405a6`               |
| Final review-package ZIP            | `PHASE_07_WITHDRAWAL_ENGINE_FAKE_CHAIN_PACKAGE_20260909-201907_3d4f57b.zip`      |
| Source extraction                   | PASS                                                                             |
| Source prohibited-path scan         | PASS                                                                             |
| Review-package extraction           | PASS                                                                             |
| Review-package prohibited-path scan | PASS                                                                             |
| Nested canonical source validation  | PASS                                                                             |
| Forward-slash ZIP entry validation  | PASS                                                                             |
| Exact accepted commit               | `3d4f57bc4b94b04911a59504e51b4ccd43655a26`                                       |
| External `PACKAGE_SHA256.txt`       | Authoritative outer hash beside the package                                      |

Verified with `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260909-201907`).

**No Phase 8 work started.**
