# Phase 20 — Closed Beta / Minimal Funds Plan (Step 1)

**PHASE20_STATUS:** `IN_PROGRESS` (Step 1 discovery)
**PHASE20_GATE:** `HOLD`
**PHASE20_ARCHIVE:** `NOT CREATED`
**Phase 21:** `NOT STARTED`

**Branch:** `phase20-closed-beta`
**PHASE20_STARTING_HEAD:** `240d22a6c877f2d678668ba596238f6c8b234f71`
**Phase 19 archive/docs HEAD:** `240d22a6c877f2d678668ba596238f6c8b234f71`
**Phase 19 canonical product/security source:** `b5110524f90f29dc2a9235aac91ee9de731a03c0`

Master specification authority: Version 1.3 §177 — **PHASE 20 — CLOSED BETA / MINIMAL FUNDS**.

---

## 1. Purpose

Use internal/approved testers and **minimal financial exposure** to validate Closed Beta
product, security, and operations readiness before any Mainnet micro-launch.

Phase 20 validates (Master Spec):

1. provider moderation / compliance status
2. reward economics
3. no-fill behavior
4. user interface / UX
5. fraud / trust / eligibility
6. support behavior
7. Founder claim / benefit behavior with controlled accounts
8. budget / exposure controls
9. provider-limit version changes in staging
10. notification / mission behavior

Archive gate (later, not this step): create `PHASE_20_CLOSED_BETA` and **stop**.

Phase 20 remains isolated from Phase 21 Mainnet Micro-Launch.

---

## 2. Authority freeze (Step 1 baseline — do not change)

| Flag / posture | Value |
| --- | --- |
| MAINNET_ALLOWED | false |
| PRODUCTION_MONETARY_ALLOWED | false |
| PAYOUT_RESUME_AUTHORIZED | false |
| AUTO_UNPAUSE | false |
| AUTO_RESEND | false |
| ADSGRAM_PRODUCTION_MONETARY | BLOCKED |
| PHASE20_REAL_MONEY_EXECUTION_AUTHORIZED | false |
| STAGING PAYOUT_DISPATCH_PAUSE | true (unchanged; do not unpause in Step 1) |
| Signer | LOCKED (do not unlock in Step 1) |
| WITHDRAWAL_REAL_CHAIN_ENABLED | false (do not enable in Step 1) |

The Railway environment may be named `production`, but it remains operationally treated as
**staging** until separately authorized.

"Minimal funds" in the Master Spec does **not** authorize real-money movement in Step 1.

---

## 3. Explicit exclusions (Step 1 and until Owner re-authorizes)

- Enable Mainnet
- Enable production monetary behavior
- Enable AdsGram production monetary / set provider APPROVED for money
- Resume or unpause payout dispatch
- Signer unlock / TON broadcast / Hot Wallet funding for live payout
- Mutate Railway infrastructure or operational databases
- Delete Phase 18 restore sibling (`Postgres-phase18-restore-20261001-034920`)
- Create Phase 20 archive
- Start Phase 21
- Silently discard Phase 19 residual OPEN findings

---

## 4. Approved tester model

- Internal / Owner-approved accounts only
- Controlled Founder claim-code / grant subjects
- No public cohort expansion (that is Phase 22)
- Prefer observation and disposable/staging validation before any later minimal-funds test
- Never invent fake balances, fake ad fills, or fake rewards in UI or tests

---

## 5. Minimal-financial-exposure principle

1. Prefer evidence/session/no-fill/fraud/Founder/support validation **without** monetary unlock
2. AdsGram remains **BLOCKED** for money until clarifications + P19-SEC-010/011/012 reconsidered
3. Any later minimal-funds payout requires explicit Owner gates (see readiness matrix / gap register)
4. Fail closed on missing pause / missing policies / missing Jetton / ambiguous broadcast
5. No automatic transition to Phase 21 after Phase 20 archive

---

## 6. Phase 19 residual findings (carry-forward — not discarded)

| ID | Severity | Closed Beta note |
| --- | --- | --- |
| P19-SEC-004 | LOW | Founder claim blocked-user oracle — observe in controlled tests |
| P19-SEC-005 | LOW | Membership expires_at filter — observe |
| P19-SEC-006 | INFO | Entitlements exposure by design — document |
| P19-SEC-007 | MEDIUM | Founder grant idempotency scoping — test carefully |
| P19-SEC-008 | INFO | Telegram CC Founder ceremony differs from web |
| **P19-SEC-010** | **MEDIUM** | AdsGram duplicate when `provider_event_id` NULL — **reconsider before any production money** |
| **P19-SEC-011** | **LOW** | placement/blockId correlation — **reconsider before production money** |
| **P19-SEC-012** | **LOW** | REQUEST hard ceiling vs inert `provider_requests` — **reconsider before production money** |

See `docs/PHASE_20_GAP_REGISTER.md` for mapped gaps.

---

## 7. Required validation categories (traceability)

