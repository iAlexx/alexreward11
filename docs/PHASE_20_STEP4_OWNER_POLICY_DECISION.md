# Phase 20 Step 4A — Owner Fraud / Trust / Eligibility Policy Decision Pack

**PHASE20_GATE:** HOLD  
**Step:** 4A — OWNER DECISION PACK ONLY (no activation)  
**Branch:** `phase20-closed-beta`  
**Related gap:** `P20-GAP-009` status remains `OPEN / READY_FOR_OWNER_POLICY_APPROVAL`  
**Companion (historical Step 2):** `docs/PHASE_20_FRAUD_ELIGIBILITY_POLICY_PROPOSAL.md`

**Authority freeze (unchanged):** Mainnet OFF; production monetary OFF; AdsGram monetary BLOCKED; payout resume unauthorized; no Railway/ops DB mutation; no policy INSERT/UPDATE to ACTIVE staging rows in this step.

This document does **not** activate policies. Values labeled **PROPOSED** require explicit Owner approval before any later activation step.

---

## 1. Source review summary (authoritative)

Inspected packages under `packages/fraud/src/` (not docs alone):

| Area              | Primary modules                                                    | Key semantics                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk parse        | `risk-rule.ts`                                                     | thresholds 0–100 with `lowMax < mediumMax < highMax`; weights 0–100 integer; actions must map all tiers to allowlisted codes; fail-closed if no single ACTIVE rule    |
| Risk score        | `risk-evaluator.ts`                                                | `score = min(sum(active weights), 100)`; tier from thresholds; action from rule; **`neverAutoBan: true`**; does **not** execute actions / mutate users / write ledger |
| Risk collect      | `risk-signal-collector.ts`                                         | Only configured weight keys with a collector run; unsupported key → fail-closed                                                                                       |
| Risk persist      | `evaluate-and-persist.ts`                                          | Server time + FOR SHARE ACTIVE rule; collector facts only; snapshot + profile upsert; **actions returned, not executed**                                              |
| Trust parse       | `trust-rule.ts`                                                    | signals allowlist + stateThresholds; no Founder/Risk-bypass fields                                                                                                    |
| Trust score       | `trust-evaluator.ts`                                               | satisfied weight sum capped 100 → NEW/BASIC/ESTABLISHED/TRUSTED                                                                                                       |
| Trust collect     | `trust-signal-collector.ts`                                        | DB ages/counts only; no membership/Founder                                                                                                                            |
| Eligibility parse | `eligibility-policy.ts`                                            | per-action `requiredGates` + `precedence` (exact same set) + `riskAllowedActions` iff RISK_POLICY required                                                            |
| Eligibility eval  | `eligibility-evaluator.ts` / `evaluate-and-persist-eligibility.ts` | exact gate-set match; precedence picks primary blocked gate; client cannot supply gates/outcome/score                                                                 |

**Client authority:** none. Callers supply `userId` / `actionType` / `deploymentEnvironment` (+ optional server `missionVersionId`). Gate facts, scores, tiers, and outcomes are server-only.

**Founder / membership:** Trust policy forbids Founder bypass fields. Eligibility MEMBERSHIP gate checks entitlements without special-casing Founder plan codes. Risk does not read membership.

---

## 2. Supported catalogs (source)

### 2.1 Risk — collector-supported signal codes (authoritative for ACTIVE evaluateAndPersistRisk)

From `COLLECTOR_SIGNAL_CODES`:

