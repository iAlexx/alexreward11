# Phase 20 Acceptance Report — Closed Beta / Minimal Funds

**Status:** **PASS / ARCHIVED**

**Phase slug:** `PHASE_20_CLOSED_BETA`
**Master specification:** Version 1.3 §177 — PHASE 20 — CLOSED BETA / MINIMAL FUNDS
**Canonical accepted source commit:** `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8`
**Branch:** `phase20-closed-beta`

**PHASE20_GATE:** **PASS**
**PHASE20_STATUS:** **CLOSED / PASS / ARCHIVED**
**PHASE20_ARCHIVE:** **PASS**

**Wording (final):** `PHASE 20 CLOSED BETA = PASS / ARCHIVED`

## Scope distinction (prominent)

Phase 20 PASS means:

**CLOSED BETA / NON-MONETARY CONTROLLED VALIDATION = PASS**

It does **NOT** mean:

- real-money beta ready
- AdsGram monetary ready
- Mainnet ready
- withdrawal payout ready
- Phase 21 ready

```text
PHASE20_REAL_MONEY_READY=NO
PRODUCTION_MONETARY_ENABLED=NO
ADSGRAM_PRODUCTION_MONETARY=BLOCKED
WITHDRAWAL_REQUESTS_PAUSE/STAGING=true
PAYOUT_DISPATCH_PAUSE/STAGING=true
PAYOUT_RESUME_AUTHORIZED=NO
MAINNET=OFF
SIGNER_UNLOCKED_BY_PHASE20=NO
TON_BROADCAST_BY_PHASE20_FINAL_GATE=NO
PHASE21_STARTED=NO
PHASE21_AUTHORIZED=NO
```

Archive acceptance does **not** authorize AdsGram monetary approval, Referral money, Mission reward money, payout resume, signer unlock, hot-wallet funding, Mainnet, TON broadcast, Phase 21, or deletion of the Phase 18 restore sibling.

---

## A. Phase identification / status

Complete Master Specification V1.3 Phase 20 — Closed Beta / Minimal Funds non-monetary controlled validation.

Independent final acceptance review result: **PASS**.

This report packages final acceptance documentation and the `PHASE_20_CLOSED_BETA` archive only. Phase 21 has **not** started and is **not** authorized by this archive.

---

## B. Canonical source lineage

| Milestone                                               | SHA                                        |
| ------------------------------------------------------- | ------------------------------------------ |
| Phase 19 archive / Phase 20 starting docs baseline      | `240d22a6c877f2d678668ba596238f6c8b234f71` |
| Phase 19 canonical product/security source              | `b5110524f90f29dc2a9235aac91ee9de731a03c0` |
| Step 1 discovery                                        | `89db30a86da7aac9f270c1b689f69938764ca44c` |
| Step 1A gap-register blocker consistency                | `18ac91b01b6e91a357c404ff8346bcff90b3f0ca` |
| Step 2 non-money blocker preparation                    | `71dc3bf2d0bd7a992906e14b417d7ed41ff1927d` |
| Step 3 provider / no-fill observation                   | `abd6ce935e7ce66c354f62979dc1105e30bb869c` |
| Step 3A status wording alignment                        | `8fa4ee6fb89e750767965eeac456076cd62bf940` |
| Step 4A Owner policy decision pack                      | `8bb9359536f54e7e482ab73fa7c9f09a508bf728` |
| Step 4A.1 eligibility ACCOUNT_STATE / FEATURE_FLAG      | `f14d5118542eb525a7f82785ae1661ecc25bcacc` |
| Step 4A.2 REFERRAL_ACTIVATION unbind                    | `3f4a849617a31cec1c35dad0d7be6410200c94f2` |
| Step 4B Owner-approved fraud/trust/eligibility policy   | `17e059773a77dce96cbcbd8dee2622b46fa0bc85` |
| Step 4B.1 policy JSON decoupled from fraud runtime      | `f870842e88cbf5ca62b1cfd6a6e3a5458b6a6d54` |
| Step 4C staging preflight                               | `70841608eb1fd79cf658f10559d58501a03d5c1f` |
| Step 4C.1 preflight paths + pause seed plan             | `3b54864cf1ebee43aaf7ec75b9e8e091426b467a` |
| Step 4C.2 TOOLING_HEAD                                  | `cc15f1a89b46f8b86008b2359d11449ac83d35ab` |
| Step 4C.2 EVIDENCE_HEAD                                 | `49d4fa1b276838b78e5eccc398deb8ff51514113` |
| Canonical deployed RUNTIME_HEAD / production-runtime    | `b9dd700de428498493fb6e497ec16901684532c0` |
| Canonical runtime cutover + Step 4C activation evidence | `a14d5de69585829f9d249ac6368166930e9d736e` |
| Step 5 mission/referral Owner content scope             | `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8` |
| **CANONICAL_ACCEPTED_SOURCE_COMMIT**                    | `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8` |

