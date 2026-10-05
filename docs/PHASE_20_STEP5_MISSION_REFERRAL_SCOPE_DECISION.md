# Phase 20 Step 5 — Mission / Referral Owner content scope decision

**Date:** 2026-10-02  
**Branch:** `phase20-closed-beta`  
**Owner decision ID:** `PHASE20_CONTENT_SCOPE = FRIENDS_EXISTING_STAGING_NON_MONETARY_ACCEPTED__MISSIONS_DEFERRED_NO_LIVE_CONTENT`

This task records Owner scope only. It did **not** create operational mission/referral content, mutate staging rows, deploy Railway, or enable money.

---

## 1. Owner decision

| Surface                | Phase 20 scope                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| **Friends / Referral** | Accept pre-existing staging Referral v1 + code policy for **non-monetary** Closed-Beta validation |
| **Tasks / Missions**   | `DEFERRED_NO_LIVE_CONTENT` — no ACTIVE mission publish in Phase 20                                |

Non-monetary Friends behavior accepted:

- Server-generated referral codes
- Signed referral attribution
- Self-referral refusal; one-time attribution
- PENDING referral edges; Referral V1 activation (account age >= 86400s, >= 5 valid AVAILABLE rewarded ads, no OPEN CRITICAL fraud)
- Server-authoritative invited/activated counts; Telegram referral links
- Referral edge activation as a **state transition only** — not Referral money

---

## 2. Fresh read-only staging state (2026-10-02)

Operational Postgres via SSH tunnel, `default_transaction_read_only=on`, mutation probe refused.

| Domain                 | Observation                                  |
| ---------------------- | -------------------------------------------- |
| Mission definitions    | total=0, active=0                            |
| Mission versions       | total=0, active_now=0, active_monetary_now=0 |
| Referral rules         | total=1, active_now=1                        |
| Referral code policies | total=1, active_now=1                        |
| Referral edges         | PENDING=1, ACTIVE=0                          |

### Active Referral rule v1 (pre-existing)

| Field                          | Value                                                                      |
| ------------------------------ | -------------------------------------------------------------------------- |
| rule_version                   | 1                                                                          |
| status                         | ACTIVE                                                                     |
| activation_account_age_seconds | 86400                                                                      |
| activation_valid_ad_count      | 5                                                                          |
| base_rate_bps                  | 500                                                                        |
| reason                         | staging-only default Referral V1 activation rule; monetary issuance paused |
| source_reference               | master-spec-v1.3:referral-default-24h-5ads;placeholder-500bps              |

### Active Referral code policy v1 (pre-existing)

| Field            | Value                                                |
| ---------------- | ---------------------------------------------------- |
| policy_version   | 1                                                    |
| status           | ACTIVE                                               |
| reason           | staging-only runtime validation referral code policy |
| source_reference | railway:staging-runtime-validation:2026-09-30        |

**Provenance:** These rows existed before Step 5 (prior staging-runtime-validation lineage). This task did not INSERT/UPDATE them.

---

## 3. Feature flags and money safety

| Flag / control              | STAGING state                         |
| --------------------------- | ------------------------------------- |
| REFERRAL_REWARD_PAUSE       | **true**                              |
| MISSION_REWARD_PAUSE        | **MISSING** (no live mission content) |
| PAYOUT_DISPATCH_PAUSE       | true                                  |
| WITHDRAWAL_REQUESTS_PAUSE   | true                                  |
| AdsGram lifecycle           | SANDBOX                               |
| AdsGram production monetary | BLOCKED                               |

`MISSION_REWARD_PAUSE/STAGING` is intentionally **not** seeded: zero ACTIVE mission definitions/versions. Future live mission activation requires a separate Owner-gated pause/content ceremony.

---

## 4. 500 bps is NOT monetary approval

`base_rate_bps=500` on the pre-existing staging rule is a **staging placeholder** attached to active staging configuration.

It is **not** approved as production Referral rate, real-money beta rate, Phase 21 rate, or public monetary launch rate.