| Code                             | Activates when                                   | Params                                                  |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `OPEN_HIGH_FRAUD_FLAG`           | ≥1 OPEN HIGH fraud_flags                         | none                                                    |
| `OPEN_CRITICAL_FRAUD_FLAG`       | ≥1 OPEN CRITICAL fraud_flags                     | none                                                    |
| `CONFIRMED_FRAUD_FLAG`           | ≥1 CONFIRMED fraud_flags                         | none                                                    |
| `SHARED_PAYOUT_WALLET`           | other users share verified primary payout wallet | none                                                    |
| `SHARED_DEVICE_SIGNAL`           | wallet_relationships SHARED_DEVICE_SIGNAL        | none                                                    |
| `SHARED_NETWORK_SIGNAL`          | other users share active session `ip_hash`       | none                                                    |
| `NETWORK_COUNTRY_CHANGED`        | last 2 network_signals country codes differ      | none                                                    |
| `AD_REVERSED_REWARD_HISTORY`     | reversed AD rewards in window ≥ minCount         | `signal_params`: `{minCount, windowDays}` positive ints |
| `REFERRAL_REJECTED_EDGE_HISTORY` | rejected referral edges in window ≥ minCount     | `signal_params`: `{minCount, windowDays}` positive ints |

Any other `signal_weights` key (including harness `ACCOUNT_AGE` / `WALLET_REUSE`) **fails closed** on the collector path.

### 2.2 Risk — allowlisted actions (`RISK_ACTION_CODES`)

`ALLOW` | `EXTEND_PENDING` | `MANUAL_REVIEW` | `HELD` | `WITHDRAWAL_BLOCKED` | `REJECTED_PRE_BROADCAST` | `SUSPEND_EARNING` | `FREEZE_ACCOUNT`

**Execution note:** evaluateAndPersistRisk **never auto-bans** and does not mutate account status. Configured action is data for eligibility `riskAllowedActions` comparison and audit. Automatic FREEZE/SUSPEND is **not** performed by this path.

### 2.3 Trust — supported signals

`ACCOUNT_AGE` `{weight, minDays}` · `VERIFIED_PRIMARY_WALLET_AGE` `{weight, minDays}` · `REWARDED_AD_HISTORY` `{weight, minCount}` · `CONFIRMED_PAYOUT_HISTORY` `{weight, minCount}`

States: score `< basicMin` → **NEW**; `< establishedMin` → **BASIC**; `< trustedMin` → **ESTABLISHED**; else **TRUSTED**.

**Critical Closed Beta fact:** Eligibility evaluate-and-persist does **not** consult Trust state. Trust is observational / audit for Phase 20 unless a later Owner-approved product rule binds to it. New testers remaining `NEW` does **not** by itself block Earn/Withdraw eligibility.

### 2.4 Eligibility — action types

`AD_SESSION_START` | `WITHDRAWAL_REQUEST` | `MISSION_CLAIM` | `TASK_CLAIM` | `REFERRAL_ACTIVATION` | `MEMBERSHIP_CLAIM`

Step 4A proposes configuring the first four only (matches TEST fixture coverage). Do **not** add REFERRAL_ACTIVATION / MEMBERSHIP_CLAIM unless Owner separately requires them.

### 2.5 Eligibility — gates

| Gate             | Collector behavior (authoritative)                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ACCOUNT_STATE`  | ACTIVE user; fails if status≠ACTIVE, withdrawal_status=BLOCKED, or withdrawal cooldown active; RESTRICTED still eligible               |
| `RISK_POLICY`    | runs evaluateAndPersistRisk; eligible iff configuredAction ∈ `riskAllowedActions`                                                      |
| `FEATURE_FLAG`   | `MISSION_CLAIM` → `MISSION_REWARD_PAUSE`; **all other configured actions currently → `WITHDRAWAL_REQUESTS_PAUSE`** (source V1 binding) |
| `MEMBERSHIP`     | mission-required plan + EXCLUSIVE_MISSION_ACCESS entitlement                                                                           |
| `COUNTRY_POLICY` | not-required if mission countryGroup null; else fail-closed (no country collector)                                                     |
| `PROVIDER_LIMIT` | unimplemented → fail-closed if required                                                                                                |

---

## 3. TEST REFERENCE (disposable harness only)

Source: `packages/fraud/test/harness.ts`  
Label: **REFERENCE ONLY — NOT APPROVED FOR STAGING**

### Risk TEST REFERENCE

```
thresholds: { lowMax: 20, mediumMax: 50, highMax: 75 }
signal_weights: { ACCOUNT_AGE: 10, WALLET_REUSE: 15 }   # unit/fixture labels — NOT collector-supported
actions: { LOW: MANUAL_REVIEW, MEDIUM: MANUAL_REVIEW, HIGH: HELD, CRITICAL: WITHDRAWAL_BLOCKED }
```

**Warning:** Default harness weights cannot drive production evaluateAndPersistRisk. Phase 20 disposable DB proof uses collector-supported weights (e.g. `OPEN_HIGH_FRAUD_FLAG`) when exercising the live collector path.

### Trust TEST REFERENCE

```
signals:
  ACCOUNT_AGE: { weight: 25, minDays: 7 }
  VERIFIED_PRIMARY_WALLET_AGE: { weight: 25, minDays: 3 }
  REWARDED_AD_HISTORY: { weight: 25, minCount: 1 }
  CONFIRMED_PAYOUT_HISTORY: { weight: 25, minCount: 1 }