Documentation/package commits after the canonical accepted source (this acceptance report and archive-record commits) are **not** the canonical software source. Archive packaging targets the canonical SHA via `git archive`.

---

## C. Canonical runtime

| Item                       | Value                                             |
| -------------------------- | ------------------------------------------------- |
| Canonical deploy branch    | `production-runtime`                              |
| Canonical runtime HEAD     | `b9dd700de428498493fb6e497ec16901684532c0`        |
| Application DEPLOYMENT_ENV | `staging` (Railway env name remains `production`) |

### Railway deployments (verified final acceptance, SUCCESS)

| Service         | Deployment ID                          | Branch             | Commit     | Health                         |
| --------------- | -------------------------------------- | ------------------ | ---------- | ------------------------------ |
| api-staging     | `183f0df2-57df-4ff4-9ceb-ac012813982b` | production-runtime | `b9dd700…` | PASS `/health/ready`           |
| worker-staging  | `16ea4c57-4ca7-4041-8854-dd48402b1de1` | production-runtime | `b9dd700…` | PASS localhost `/health/ready` |
| bot-staging     | `9597246d-7cd9-47f8-8582-7036941bbc80` | production-runtime | `b9dd700…` | PASS localhost `/health/ready` |
| miniapp-staging | `ffeafed1-5eda-4944-baed-9a3848fc8b0b` | production-runtime | `b9dd700…` | PASS `/`                       |
| admin-staging   | `7c1c2e94-0f2e-495f-b0d3-761c7909ef0c` | production-runtime | `b9dd700…` | PASS `/login`                  |

**Bot identity:** Telegram `getMe` username `LOOTRAbot` (canonical LOOTRABOT). Single intended bot runtime; no second bot created by Phase 20 final gate.

**Runtime vs docs:** Phase 20 acceptance source includes later documentation/evidence commits (through `b8135c2…`) while the deployed application runtime intentionally remains at `b9dd700…`. Final acceptance did **not** move `production-runtime`.

---

## D. Master-spec §177 category matrix

| #   | Category                                  | Evidence                                                                                                                    | Outcome                                                          |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | Provider moderation / compliance status   | AdsGram SANDBOX + BLOCKED; clarification register; Step 3 observation; P20-GAP-001..003 remain OPEN for money               | **PASS** (observation); money **BLOCKED**                        |
| 2   | Reward economics                          | Reward Engine server-only arithmetic; exposure/budget controls; monetary pauses; no live money in Closed Beta               | **PASS** (controls evidenced); live money **not** Phase 20 scope |
| 3   | No-fill behavior                          | Step 3 provider/no-fill harness + `docs/PHASE_20_STEP3_PROVIDER_NO_FILL_EVIDENCE.md`                                        | **PASS**                                                         |
| 4   | UI                                        | Mini App Home/Earn/Wallet/Founder/Support; Tasks honest empty; Friends non-monetary authority                               | **PASS** (Closed Beta UX honesty)                                |
| 5   | Fraud / trust / eligibility               | Owner-approved v1 ACTIVE staging policies; Step 4C controlled validation PASS                                               | **PASS**                                                         |
| 6   | Support                                   | Support tickets; Admin read-only; non-financial                                                                             | **PASS**                                                         |
| 7   | Founder claim/benefit controlled accounts | Zero-ledger claim/grant; Founder cannot bypass fraud/risk; residuals carried                                                | **PASS** (controlled); residuals OPEN for later                  |
| 8   | Budget / exposure controls                | Feature-flag pauses; exposure limits; payout/withdrawal request pauses true                                                 | **PASS** (restrictive posture retained)                          |
| 9   | Provider-limit version changes in staging | Admin limits API ceremony exists; live raise not required for Closed Beta observation                                       | **SCOPED** (API ready; no unsafe hard-ceiling raise in Phase 20) |
| 10  | Notification / mission behavior           | Notifications `DRAFT_ONLY_NO_SEND`; Missions `DEFERRED_NO_LIVE_CONTENT`; Friends pre-existing staging non-monetary accepted | **PASS** (Owner-scoped)                                          |

All ten categories have evidence and/or explicit Owner scope. None invented.

---

