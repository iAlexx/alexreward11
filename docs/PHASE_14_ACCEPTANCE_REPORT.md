# Phase 14 Acceptance Report — Fraud Engine V1 + Trust / Eligibility

**Status:** **PASS**

**Phase slug:** `PHASE_14_FRAUD_TRUST_ELIGIBILITY`  
**Master specification:** Version 1.3 (§171 Phase 14; §76–§78; §156J / §156K / §156O / §156U / §156V; Appendix O)  
**Accepted source commit:** `9f39529e164f082f28d0e7c428c24b038f716410`  
**Branch:** `phase14-fraud-trust-eligibility`

**AdsGram production monetary status:** **BLOCKED**  
**Auto payout:** **NOT ENABLED**  
**Mainnet:** **NOT ACTIVATED**  
**Phase 15 Referral economics:** **NOT STARTED**  
**Phase 16 Mission engine:** **NOT STARTED**

---

## A. Phase objective

Complete Master Specification V1.3 §171 Phase 14:

- Build multi-signal Fraud/Risk scoring with versioned rules and immutable snapshots.
- Wire withdrawal decisions through authoritative Risk + Eligibility (no legacy fabricated scores).
- Cover referral / ad / wallet Risk signals from server-authoritative sources.
- Deliver Admin Fraud read/review surface over existing Review Queue primitives.
- Add separate Trust snapshots/state (positive history only; never overrides Fraud/Risk).
- Deliver Eligibility Engine with versioned required gates, precedence, reason codes, and
  immutable decisions.
- Keep membership as benefit input only (not a security/fraud bypass).
- Preserve provider / country / mission eligibility boundaries (fail closed where authority
  is unavailable).
- Persist risk/trust rule-version snapshots and adverse-action auditability.

Gate conditions (must hold):

- No single weak signal auto-bans / permanently freezes a user automatically.
- Founder cannot bypass CRITICAL / hard security.
- Trust cannot override required Fraud/Risk hold.
- Eligibility is deterministic and reason-coded for the same versioned inputs.

---

## B. Exact scope delivered

1. **Risk/Fraud engine** — versioned `risk_rule_versions` (thresholds, signal_weights,
   signal_params, actions); collectors for OPEN/CONFIRMED fraud flags, shared payout wallet,
   shared device/network, country-change evidence, AD reversed-reward history, referral
   rejected-edge history; deterministic integer score/tier/action; `evaluateAndPersistRisk`;
   immutable `risk_snapshots` + current `risk_profiles`; referenced-rule semantic freeze +
   FOR SHARE first-reference concurrency.
2. **Trust engine** — versioned `trust_rule_versions.policy_config`; positive signals
   ACCOUNT_AGE, VERIFIED_PRIMARY_WALLET_AGE, REWARDED_AD_HISTORY, CONFIRMED_PAYOUT_HISTORY;
   `evaluateAndPersistTrust`; immutable `trust_snapshots` + `users.trust_state` projection;
   Founder/membership ignored; no Trust financial benefits.
3. **Trust wallet-age remediation (accepted tip)** — `VERIFIED_PRIMARY_WALLET_AGE` uses
   `GREATEST(verified_at, became_primary_at)` only when both timestamps are non-null; no
   `created_at` fallback; primary change resets positive wallet-age Trust history.
4. **Eligibility engine** — versioned `eligibility_policy_versions` with action required gates,
   precedence, and `riskAllowedActions` when RISK_POLICY is required; locked ACTIVE resolver
   (FOR SHARE); `evaluateAndPersistEligibility` with no caller gate/outcome authority;
   ACCOUNT_STATE / FEATURE_FLAG / RISK_POLICY collectors; COUNTRY_POLICY / MEMBERSHIP /
   PROVIDER_LIMIT / mission-money sources fail closed when unsupported.
5. **Withdrawal integration** — `@alex-rewards/withdrawals` depends one-way on fraud;
   Eligibility+Risk preflight before ledger reservation; evidence commits on denial; pins
   `risk_snapshot_id`, authoritative `risk_policy_version`, `eligibility_decision_id`;
   NEVER auto-approves; RESTRICTED → HELD; CRITICAL/hard fail-safe without user-status
   mutation from withdrawal engine; legacy `applyV1RiskPolicy` 10/80/100 fabrication removed
   as Risk authority.
6. **Admin Fraud surface** — authenticated `GET /v1/admin/fraud` (+ `:userId`) safe evidence
   envelope; `ensureReviewCase(FRAUD_REVIEW)` via `@alex-rewards/control-center`; no
   mark-safe / Risk override / Trust mutation APIs.