stateThresholds: { basicMin: 25, establishedMin: 50, trustedMin: 75 }
```

### Eligibility TEST REFERENCE

```
WITHDRAWAL_REQUEST:
  requiredGates: [ACCOUNT_STATE, RISK_POLICY, FEATURE_FLAG]
  precedence: [RISK_POLICY, ACCOUNT_STATE, FEATURE_FLAG]
  riskAllowedActions: [ALLOW, EXTEND_PENDING, MANUAL_REVIEW, HELD]
AD_SESSION_START / MISSION_CLAIM / TASK_CLAIM:
  requiredGates: [ACCOUNT_STATE, FEATURE_FLAG]
  precedence: [ACCOUNT_STATE, FEATURE_FLAG]
```

---

## 4. Owner decision matrix

Legend: **TEST REFERENCE** = harness only. **PROPOSED** = Closed-Beta candidate requiring Owner approval. Financial impact assumes AdsGram remains BLOCKED and payouts remain paused.

| Domain      | Field                                        | Supported values / constraints | TEST REFERENCE                           | Proposed Closed-Beta value                                          | Effect                                  | Too permissive risk              | Too strict risk                                   | Financial impact            | Security impact             | Rollback          | Owner approval required |
| ----------- | -------------------------------------------- | ------------------------------ | ---------------------------------------- | ------------------------------------------------------------------- | --------------------------------------- | -------------------------------- | ------------------------------------------------- | --------------------------- | --------------------------- | ----------------- | ----------------------- |
| Risk        | `thresholds.lowMax`                          | int 0–100; `< mediumMax`       | 20                                       | **PROPOSED 20**                                                     | score ≤20 → LOW                         | LOW band too wide → under-review | LOW too narrow → noise MANUAL_REVIEW              | Low while money BLOCKED     | Medium                      | SUPERSEDE rule    | YES                     |
| Risk        | `thresholds.mediumMax`                       | int; `< highMax`               | 50                                       | **PROPOSED 50**                                                     | ≤50 → MEDIUM                            | same                             | same                                              | Low                         | Medium                      | SUPERSEDE         | YES                     |
| Risk        | `thresholds.highMax`                         | int; `< 100 practical`         | 75                                       | **PROPOSED 75**                                                     | ≤75 → HIGH; else CRITICAL               | CRITICAL rare                    | CRITICAL frequent                                 | Low                         | High if CRITICAL mishandled | SUPERSEDE         | YES                     |
| Risk        | weight `OPEN_HIGH_FRAUD_FLAG`                | 0–100; collector               | (not in default TEST weights)            | **PROPOSED 40**                                                     | OPEN HIGH flag contributes 40           | under-weights known fraud        | over-holds clean users                            | Low                         | High                        | SUPERSEDE         | YES                     |
| Risk        | weight `OPEN_CRITICAL_FRAUD_FLAG`            | 0–100                          | n/a in default TEST                      | **PROPOSED 60**                                                     | OPEN CRITICAL contributes 60            | under-react                      | over-react                                        | Low                         | High                        | SUPERSEDE         | YES                     |
| Risk        | weight `CONFIRMED_FRAUD_FLAG`                | 0–100                          | n/a                                      | **PROPOSED 50**                                                     | confirmed flag contributes 50           | under-react                      | sticky holds                                      | Low                         | High                        | SUPERSEDE         | YES                     |
| Risk        | weight `SHARED_PAYOUT_WALLET`                | 0–100                          | n/a                                      | **PROPOSED 35**                                                     | shared verified primary wallet          | multi-account payout risk        | shared household false+                           | Medium if money on          | High                        | SUPERSEDE         | YES                     |
| Risk        | weight `SHARED_NETWORK_SIGNAL`               | 0–100                          | n/a                                      | **PROPOSED 20**                                                     | shared live session ip_hash             | botnet under-detect              | café/VPN false+                                   | Low                         | Medium                      | SUPERSEDE         | YES                     |
| Risk        | weight `SHARED_DEVICE_SIGNAL`                | 0–100                          | n/a                                      | **PROPOSED 25**                                                     | shared-device relationship rows         | under-detect                     | relationship noise                                | Low                         | Medium                      | SUPERSEDE         | YES                     |
| Risk        | weight `NETWORK_COUNTRY_CHANGED`             | 0–100                          | n/a                                      | **PROPOSED 15**                                                     | last-2 country change                   | travel ignored                   | travelers held                                    | Low                         | Low–Med                     | SUPERSEDE         | YES                     |
| Risk        | `AD_REVERSED_REWARD_HISTORY`                 | weight + params                | unset                                    | **PROPOSED omit for Step 4A**                                       | n/a until Owner wants history           | miss reverse abuse               | block after provider reverses                     | Low while BLOCKED           | Medium later                | add later version | YES to add              |
| Risk        | `REFERRAL_REJECTED_EDGE_HISTORY`             | weight + params                | unset                                    | **PROPOSED omit for Step 4A**                                       | n/a                                     | miss referral abuse              | punish bad edges early                            | Low                         | Medium later                | add later         | YES to add              |
| Risk        | harness `ACCOUNT_AGE` / `WALLET_REUSE`       | **not collector-supported**    | 10 / 15                                  | **DO NOT ACTIVATE**                                                 | would fail collector                    | n/a                              | n/a                                               | n/a                         | n/a                         | n/a               | N/A (invalid live)      |
| Risk        | `actions.LOW`                                | allowlisted action             | MANUAL_REVIEW                            | **PROPOSED MANUAL_REVIEW**                                          | low score → review label                | silent ALLOW                     | over-review                                       | None (no auto-pay)          | Low                         | SUPERSEDE         | YES                     |
| Risk        | `actions.MEDIUM`                             | allowlisted                    | MANUAL_REVIEW                            | **PROPOSED MANUAL_REVIEW**                                          | medium → review                         | silent ALLOW                     | over-review                                       | None                        | Med                         | SUPERSEDE         | YES                     |
| Risk        | `actions.HIGH`                               | allowlisted                    | HELD                                     | **PROPOSED HELD**                                                   | high → HELD label                       | under-hold                       | over-hold Earn/Withdraw via allowlist             | Low                         | High                        | SUPERSEDE         | YES                     |
| Risk        | `actions.CRITICAL`                           | allowlisted                    | WITHDRAWAL_BLOCKED                       | **PROPOSED WITHDRAWAL_BLOCKED**                                     | critical → withdrawal-blocked label     | under-block                      | over-block                                        | Low (pause already on)      | High                        | SUPERSEDE         | YES                     |
| Trust       | `ACCOUNT_AGE.minDays`                        | positive int                   | 7                                        | **PROPOSED 1**                                                      | age≥1 day satisfies                     | brand-new same-day miss          | 7d blocks new beta UX if later gated              | None today                  | Low                         | SUPERSEDE         | YES                     |
| Trust       | `ACCOUNT_AGE.weight`                         | 0–100                          | 25                                       | **PROPOSED 40**                                                     | larger NEW→BASIC step for aged accounts | inflate trust                    | slow growth                                       | None                        | Low                         | SUPERSEDE         | YES                     |
| Trust       | `VERIFIED_PRIMARY_WALLET_AGE.minDays`        | positive int                   | 3                                        | **PROPOSED 1**                                                      | wallet age≥1 day                        | same-day wallet                  | 3d harsh for testers                              | None                        | Low                         | SUPERSEDE         | YES                     |
| Trust       | `VERIFIED_PRIMARY_WALLET_AGE.weight`         | 0–100                          | 25                                       | **PROPOSED 40**                                                     | wallet maturity weight                  | inflate                          | slow                                              | None                        | Low                         | SUPERSEDE         | YES                     |
| Trust       | `REWARDED_AD_HISTORY`                        | weight/minCount                | 25 / 1                                   | **PROPOSED keep 25 / 1**                                            | needs ≥1 AVAILABLE AD reward            | easy inflate after first reward  | unreachable while AdsGram money BLOCKED (often 0) | None                        | Low                         | SUPERSEDE         | YES                     |
| Trust       | `CONFIRMED_PAYOUT_HISTORY`                   | weight/minCount                | 25 / 1                                   | **PROPOSED keep 25 / 1**                                            | needs ≥1 CONFIRMED withdrawal           | inflate after payout             | unreachable while payouts frozen                  | None                        | Low                         | SUPERSEDE         | YES                     |
| Trust       | `basicMin` / `establishedMin` / `trustedMin` | 0–100 ordered                  | 25 / 50 / 75                             | **PROPOSED 25 / 50 / 75**                                           | state bands                             | easy TRUSTED                     | stuck NEW/BASIC                                   | None (not eligibility gate) | Low                         | SUPERSEDE         | YES                     |
| Eligibility | `WITHDRAWAL_REQUEST.requiredGates`           | gate allowlist                 | ACCOUNT_STATE, RISK_POLICY, FEATURE_FLAG | **PROPOSED same**                                                   | pause + risk + account must pass        | skip risk/pause                  | over-block (intended while frozen)                | High if later unpaused      | High                        | SUPERSEDE policy  | YES                     |
| Eligibility | `WITHDRAWAL_REQUEST.precedence`              | permutation of required        | RISK, ACCOUNT, FLAG                      | **PROPOSED same**                                                   | primary blocked reason order            | wrong audit reason               | same                                              | Low                         | Med                         | SUPERSEDE         | YES                     |
| Eligibility | `WITHDRAWAL_REQUEST.riskAllowedActions`      | subset of risk actions         | includes HELD                            | **PROPOSED ALLOW, EXTEND_PENDING, MANUAL_REVIEW** (exclude HELD)    | HELD cannot request withdraw            | HELD can withdraw (TEST)         | over-block withdraw                               | High if money on            | High                        | SUPERSEDE         | YES                     |
| Eligibility | `AD_SESSION_START.requiredGates`             | gate allowlist                 | ACCOUNT_STATE, FEATURE_FLAG              | **PROPOSED ACCOUNT_STATE, RISK_POLICY** (no FEATURE_FLAG)           | see §5.1 FEATURE_FLAG binding           | no risk on ads                   | over-block ads                                    | Low while BLOCKED           | Med                         | SUPERSEDE         | YES                     |
| Eligibility | `AD_SESSION_START.riskAllowedActions`        | required with RISK             | n/a in TEST                              | **PROPOSED ALLOW, EXTEND_PENDING, MANUAL_REVIEW**                   | HELD/CRITICAL labels block ad start     | HELD watches ads                 | false+ block Earn                                 | Low while BLOCKED           | Med                         | SUPERSEDE         | YES                     |
| Eligibility | `MISSION_CLAIM` / `TASK_CLAIM`               | gates                          | ACCOUNT_STATE, FEATURE_FLAG              | **PROPOSED keep TEST shape** but **do not activate missions in 4A** | ready for later content step            | skip account/pause               | block claims                                      | Med when content live       | Med                         | SUPERSEDE         | YES                     |
| Eligibility | `REFERRAL_ACTIVATION` / `MEMBERSHIP_CLAIM`   | optional actions               | unset                                    | **PROPOSED omit**                                                   | fail-closed if called without config    | accidental open                  | intentional omit                                  | Low                         | Low                         | add later         | YES to add              |

---

## 5. Proposed conservative Closed-Beta profiles

All values below are **PROPOSED — requires Owner approval**. Not approved. Not activated.

### 5.1 Risk — PROPOSED BETA PROFILE

```json
{
  "thresholds": { "lowMax": 20, "mediumMax": 50, "highMax": 75 },
  "signal_weights": {
    "OPEN_HIGH_FRAUD_FLAG": 40,
    "OPEN_CRITICAL_FRAUD_FLAG": 60,
    "CONFIRMED_FRAUD_FLAG": 50,
    "SHARED_PAYOUT_WALLET": 35,
    "SHARED_DEVICE_SIGNAL": 25,
    "SHARED_NETWORK_SIGNAL": 20,
    "NETWORK_COUNTRY_CHANGED": 15
  },
  "signal_params": {},
  "actions": {
    "LOW": "MANUAL_REVIEW",
    "MEDIUM": "MANUAL_REVIEW",
    "HIGH": "HELD",
    "CRITICAL": "WITHDRAWAL_BLOCKED"
  }
}
```

**Effect:** Prefer hold/review labels over silent ALLOW. No auto-ban execution. Collector-compatible only.  
**Money authority change:** NO.

### 5.2 Trust — PROPOSED BETA PROFILE

```json
{
  "signals": {
    "ACCOUNT_AGE": { "weight": 40, "minDays": 1 },
    "VERIFIED_PRIMARY_WALLET_AGE": { "weight": 40, "minDays": 1 },
    "REWARDED_AD_HISTORY": { "weight": 25, "minCount": 1 },
    "CONFIRMED_PAYOUT_HISTORY": { "weight": 25, "minCount": 1 }
  },
  "stateThresholds": { "basicMin": 25, "establishedMin": 50, "trustedMin": 75 }
}
```

**Why minDays=1 (not TEST 7/3):** Closed Beta testers are often brand-new; Trust is not an eligibility gate today, but Owner-readable states should still progress when a verified wallet appears. History signals remain hard while AdsGram money BLOCKED and payouts frozen — expected.

**Money authority change:** NO.

### 5.3 Eligibility — PROPOSED BETA PROFILE

```json
{
  "actions": {
    "WITHDRAWAL_REQUEST": {
      "requiredGates": ["ACCOUNT_STATE", "RISK_POLICY", "FEATURE_FLAG"],
      "precedence": ["RISK_POLICY", "ACCOUNT_STATE", "FEATURE_FLAG"],
      "riskAllowedActions": ["ALLOW", "EXTEND_PENDING", "MANUAL_REVIEW"]
    },
    "AD_SESSION_START": {
      "requiredGates": ["ACCOUNT_STATE", "RISK_POLICY"],
      "precedence": ["RISK_POLICY", "ACCOUNT_STATE"],
      "riskAllowedActions": ["ALLOW", "EXTEND_PENDING", "MANUAL_REVIEW"]
    },
    "MISSION_CLAIM": {
      "requiredGates": ["ACCOUNT_STATE", "FEATURE_FLAG"],
      "precedence": ["ACCOUNT_STATE", "FEATURE_FLAG"]
    },
    "TASK_CLAIM": {
      "requiredGates": ["ACCOUNT_STATE", "FEATURE_FLAG"],
      "precedence": ["ACCOUNT_STATE", "FEATURE_FLAG"]
    }
  }
}
```

#### 5.3.1 FEATURE_FLAG binding caveat (must read)

For non-`MISSION_CLAIM` actions, source currently evaluates `WITHDRAWAL_REQUESTS_PAUSE`. If that pause flag is **enabled** (expected under payout freeze), requiring `FEATURE_FLAG` on `AD_SESSION_START` would make **every ad session ineligible** even though AdsGram observation is desired while money is BLOCKED.

Therefore PROPOSED `AD_SESSION_START` **omits FEATURE_FLAG** and uses ACCOUNT_STATE + RISK_POLICY instead. This does **not** enable monetary issuance; AdsGram production monetary remains BLOCKED by provider gates.

#### 5.3.2 Withdrawal safety

Proposed withdrawal eligibility still requires FEATURE_FLAG (`WITHDRAWAL_REQUESTS_PAUSE`). With pause enabled, withdrawals stay ineligible. Proposal does **not**:

- auto-approve withdrawals
- bypass manual review / pause / wallet ownership / cooldown / ledger reservation / signer / reconciliation  
  Those controls live outside eligibility policy config and remain frozen by Phase 20 authority freeze.

**Money authority change:** NO.

---

## 6. New-user / scenario behavior (illustrative — no real users)

Assumes PROPOSED profiles; Trust not used as eligibility gate.

| Scenario                                                    | Risk (typical)                                                | Trust state                                                                                                              | Eligibility AD_SESSION_START                                        | Eligibility WITHDRAWAL_REQUEST                        |
| ----------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------- |
| Brand-new account + new wallet, no flags                    | score 0 → LOW → MANUAL_REVIEW → allowed by riskAllowedActions | score 0 → **NEW** (or BASIC if age/wallet ≥1 day and both satisfy → 80 → TRUSTED only if both age signals met: 40+40=80) | ELIGIBLE if ACTIVE account                                          | INELIGIBLE if pause enabled (FEATURE_FLAG) — expected |
| Established account + verified primary wallet ≥1d, no fraud | LOW / MANUAL_REVIEW                                           | often BASIC or higher from age+wallet; ad/payout history still unmet while frozen                                        | ELIGIBLE                                                            | blocked by pause / risk if elevated                   |
| Shared payout wallet signal active (+35)                    | likely MEDIUM or HIGH depending on stack                      | unchanged by risk                                                                                                        | may become INELIGIBLE_RISK_POLICY if action HELD/WITHDRAWAL_BLOCKED | blocked                                               |
| OPEN CRITICAL fraud flag (+60)                              | HIGH or CRITICAL                                              | n/a                                                                                                                      | blocked if action not in allowlist                                  | blocked                                               |
| Account withdrawal_status BLOCKED                           | n/a for risk                                                  | n/a                                                                                                                      | INELIGIBLE_ACCOUNT_STATE                                            | INELIGIBLE_ACCOUNT_STATE                              |

**Brand-new tester usability:** Earn observation remains usable under PROPOSED AD_SESSION_START (no FEATURE_FLAG pause coupling). Trust NEW is expected and **non-blocking**. Withdrawals remain frozen.

---

## 7. Ads / missions notes

- AdsGram monetary stays **BLOCKED**; eligibility may allow session **start** only.
- Client completion remains evidence-only; not monetary authority.
- Mission/task policies must not accept client reward amounts (existing engine authority).
- Step 4A does **not** activate missions/referrals (`P20-GAP-017` separate).

---

## 8. Rollback mechanism (when a later activation step exists)

1. Append-only: insert SUPERSEDED/REVOKED transitions; do not silently edit ACTIVE JSON in place.
2. Prefer fail-closed (no ACTIVE) over permissive emergency open.
3. Never invent temporary ALLOW-everything policies to unblock demos.
4. Payout pause / AdsGram BLOCKED / Mainnet OFF remain independent kill switches.

---

## 9. OWNER DECISIONS REQUIRED

Fill each line with `APPROVE_AS_PROPOSED` | `APPROVE_WITH_EDITS:<note>` | `REJECT:<note>` | `DEFER`.

```
OWNER_DECISION_01_RISK_THRESHOLDS=
  recommended: lowMax=20, mediumMax=50, highMax=75
  effect: band risk scores into LOW/MEDIUM/HIGH/CRITICAL
  risk: too-wide LOW under-reviews; too-narrow over-holds