## E. Owner scope decisions

### Notifications

`NOTIFICATIONS_SCOPE = DRAFT_ONLY_NO_SEND` (P20-GAP-007 DEFERRED)

### Friends / Referral

`FRIENDS_EXISTING_STAGING_NON_MONETARY_ACCEPTED` — pre-existing staging Referral rule v1 + code policy v1 accepted for non-monetary validation only. Edge activation is a state transition, not money.

### Missions

`MISSIONS_SCOPE = DEFERRED_NO_LIVE_CONTENT` — zero ACTIVE mission content; honest empty Tasks list. No cohort system invented for Phase 20.

### Referral 500 bps

`REFERRAL_BASE_RATE_SCOPE = STAGING_PLACEHOLDER_NOT_MONETARY_APPROVAL`

`base_rate_bps=500` on the pre-existing staging rule is **not** production, real-money beta, Phase 21, or public monetary launch rate approval.

---

## F. Fraud / Trust / Eligibility

| Domain      | Staging state (final RO)                      |
| ----------- | --------------------------------------------- |
| Risk        | ACTIVE v1 — exactly one applicable ACTIVE row |
| Trust       | ACTIVE v1 — exactly one applicable ACTIVE row |
| Eligibility | ACTIVE v1 — exactly one applicable ACTIVE row |

Approved artifact: `packages/fraud/policy/phase20-closed-beta-owner-approved.json`  
Activation evidence: `docs/PHASE_20_CANONICAL_RUNTIME_CUTOVER_AND_STEP4C_ACTIVATION.md`, `docs/phase20-step4c-activation-evidence.json`  
Controlled post-validation: PASS (risk/trust/eligibility scenarios; Founder bypass NO).

P20-GAP-009 status: **REMEDIATED / OWNER_APPROVED / STAGING_ACTIVE / CONTROLLED_VALIDATION_PASS**.

---

## G. Financial safety posture (final RO confirmation)

```text
PRODUCTION_MONETARY_ENABLED=NO
ADSGRAM_LIFECYCLE=SANDBOX
ADSGRAM_PRODUCTION_MONETARY=BLOCKED
WITHDRAWAL_REQUESTS_PAUSE/STAGING=true
PAYOUT_DISPATCH_PAUSE/STAGING=true
REFERRAL_REWARD_PAUSE/STAGING=true
MISSION_REWARD_PAUSE/STAGING=MISSING
PAYOUT_RESUME_AUTHORIZED=NO
MAINNET=OFF
SIGNER_UNLOCKED_BY_PHASE20=NO
TON_BROADCAST_BY_PHASE20_FINAL_GATE=NO
```

Mission/referral content (final RO): mission definitions/versions active = 0; Referral rule v1 + code policy v1 pre-existing; PENDING edges = 1; ACTIVE edges = 0; 500 bps staging placeholder only.

`MISSION_REWARD_PAUSE/STAGING` remains MISSING because no live mission content exists — documented, not seeded by final acceptance.

---

## H. Remaining real-money blockers

```text
P20_BLOCKING_CLOSED_BETA_COUNT=0
P20_BLOCKING_ARCHIVE_COUNT=0
P20_BLOCKING_REAL_MONEY_COUNT=7
PHASE20_REAL_MONEY_READY=NO
```

Real-money blocker IDs (must remain OPEN):

- P20-GAP-001
- P20-GAP-002
- P20-GAP-003
- P20-GAP-004
- P20-GAP-005
- P20-GAP-006
- P20-GAP-011

Phase 20 archive does **not** resolve, waive, or accept these for real money. They must be resolved/reviewed before any later monetary launch.

---

## I. Phase 19 residual findings (carry-forward)

Preserved OPEN residuals mapped into the Phase 20 gap register (not silently closed by Phase 20 PASS):

| P19 ID      | P20 mapping | Severity |
| ----------- | ----------- | -------- |
| P19-SEC-010 | P20-GAP-004 | MEDIUM   |
| P19-SEC-011 | P20-GAP-005 | LOW      |
| P19-SEC-012 | P20-GAP-006 | LOW      |
| P19-SEC-007 | P20-GAP-012 | MEDIUM   |
| P19-SEC-004 | P20-GAP-013 | LOW      |
| P19-SEC-005 | P20-GAP-014 | LOW      |
| P19-SEC-006 | P20-GAP-015 | INFO     |
| P19-SEC-008 | P20-GAP-016 | INFO     |

Owner-scoped DEFERRED gaps (007, 017) remain **DEFERRED**, not REMEDIATED.

---