Before any future Referral monetary enablement, a separate Owner ceremony is required for base rate, membership REFERRAL_RATE_BOOST (if applicable), MAX_REFERRAL_BONUS_DAILY, source-reward eligibility, provider monetary approval, Referral reward pause change, and exposure/budget controls.

No future task may infer: `500 bps staging placeholder => approved production 5%`.

---

## 5. Referral money pause — source proof

`packages/rewards/src/issue-referral.ts`:

- `isReferralRewardPaused()` reads `REFERRAL_REWARD_PAUSE` for the command environment **before** rate resolution, exposure reservation, or Ledger issuance.
- When paused, `issueReferralReward()` records decision outcome `SKIPPED` / reason `REFERRAL_REWARD_PAUSE` and returns without Referral reward Ledger issuance.

Disposable validation (LOCAL env, `alex_rewards_phase20_test`): `REFERRAL_PAUSE_GUARD=PASS` — `kind=skipped`, `reasonCode=REFERRAL_REWARD_PAUSE`.

This task did **not** toggle `REFERRAL_REWARD_PAUSE/STAGING` and did not issue a real Referral reward on staging.

---

## 6. Why missions are deferred (cohort limitation)

Mission producers are general runtime producers. Example: `selectDailyLoginContributionCandidates(...)` in `packages/tasks/src/producer-shared.ts` joins ACTIVE mission versions to general `user_sessions` without a Phase 20 approved-tester cohort filter.

Publishing an ACTIVE mission solely to close P20-GAP-017 would broaden behavior beyond a bounded internal/approved tester cohort. Phase 20 does not implement a new cohort system for this closure.

Referral maintenance (`processPendingReferralActivationBatch` in `packages/referrals/src/runtime.ts`) evaluates general PENDING edges when ACTIVE configuration exists — accepted here because pre-existing staging config is scoped to **non-monetary** Friends validation with `REFERRAL_REWARD_PAUSE/STAGING=true`.

These are general runtime behaviors requiring appropriate rollout scope — not security vulnerabilities.

---

## 7. Validation executed

| Suite                                                | Result    |
| ---------------------------------------------------- | --------- |
| Phase 20 mission empty-list (`listUserMissions`)     | PASS (1)  |
| Phase 20 referral authority (unit)                   | PASS (3)  |
| Phase 20 referral controlled attribution (DB)        | PASS (2)  |
| Phase 15 attribution + activation + code-policy (DB) | PASS (27) |
| Phase 16 mission-version (unit)                      | PASS (2)  |
| Disposable Referral pause guard                      | PASS      |

Friends authority covered: self-referral blocked; ALREADY_ATTRIBUTED; 24h + 5 AVAILABLE ads activation semantics; OPEN CRITICAL fraud blocks activation; Founder cannot bypass CRITICAL fraud; no hardcoded 500/700 bps production defaults in effective-rate source.

Tasks honesty: zero live content -> empty list; no fabricated rewards/progress/claimability.

---

## 8. Future activation requirements

**Missions:** Owner-approved ACTIVE mission version(s), reward rule binding, cohort/rollout strategy, and explicit pause/content ceremony including `MISSION_REWARD_PAUSE` when appropriate.

**Referral money:** Separate Owner ceremony for economic rate approval, pause change, provider monetary gates, exposure controls — independent of accepting pre-existing staging non-monetary config.

---

## 9. Explicit non-authorizations

This Step 5 task did **not** authorize or perform mission content publish/seed; Referral rule/code-policy create/modify/revoke on staging; Referral or mission monetary enablement; feature-flag toggle on staging; Ledger/reward/payout mutation on staging; Railway deploy; Phase 20 archive; or Phase 21 start.

---

## 10. P20-GAP-017 outcome

**Status:** `DEFERRED / OWNER_SCOPED_FOR_PHASE20 — FRIENDS EXISTING STAGING NON-MONETARY ACCEPTED; MISSIONS NO LIVE CONTENT`

**Blockers after closure:** Closed Beta 0 · Real-money 7 · Archive 0

**Phase 20 gate:** `HOLD_FOR_FINAL_ACCEPTANCE_REVIEW` (not PASS; archive not created)
