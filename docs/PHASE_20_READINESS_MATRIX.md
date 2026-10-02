# Phase 20 — Closed Beta Readiness Matrix (Step 1–3)

**PHASE20_GATE:** PASS
**Step:** Phase 20 CLOSED / PASS / ARCHIVED; real-money blockers remain 7; Phase 21 NOT STARTED
**Evidence HEAD (canonical accepted source):** `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8`
**Canonical runtime:** `production-runtime @ b9dd700de428498493fb6e497ec16901684532c0`
**Canonical Phase 19 product/security source:** `b5110524f90f29dc2a9235aac91ee9de731a03c0`
**Authority freeze:** MAINNET=false; PRODUCTION_MONETARY=false; PAYOUT_RESUME=false; ADSGRAM_PRODUCTION_MONETARY=BLOCKED; PHASE20_REAL_MONEY_EXECUTION_AUTHORIZED=false; PHASE21_AUTHORIZED=false

Statuses: `READY` | `PARTIAL` | `BLOCKED` | `NOT_IMPLEMENTED` | `EXTERNAL_CLARIFICATION_REQUIRED`

Do not mark READY without source/runtime evidence.

---

## Provider status matrix

| Provider                | Class       | Monetary                                                             | Notes                                        |
| ----------------------- | ----------- | -------------------------------------------------------------------- | -------------------------------------------- |
| ADSGRAM                 | BLOCKED     | Cannot issue rewards while BLOCKED + clarifications OPEN + auth NONE | Sessions/evidence/no-fill OK for observation |
| SIMULATED_REWARD_SOURCE | TEST_ONLY   | Forced BLOCKED                                                       | Rewards package simulation only              |
| HarnessCertProvider     | TEST_ONLY   | Test harness                                                         | Certification only                           |
| Other networks          | UNSUPPORTED | N/A                                                                  | No adapter                                   |

No provider is classified `BETA_ELIGIBLE` or `PRODUCTION_ELIGIBLE` for monetary use on current evidence.

---

## Requirement matrix