## J. Runtime / operational mutations during Phase 20

Accurate distinction:

| Event                                                                         | Occurred in Phase 20?                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| Canonical LOOTRA Railway runtime cutover to `production-runtime` @ `b9dd700…` | **YES** (Owner-authorized Step 4C activation ceremony) |
| Risk/Trust/Eligibility staging ACTIVE v1 insert                               | **YES**                                                |
| `WITHDRAWAL_REQUESTS_PAUSE/STAGING=true` seed + version history               | **YES**                                                |
| Final acceptance / archive ceremony operational mutation                      | **NO** (read-only + docs/archive only)                 |

Phase 20 is **not** falsely claimed to have zero operational changes overall. Final acceptance itself performed **no** Railway deploy, **no** operational DB mutation, **no** feature-flag toggle.

Phase 18 restore sibling `Postgres-phase18-restore-20261001-034920` **RETAINED** (confirmed present).

---

## K. Final validation gates

Executed against tracked HEAD `b8135c2a94cf5939371100cdbbf2316ba2eeb5e8` with disposable DB only where mutation required (`127.0.0.1:55432/alex_rewards_phase20_test`). Operational Railway Postgres used **read-only** for safety confirmation only.

| Gate                                        | Result                                                   |
| ------------------------------------------- | -------------------------------------------------------- |
| `pnpm phase20:gap-register:check`           | **PASS** (Closed Beta 0 / real-money 7 / archive 0)      |
| `pnpm phase20:step4b:policy-check`          | **PASS**                                                 |
| `pnpm phase20:step3` (provider/no-fill)     | **PASS**                                                 |
| Phase 20 mission empty-list                 | **PASS** (1)                                             |
| Phase 20 referral authority + controlled    | **PASS** (5)                                             |
| Phase 15 attribution/activation/code-policy | **PASS** (27)                                            |
| Phase 16 mission-version unit               | **PASS** (2)                                             |
| `pnpm verify:boundaries`                    | **PASS**                                                 |
| `pnpm validate:migrations`                  | **PASS** (58)                                            |
| `pnpm security:secrets`                     | **PASS**                                                 |
| `pnpm security:audit`                       | **PASS** (Critical **0**, High **0**, Moderate 4, Low 1) |
| `pnpm test:archive`                         | **PASS** (9)                                             |
| `pnpm -w run typecheck`                     | **PASS** (52/52)                                         |
| `pnpm -w run build`                         | **PASS** (29/29)                                         |
| Final RO staging safety                     | **PASS**                                                 |
| Railway runtime HEAD match (5 services)     | **PASS**                                                 |
| LOOTRAbot canonical                         | **PASS**                                                 |
| Phase 18 restore sibling retained           | **PASS**                                                 |

No mandatory final gate silently skipped.

---

## L. Explicit non-authorizations

This archive does **NOT** authorize:

- AdsGram monetary approval / production monetary enablement
- Referral money issuance / `REFERRAL_REWARD_PAUSE` change
- Mission reward money / live mission publish
- Payout resume / `PAYOUT_DISPATCH_PAUSE` change
- Signer unlock / hot-wallet funding
- Mainnet enablement
- TON broadcast
- Phase 21 start
- Deletion of Phase 18 restore sibling `Postgres-phase18-restore-20261001-034920`
- Moving `production-runtime` away from `b9dd700…` solely to match docs commits

---

## M. Exact canonical accepted source SHA

**CANONICAL_ACCEPTED_SOURCE_COMMIT:**

`b8135c2a94cf5939371100cdbbf2316ba2eeb5e8`

**CANONICAL_RUNTIME_HEAD:**

`b9dd700de428498493fb6e497ec16901684532c0`

**Branch:** `phase20-closed-beta`

---

## N. Gate PASS/FAIL summary

| Gate                                         | Result           |
| -------------------------------------------- | ---------------- |
| Master-spec §177 categories evidenced/scoped | **PASS** (10/10) |
| Closed Beta blockers                         | **0**            |
| Archive blockers                             | **0**            |
| Real-money blockers preserved                | **7**            |
| Dependency Critical/High                     | **0 / 0**        |
| Monetary safety restrictive                  | **PASS**         |
| Runtime on production-runtime @ b9dd700      | **PASS**         |
| Final ceremony operational mutation          | **NO**           |
| Phase 21 started                             | **NO**           |

---

## O. Archive package hash

Outer review-package SHA256 is recorded externally in `PACKAGE_SHA256.txt` beside the review package (not embedded here — self-reference forbidden). See `docs/PHASE_ARCHIVE.md`.