OWNER_DECISION_02_RISK_WEIGHTS=
  recommended: collector set in §5.1 (omit ACCOUNT_AGE/WALLET_REUSE; omit history signals for 4A)
  effect: score only from implemented fraud/reuse/network collectors
  risk: omitting shared-wallet under-detects multi-account; heavy network weight false-positives NAT users

OWNER_DECISION_03_RISK_ACTIONS=
  recommended: LOW/MEDIUM=MANUAL_REVIEW; HIGH=HELD; CRITICAL=WITHDRAWAL_BLOCKED
  effect: labels for eligibility allowlists; no auto-ban execution
  risk: ALLOW on LOW would weaken review posture

OWNER_DECISION_04_TRUST_SIGNALS=
  recommended: §5.2 (minDays=1 for age/wallet; keep history minCount=1)
  effect: observational trust progression for new testers without gating Earn
  risk: TEST minDays=7/3 leaves almost all beta users NEW forever (harmless today; confusing ops)

OWNER_DECISION_05_TRUST_THRESHOLDS=
  recommended: basicMin=25, establishedMin=50, trustedMin=75
  effect: map score → NEW/BASIC/ESTABLISHED/TRUSTED
  risk: lowering trustedMin invents easy TRUSTED optics

OWNER_DECISION_06_WITHDRAWAL_ELIGIBILITY=
  recommended: ACCOUNT_STATE+RISK_POLICY+FEATURE_FLAG; riskAllowedActions without HELD
  effect: withdrawals stay pause-gated; HELD cannot request withdraw
  risk: including HELD (TEST) would allow held users to request withdraw when pause later lifts