| ID  | Requirement                                         | Components                                                   | Current state                                                                                                                                      | Evidence                                                                                                            | Readiness                            | Missing work                                                                        | Financial impact         | Security impact        | Required test                                       | Owner approval                           |
| --- | --------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------ | ---------------------- | --------------------------------------------------- | ---------------------------------------- |
| R01 | Provider moderation / compliance status represented | `ad_providers`, clarification items, Admin monetary approval | AdsGram seeded BLOCKED; Admin refuses APPROVED while OPEN clarifications                                                                           | `migrations/0030_phase11_adsgram_foundation.sql`; `admin-monetary-approval.ts`; `ADSGRAM_CLARIFICATION_REGISTER.md` | PARTIAL                              | Close clarifications only when evidence supports; keep BLOCKED for Step 1           | High if wrongly APPROVED | High                   | Admin refuse-APPROVED + gate tests (existing)       | Yes to APPROVE monetary                  |
| R02 | Reward economics controls                           | Reward Engine rules, margin, budgets, exposure, pauses       | Server-only arithmetic; ACTIVE margin limit refuses without Owner formula; budgets/exposure reserve                                                | `packages/rewards/src/{arithmetic,guardrails,budgets,exposure,quotes}.ts`                                           | PARTIAL                              | Owner-approved ACTIVE rules/budgets for beta cohort; avoid unsafe ACTIVE margin     | High                     | Medium                 | Quote refuse / budget reserve tests                 | Yes for live economic constants          |
| R03 | No-fill behavior                                    | Ads sessions + Mini App Earn                                 | Terminal NO_FILL; no reward; honest UI states                                                                                                      | `lifecycle.ts`; Step 3 DB+UX suites; `PHASE_20_STEP3_PROVIDER_NO_FILL_EVIDENCE.md`                                  | READY (observation / money BLOCKED)  | Runtime Railway observation later (Step 7); money stays BLOCKED                     | None while BLOCKED       | Low                    | Step 3 harness + disposable DB                      | No for observation                       |
| R04 | Closed Beta UI / UX                                 | Mini App Home/Earn/Tasks/Friends/Wallet/Founder/Support      | Home/Wallet/Founder/Support READY; Earn PARTIAL (UI ok, money BLOCKED); Tasks/Friends PARTIAL; Activity PLACEHOLDER; Notifications NOT_IMPLEMENTED | `apps/miniapp/src/**`                                                                                               | PARTIAL                              | Decide Activity/Notifications scope for beta; seed ACTIVE missions if Tasks claimed | Low                      | Low                    | Manual closed-beta UX checklist                     | Yes if claiming incomplete screens READY |
| R05 | Fraud / trust / eligibility                         | `packages/fraud`                                             | Engines authoritative when ACTIVE; fail-closed if missing; client authority NONE; Founder cannot bypass risk                                       | `evaluate-and-persist*.ts`; Phase 14 acceptance; `phase20-eligibility-controlled.db.test.ts`; policy proposal doc   | PARTIAL                              | Owner-approved ACTIVE policy seeds for staging beta (TEST fixtures REFERENCE ONLY)  | Medium                   | High                   | Controlled eligibility/fraud scenarios              | Yes for policy seeds                     |
| R06 | Support behavior                                    | `packages/support`, Admin support GET                        | User tickets; Admin read-only; deletion non-financial; no balance editor                                                                           | `tickets.ts`; `support-admin.controller.ts`                                                                         | READY                                | Controlled ticket create/list                                                       | None                     | Low                    | Controlled support ticket path                      | No                                       |
| R07 | Founder controlled-account behavior                 | auth membership + control-center founder-admin               | Claim/grant zero ledger; confirmation on web issue; benefits via entitlements only                                                                 | `membership.ts`; Phase 19 claim-code gates                                                                          | PARTIAL                              | Exercise residuals 004/005/007 carefully; CC vs web ceremony (008)                  | Low (no claim money)     | Medium                 | Controlled claim/grant/benefit tests                | Yes for live Founder codes               |
| R08 | Budget / exposure / kill switches                   | exposure limits, budgets, feature flags                      | DB SoT; GLOBAL_REWARDS_PAUSE etc.; PAYOUT_DISPATCH_PAUSE fail-closed missing in STAGING/PROD                                                       | `guardrails.ts`; `flags.ts`; `0011_seed_local_fixtures.sql`                                                         | PARTIAL                              | Confirm staging flag rows match freeze; exposure limits sized for beta              | High                     | High                   | Flag pause + exposure refuse tests                  | Yes to change live flags                 |
| R09 | Provider-limit version changes (staging)            | Admin limits API + ceremony                                  | API enforces CSRF/reauth/confirmation/expectedVersion/hard ceiling/append-only                                                                     | `providers-admin.controller.ts`; `admin-limits.ts`                                                                  | PARTIAL                              | Admin UI ceremony surface incomplete; execute planned procedure later               | Medium                   | High                   | Planned staging limit change procedure (not Step 1) | Yes before live limit mutate             |
| R10 | Missions behavior                                   | tasks + rewards issue-mission                                | DRAFT/REVOKED refuse claim+issuance; pause soft-block; empty list honest                                                                           | `prepare-claim.ts`; `issue-mission.ts`; `phase20-mission-list-empty.db.test.ts`; content proposal                   | PARTIAL                              | Owner-published ACTIVE mission versions for beta cohort                             | Medium                   | Medium                 | Controlled mission claim/issue                      | Yes for live mission publish             |
| R11 | Notifications behavior                              | notifications package + Admin                                | Owner `DRAFT_ONLY_NO_SEND`; Admin draft metadata only; delivery NOT implemented                                                                    | Step 2 proofs + Owner Step 3 decision; P20-GAP-007 DEFERRED                                                         | READY (scoped draft/no-send)         | Future delivery MVP out of Phase 20                                                 | Low                      | Medium if wrongly sent | Draft-only / no-send assertions                     | Delivery MVP later                       |
| R12 | AdsGram authenticity / monetary gate                | adapter + monetary eligibility                               | auth NONE; rewardCredited false on webhook; attempt-verify gated                                                                                   | `adapter.ts`; `eligibility.ts`; webhook controller                                                                  | BLOCKED (money) / PARTIAL (evidence) | Clarifications + signed authenticity before money                                   | High                     | High                   | Cert harness refuse-money tests                     | Yes for APPROVED                         |
| R13 | P19-SEC-010 duplicate NULL event id                 | ads webhooks / DB unique                                     | OPEN residual                                                                                                                                      | `PHASE_19_SECURITY_FINDINGS.md`                                                                                     | BLOCKED for real money               | Remediate or Owner-accept before money                                              | High if money on         | Medium                 | Duplicate webhook proof                             | Yes if accepting residual                |
| R14 | P19-SEC-011 placement/blockId                       | correlation                                                  | OPEN residual                                                                                                                                      | findings                                                                                                            | BLOCKED for real money               | Remediate before money                                                              | Medium                   | Medium                 | Correlation unit tests                              | Prefer remediate                         |
| R15 | P19-SEC-012 REQUEST hard ceiling                    | limits issue path                                            | OPEN residual; authorize uses session count                                                                                                        | findings; authorize.ts                                                                                              | BLOCKED for real money               | Align counters before money                                                         | Medium                   | Medium                 | Limit enforcement tests                             | Prefer remediate                         |
| R16 | Withdrawal minimal-funds readiness                  | withdrawals + signer                                         | Engine implemented; operationally paused/locked/REAL off                                                                                           | `WITHDRAWALS.md`; `phase10-readiness.ts`; runbook                                                                   | BLOCKED                              | Owner resources + explicit gates before any payout test                             | Critical                 | Critical               | phase10 preflight then Owner-gated live             | Yes (multiple)                           |
| R17 | Isolation from Phase 21                             | docs / process                                               | Spec separates Phase 20 archive stop from Phase 21                                                                                                 | Spec §177–178; this plan                                                                                            | READY (process)                      | Keep HOLD until archive; no Mainnet HW                                              | Critical if violated     | Critical               | Process review                                      | Yes to start Phase 21                    |
| R18 | Phase 18 restore sibling retained                   | Railway Postgres sibling                                     | Read-only: service Online                                                                                                                          | `railway status` 2026-10-01 session                                                                                 | READY                                | Do not delete                                                                       | Ops                      | Ops                    | Retain until Owner cleanup                          | Yes to delete                            |
| R19 | Runtime baseline (Railway)                          | ideal-perception / production env name                       | Services Online; env named production treated as staging; PITR evidence exists                                                                     | `railway status`; `phase18-runtime-evidence/`                                                                       | PARTIAL                              | Deployed commit SHA not fully enumerated in Step 1 without deeper service inspect   | Ops                      | Ops                    | Later Step 7 deployment validation                  | Yes to deploy                            |