7. **Migrations 0034–0043** — forward-only integrity, locks, signal_params, trust
   policy_config, withdrawal eligibility link. **No production Risk/Trust/Eligibility seeds.**

Out of scope (explicit non-delivery): Phase 15 referral economics; Phase 16 mission money;
production country authority; Trust shorter-pending / auto-payout / higher limits; Mainnet;
AdsGram production monetary activation; automatic payout.

---

## C. Files / modules changed (accepted source)

Representative (full tree via `git archive` of accepted SHA):

- `packages/fraud/**` — risk/trust/eligibility engines, collectors, evaluators,
  evaluate-and-persist entrypoints, canonical safe JSON, tests, harness
- `packages/withdrawals/**` — Phase 14 preflight, authoritative risk attach, create two-TX
  pattern, decide pinned `risk_policy_version`, TEST-ONLY policy seeds in harness
- `packages/contracts/src/admin.ts` — Admin Fraud READ / ensure DTOs
- `apps/api/src/admin/fraud-admin.controller.ts`, `overview.controller.ts` — fraud read +
  ensure; overview `fraud_engine` READY
- `apps/admin/**` — FraudPage + admin-api client/types alignment
- `packages/control-center/test/harness.ts` — Phase 14 TEST policy seed for post-preflight
  suites
- `migrations/0034_phase14_*.sql` … `0043_phase14_*.sql`
- `scripts/verify-boundaries.mjs` — Phase 14 package edge rules
- Root / package `test:phase14` wiring

---

## D. Database migrations

Verified repository filenames (Phase 14 forward migrations on this branch):

| Migration | Purpose |
| --------- | ------- |
| `0034_phase14_risk_rule_integrity.sql` | Risk rule integrity foundations |
| `0035_phase14_trust_rule_core.sql` | Trust rule / snapshot core |
| `0036_phase14_eligibility_policy_core.sql` | Eligibility policy + decision integrity |
| `0037_phase14_eligibility_action_policy.sql` | Action required-gates / precedence config |
| `0038_phase14_eligibility_policy_reference_integrity.sql` | Freeze referenced eligibility policy semantics |
| `0039_phase14_eligibility_policy_reference_lock.sql` | FOR SHARE first-reference lock |
| `0040_phase14_rule_version_reference_integrity.sql` | Risk/Trust referenced-rule freeze + FK |
| `0041_phase14_risk_signal_params_and_eligibility_lock.sql` | `signal_params` + eligibility ACTIVE lock semantics |
| `0042_phase14_trust_policy_config.sql` | Trust `policy_config` + freeze |
| `0043_phase14_withdrawal_eligibility_link.sql` | `withdrawals.eligibility_decision_id` ON DELETE RESTRICT |

**NO production Risk rule seeded.**  
**NO production Trust rule seeded.**  
**NO production Eligibility policy seeded.**  
TEST-ONLY fixtures exist solely in package test harnesses (explicitly marked).

---

## E. Commands executed (final pre-archive gate)

Isolated DB URLs only (`*_test` / `*_tests` on docker `:55432`). Never `alex_rewards` operational.

```text
pnpm validate:migrations          # 43 migrations PASS
pnpm verify:boundaries            # 8 apps, 21 packages PASS
pnpm security:secrets             # PASS
pnpm --filter @alex-rewards/fraud typecheck|test|build   # 230 PASS
pnpm --filter @alex-rewards/withdrawals typecheck|build  # PASS
pnpm test:phase7                  # 124 PASS
pnpm test:phase8                  # 52 PASS
pnpm test:phase10                 # signing 5 + withdrawals 324 + ton 54 PASS
                                  # (3 signer privilege tests skipped by design)
pnpm test:phase11                 # 45 PASS
pnpm test:phase13                 # auth 11 + ads 3 + api 52 + admin 12 PASS
pnpm test:phase14                 # fraud 230 + api fraud-admin 18 PASS
pnpm typecheck                    # turbo 47/47 PASS
pnpm build                        # turbo 27/27 PASS

pnpm archive:phase -- --phase 14 --slug FRAUD_TRUST_ELIGIBILITY \
  --commit 9f39529e164f082f28d0e7c428c24b038f716410 \
  --report docs/PHASE_14_ACCEPTANCE_REPORT.md \
  --roadmap-version 1.3 \
  --next-phase-status "No Phase 15 work has started at packaging time." \
  --stamp <FIXED_UTC_STAMP>
```

---

## F. Unit / integration / E2E / security tests