| # | Category | Primary companions |
| --- | --- | --- |
| 1 | Provider moderation / compliance | AdsGram status, clarifications, Admin monetary approval gate |
| 2 | Reward economics | Reward Engine rules, margin refuse, budgets, exposure |
| 3 | No-fill | Session lifecycle, Mini App Earn states |
| 4 | UI / UX | Mini App flows readiness matrix |
| 5 | Fraud / trust / eligibility | packages/fraud; client authority NONE |
| 6 | Support | tickets; no balance editor |
| 7 | Founder controlled | claim/grant/benefits; no security bypass |
| 8 | Budget / exposure | limits, flags, kill switches |
| 9 | Provider-limit staging changes | Admin ceremony + planned test procedure only in Step 1 |
| 10 | Notifications / missions | missions READY/PARTIAL; notifications stub |

---

## 8. Proposed Step ordering (future — do not auto-start)

Derived from repository evidence (not started by this Step 1 commit):

1. **Step 1 (this task):** readiness discovery / plan / matrix / gap register — **HOLD for review**
2. **Step 2:** close Closed-Beta-blocking source/config gaps that do **not** require real money
3. **Step 3:** controlled provider session / no-fill / unavailable UX validation (AdsGram money still BLOCKED)
4. **Step 4:** controlled fraud / trust / eligibility validation with Active policies as Owner-approved
5. **Step 5:** controlled Founder / support / mission validation; notifications honesty (draft-only)
6. **Step 6:** budget / exposure / provider-limit **staging** ceremony validation (no live unsafe limit raise)
7. **Step 7:** closed-beta runtime deployment validation (readiness evidence; still no unauthorized money)
8. **Step 8 (Owner-gated only):** reconsider AdsGram residuals + clarifications; only then consider
   monetary beta eligibility; separately Owner-gate minimal-funds withdrawal if in scope
9. **Step 9:** observe / reconcile / document results
10. **Step 10:** final Phase 20 acceptance + `PHASE_20_CLOSED_BETA` archive — then **STOP**

Do **not** start Step 2 in this task.

---

## 9. Stop / go gates

| Gate | Rule |
| --- | --- |
| Step 1 exit | Plan + matrix + gap register committed; `PHASE20_GATE=HOLD`; independent review |
| Closed Beta observation go | Residual Critical/High product blockers for observation = none; AdsGram money stays BLOCKED |
| Real-money AdsGram go | Owner closes clarifications; P19-SEC-010/011/012 reconsidered/remediated; authenticity/correlation gates; monetary APPROVED ceremony; re-certify |
| Minimal-funds payout go | Explicit Owner authorization + Jetton/providers/Hot Wallet + REAL chain + brief signer unlock + pause unpause ceremony + preflight READY |
| Archive go | Required validation categories evidenced; no unauthorized money; Phase 21 not started |
| Abort | Any Critical money leak, blind resend, pause bypass, signer isolation break, or Mainnet enablement without Owner |

---

## 10. Owner approval boundaries

Owner must explicitly approve before:

- Enabling AdsGram (or any provider) production monetary APPROVED
- Any real-chain withdrawal / Hot Wallet funding / signer unlock / pause resume
- Changing production/staging economic constants that expand liability
- Deleting Phase 18 restore sibling
- Declaring Phase 20 PASS / ARCHIVED
- Starting Phase 21

Cursor / automation must **not** invent Jetton masters, provider secrets, or Mainnet values.

---

## 11. Rollback / abort principles

- Prefer feature-flag / provider-status / pause fail-closed over code hotfix for money stops
- Keep `PAYOUT_DISPATCH_PAUSE` true until Owner ceremony
- Keep AdsGram monetary BLOCKED until evidence supports otherwise
- Never auto-resend / auto-unpause
- Archive does not authorize Phase 21

---

## 12. Planned provider-limit staging test procedure (do not execute in Step 1)

1. Use disposable or Owner-approved staging Admin session only
2. Confirm CSRF + recent reauth + consumed confirmation + sourceType/sourceReference + reason + expectedVersion
3. Attempt soft rule that would exceed PROVIDER_HARD → expect refuse
4. Valid soft change within hard ceiling → expect append-only version + audit
5. Verify authorize path still enforces effective limits
6. Do **not** raise hard ceilings without Owner; do **not** touch operational production money assumptions

API ceremony exists (`providers-admin` / `admin-limits`). Admin UI for limit ceremony remains PARTIAL — gap tracked.

---

## 13. Companions

- `docs/PHASE_20_READINESS_MATRIX.md`
- `docs/PHASE_20_GAP_REGISTER.md`
- `docs/PHASE_19_SECURITY_FINDINGS.md` (residuals)
- `docs/ADSGRAM_CLARIFICATION_REGISTER.md`
- `docs/WITHDRAWALS.md` / `docs/OPERATIONS_RUNBOOK.md`

---

## 14. Step 1 exit statement

`PHASE 20 STEP 1 = DISCOVERY COMPLETE / HOLD FOR INDEPENDENT REVIEW`

No Phase 20 archive. No Phase 21. No real-money execution authorized.