OWNER_DECISION_07_AD_SESSION_ELIGIBILITY=
  recommended: ACCOUNT_STATE+RISK_POLICY; omit FEATURE_FLAG (pause binding caveat)
  effect: allow controlled Earn observation while payouts paused; risk can still block
  risk: requiring FEATURE_FLAG today couples ads to WITHDRAWAL_REQUESTS_PAUSE and blocks observation

OWNER_DECISION_08_MISSION_TASK_ELIGIBILITY=
  recommended: keep TEST ACCOUNT_STATE+FEATURE_FLAG shapes; do not activate content in 4A
  effect: policy ready for later P20-GAP-017 content step
  risk: activating without content/policy ceremony creates empty or unsafe claim paths
```

---

## 10. Explicit non-claims

- Notification delivery unchanged (`DRAFT_ONLY_NO_SEND`).
- No LIVE_POLICY_CHANGED. No operational/staging ACTIVE seed in Step 4A.
- No Railway deploy. No Mainnet. No AdsGram monetary enablement. No payout resume.
- Step 4 activation is **NOT STARTED**.

---

## 11. Evidence pointers

- `packages/fraud/src/risk-rule.ts`, `risk-evaluator.ts`, `risk-signal-collector.ts`, `evaluate-and-persist.ts`
- `packages/fraud/src/trust-rule.ts`, `trust-evaluator.ts`, `trust-signal-collector.ts`
- `packages/fraud/src/eligibility-policy.ts`, `eligibility-evaluator.ts`, `evaluate-and-persist-eligibility.ts`
- `packages/fraud/test/harness.ts` (TEST REFERENCE only)
- `docs/PHASE_20_GAP_REGISTER.md` → P20-GAP-009
