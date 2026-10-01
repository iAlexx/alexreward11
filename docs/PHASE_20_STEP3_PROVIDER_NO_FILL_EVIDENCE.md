# Phase 20 Step 3 — Provider / No-Fill / Earn UX Evidence

**PHASE20_GATE:** HOLD  
**Branch:** `phase20-closed-beta`  
**Authority freeze:** AdsGram production monetary **BLOCKED**; Mainnet OFF; payout resume unauthorized; no Railway deploy; disposable DB only.

---

## Owner notification scope (recorded)

`NOTIFICATIONS_SCOPE = DRAFT_ONLY_NO_SEND`  
`P20-GAP-007` → **DEFERRED** (`OWNER_SCOPED_FOR_PHASE20 — DRAFT_ONLY_NO_SEND`)  
Delivery is **not** implemented.

---

## Scenarios tested

| Scenario | Server path | UI outcome | Financial side effects | Result |
| --- | --- | --- | --- | --- |
| AdsGram authenticity NONE | `verifyServerSignal` → UNVERIFIED / NONE / monetaryAuthority=false | N/A | none | PASS |
| AdsGram monetary BLOCKED + complete evidence | `attemptVerifyAndIssueAdReward` soft refuse | `monetary_blocked` (no celebration) | ledger/reward/balance unchanged | PASS |
| Repeated verify while BLOCKED | second attempt still issued=false | same | unchanged | PASS |
| NO_FILL terminal | `recordAdSessionOutcome(NO_FILL)` | domain `NO_FILL`; WatchEarnCard maps NO_FILL | quote released; ledger 0 | PASS |
| Late CLIENT_COMPLETION after NO_FILL | TERMINAL_STATE_IMMUTABLE | remains NO_FILL | none | PASS |
| LOAD/START/TECHNICAL_FAILURE | client signals → FAILED | ERROR mapping in card source | no money | PASS |
| USER_SKIPPED | → SKIPPED | SKIPPED mapping | no money | PASS |
| CLIENT_COMPLETION alone | not VERIFIED/REWARDED | `clientCompletionMayCelebrate()===false` | no money until verify; verify still BLOCKED | PASS |
| Earn gate BLOCKED / missing block / health / limits | `resolveEarnAttemptGate` | canStart=false | N/A | PASS |
| issued===true only celebration | `resolveEarnVerifyOutcome` | celebration only if issued | N/A | PASS |
| Client authority fields | `assertNoClientAuthorityFields` | N/A | refused | PASS |

Automated suites:

- `packages/ads/test/phase20-provider-nofill-blocked.db.test.ts`
- `apps/miniapp/test/phase20-earn-nofill-ux.unit.test.ts`
- baseline `apps/miniapp/test/earn-authority.test.ts`
- harness `pnpm phase20:step3` (+ `PHASE20_STEP3_REQUIRE_DB_GATES=1`)

---

## Remaining limitations (not closed by Step 3)

- P20-GAP-001..006, 009, 011 remain OPEN for real-money
- AdsGram still unsigned / BLOCKED / clarifications OPEN
- No runtime Railway deployment validation in this step
- P20-GAP-009 / 017 still block Closed Beta / archive until Owner policy/content

**Step 3 observation success does NOT mean AdsGram is production-money safe.**