| Suite | Result |
| ----- | ------ |
| `@alex-rewards/fraud` full + `test:phase14` | **230 PASS** |
| `apps/api` `test:phase14` fraud-admin | **18 PASS** |
| `test:phase7` (incl. phase14 withdrawal integration) | **124 PASS** |
| `test:phase8` | **52 PASS** |
| `test:phase10` | **PASS** (383 counted tests; 3 signer privilege skipped by design) |
| `test:phase11` | **45 PASS** |
| `test:phase13` | **78 PASS** (11+3+52+12) |
| Trust wallet-age remediation matrix | **PASS** (old-verified/new-primary; later-of-two; NULL `became_primary_at`) |
| Founder / Trust CRITICAL bypass regressions | **PASS** (domain + withdrawal suites) |
| Weak-signal permanent auto-ban | **PASS** (no automatic BAN/SUSPEND/FREEZE) |
| Browser Admin E2E | **not claimed** as Phase 14 packaging gate |

---

## G. Build / health

`pnpm typecheck` **PASS**. `pnpm build` **PASS**. Fraud and withdrawals package typecheck/build **PASS**.

---

## H. CI / remote status (truthful)

Checked against accepted source `9f39529e164f082f28d0e7c428c24b038f716410` via GitHub commit status API:

| Context | State |
| ------- | ----- |
| Vercel – alex-rewards-miniapp | **SUCCESS** |
| Vercel – alex-isolated-ton-proof-testnet | **FAILURE** |

GitHub Actions quality-job URL/ID for this tip: **n/a** (no applicable final quality workflow run recorded on this commit beyond Vercel statuses / preview comments).

Combined remote status is **not** all-green. The isolated-ton-proof Vercel failure was not attributed to Phase 14 source changes and is recorded as external/unrelated to the Phase 14 gate (see Section I).

Local Phase 14 packaging gate: **PASS** (Section E/F/N).

---

## I. Known deviations

1. **COUNTRY_AUTHORITY:** `OWNER_POLICY_REQUIRED` — not inferred from IP / Telegram / provider.
2. **PRODUCTION_RISK_RULE / TRUST_RULE / ELIGIBILITY_POLICY:** not seeded; absent ACTIVE production policy remains fail-closed / OWNER_POLICY_REQUIRED.
3. **TRUST_FINANCIAL_BENEFITS:** not enabled (no shorter pending / auto-payout / higher hard limits).
4. Provider / country / mission Eligibility gates fail closed where authoritative input or versioned contract is unavailable (intentional).
5. Phase 15 Referral economics and Phase 16 Mission engine have **not** started.
6. Remote Vercel status for `alex-isolated-ton-proof-testnet` is **FAILURE** on the accepted tip; treated as external/historical-unrelated to Phase 14 gate (not a Phase 14 product-code blocker).
7. One intermittent Vitest unhandled-rejection noise was observed once during a concurrency immutability test mid-gate; immediate re-run of `pnpm test:phase14` was clean (**230+18 PASS**) with no product change.

These are **FUTURE PRODUCTION / OWNER POLICY** or **EXTERNAL** items — **not** Phase 14 closure blockers after final verification.

---

## J. Open blockers / technical debt

**Phase 14 closure blockers:** **0**

Technical debt / future Owner decisions (non-blocking for archive):

- Seed / activate production Risk, Trust, and Eligibility policies only after Owner approval.
- Establish authoritative country policy source before enabling COUNTRY_POLICY gates.
- Decide future Trust benefit policy separately.
- Phase 15 / 16 remain unstarted by design.
- External isolated-ton-proof Vercel status remains Owner ops hygiene, not Phase 14 archive scope.

---

## K. Security / financial invariant checks

| Invariant | Result |
| --------- | ------ |
| CLIENT_RISK_SCORE_AUTHORITY | **NONE** |
| CLIENT_TRUST_SCORE_AUTHORITY | **NONE** |
| CLIENT_ELIGIBILITY_OUTCOME_AUTHORITY | **NONE** |
| CLIENT_GATE_FACT_AUTHORITY | **NONE** |
| LEDGER_WRITES_FROM_FRAUD_PACKAGE | **NONE** |
| AUTO_WITHDRAWAL_APPROVAL | **NO** |
| AUTO_PAYOUT | **NO** |
| FOUNDER_CRITICAL_BYPASS | **NO** |
| TRUST_CRITICAL_BYPASS | **NO** |
| MEMBERSHIP_SECURITY_BYPASS | **NO** |
| SINGLE_WEAK_SIGNAL_PERMANENT_AUTO_BAN | **NO** |
| COUNTRY_INFERRED_FROM_IP_TELEGRAM_PROVIDER | **NO** |
| RAW_IP_PERSISTED_IN_RISK_SNAPSHOT | **NO** |
| PRIVATE_WALLET_MATERIAL | **NONE** |
| MAINNET_ACTIVATED | **NO** |
| ADSGRAM_PRODUCTION_MONETARY | **BLOCKED** |
| WITHDRAWAL_MANUAL_APPROVAL | **MANDATORY** |
| RISK_RULE_VERSION_REPRODUCIBLE | **YES** |
| TRUST_RULE_VERSION_REPRODUCIBLE | **YES** |
| ELIGIBILITY_POLICY_VERSION_REPRODUCIBLE | **YES** |