---

## Mini App flow classification (Closed Beta)

| Flow                                | Class                                       |
| ----------------------------------- | ------------------------------------------- |
| Home                                | READY                                       |
| Earn                                | PARTIAL (UI READY; money BLOCKED)           |
| Tasks                               | PARTIAL                                     |
| Friends / referrals                 | PARTIAL                                     |
| Wallet                              | READY                                       |
| Withdrawals UI                      | PARTIAL (server pause/eligibility dominate) |
| Founder claim                       | READY                                       |
| Support                             | READY                                       |
| Errors / empty / engine unavailable | READY                                       |
| Activity                            | PLACEHOLDER                                 |
| Notifications inbox                 | NOT_IMPLEMENTED                             |

---

## Withdrawal — prerequisites before later minimal-funds payout (not satisfied in Step 1)

1. Explicit Owner Phase 20 real-money authorization
2. Owner-supplied Testnet Jetton master + dual providers + signer URL/token + Hot Wallet identity/funding
3. `WITHDRAWAL_REAL_CHAIN_ENABLED` explicit enable
4. Brief signer unlock
5. `PAYOUT_DISPATCH_PAUSE` unpause via Feature Flags ceremony after reconcile gates
6. ACTIVE withdrawal fee/limit rows
7. `phase10:readiness` / preflight READY_FOR_CONTROLLED_LIVE_TESTNET
8. Manual approve path capacity

Do **not** satisfy these in Step 1.

---

## Railway read-only baseline (Step 1)

| Field             | Value                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Workspace         | My Projects                                                                                |
| Project           | ideal-perception (`012341aa-02f8-4f6f-8fb2-215ec96c0c0f`)                                  |
| Environment name  | `production` (operationally staging)                                                       |
| Services Online   | api-staging, bot-staging, temporal-staging, admin-staging, worker-staging, miniapp-staging |
| Databases Online  | Redis, Postgres, `Postgres-phase18-restore-20261001-034920`                                |
| PITR bucket       | Postgres-PITR present; prior evidence enabled/archiverHealthy                              |
| Secrets printed   | NO                                                                                         |
| Variables changed | NO                                                                                         |
| Deploy performed  | NO                                                                                         |

Latest deployed commit SHAs were not exhaustively captured per service in Step 1 (status shows Online; deeper SHA drill deferred to deployment validation step).