Intentional open policy (not failures):

- COUNTRY_AUTHORITY: **OWNER_POLICY_REQUIRED**
- PRODUCTION_RISK_RULE: **NOT SEEDED**
- PRODUCTION_TRUST_RULE: **NOT SEEDED**
- PRODUCTION_ELIGIBILITY_POLICY: **NOT SEEDED**
- TRUST_FINANCIAL_BENEFITS: **NOT ENABLED**

---

## L. Rollback / recovery

Revert / stop using commits after Phase 13 tip on this branch; leave migrations 0034–0043 unapplied on environments that must not run Phase 14. Additive schema only — no rewrite of historical Phase 10–13 archives. Disable Admin fraud routes or leave unused. Withdrawal create fails closed without ACTIVE Risk/Eligibility policy (no fabricated legacy Risk authority). No automatic change to AdsGram monetary status, Mainnet flags, or signer/hot-wallet controls.

---

## M. Exact accepted commit SHA

Canonical accepted **software source** commit (archive target; do not substitute report-only tip):

`9f39529e164f082f28d0e7c428c24b038f716410`

Independent-review Trust wallet-age remediation is this same tip commit
(`fix(trust): use verified primary wallet age`), which derives
`VERIFIED_PRIMARY_WALLET_AGE` per qualifying wallet from
`GREATEST(verified_at, became_primary_at)` only when both timestamps are non-null
(no `created_at` fallback). Regression matrix: old verified + new primary → unsatisfied;
old verified + old primary → satisfied; new verified + old primary → unsatisfied;
`NULL became_primary_at` → unsatisfied.

A later documentation-only commit may record this acceptance report; it is **not** the
canonical archive source.

---

## N. Gate PASS/FAIL

| Gate | Result |
| ---- | ------ |
| validate:migrations | **PASS** |
| verify:boundaries | **PASS** |
| security:secrets | **PASS** |
| fraud typecheck / test / build | **PASS** |
| withdrawals typecheck / build | **PASS** |
| test:phase7 | **PASS** |
| test:phase8 | **PASS** |
| test:phase10 | **PASS** |
| test:phase11 | **PASS** |
| test:phase13 | **PASS** |
| test:phase14 | **PASS** |
| typecheck (repo) | **PASS** |
| build (repo) | **PASS** |
| No client Risk/Trust/Eligibility authority | **PASS** |
| No Founder / Trust CRITICAL bypass | **PASS** |
| No auto payout / Mainnet / AdsGram monetary | **PASS** |
| Manual withdrawal approval mandatory | **PASS** |
| Trust wallet-age later-of-two semantics | **PASS** |
| Phase 15 not started | **PASS** |
| **PHASE14_GATE** | **PASS** |

---

## O. Archive verification

Archive helper version: **2.1.0**  
Fixed packaging stamp: **20260929-002123**  
Exact accepted source commit: `9f39529e164f082f28d0e7c428c24b038f716410`

| Artifact | Result |
| -------- | ------ |
| Canonical source ZIP | `ALEx_Rewards_PHASE_14_FRAUD_TRUST_ELIGIBILITY_20260929-002123_9f39529.zip` |
| Canonical source ZIP path | `phase-archives/PHASE_14_FRAUD_TRUST_ELIGIBILITY/ALEx_Rewards_PHASE_14_FRAUD_TRUST_ELIGIBILITY_20260929-002123_9f39529.zip` |
| Canonical source ZIP SHA256 | `5bf20a0773fd75b42e86169c2adafff694b37aa736a182c1f049fbafc183ff5e` |
| Final review-package filename | `PHASE_14_FRAUD_TRUST_ELIGIBILITY_PACKAGE_20260929-002123_9f39529.zip` |
| Source extraction | **PASS** |
| Outer package extraction | **PASS** |
| Prohibited-path scan (source + outer) | **PASS** |
| Nested source validation | **PASS** |
| Forward-slash ZIP entry names | **PASS** (4 entries under `PHASE_14_FRAUD_TRUST_ELIGIBILITY/`) |

Final review-package SHA256 is recorded externally in `PACKAGE_SHA256.txt` beside the package.
