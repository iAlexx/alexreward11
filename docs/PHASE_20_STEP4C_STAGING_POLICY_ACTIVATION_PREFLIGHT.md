# Phase 20 Step 4C — Staging Policy Activation Pre-Flight

**PHASE20_GATE:** HOLD  
**Step:** 4C PRE-FLIGHT ONLY — no activation executed  
**Branch:** `phase20-closed-beta`  
**Source commit at preflight:** `f870842e88cbf5ca62b1cfd6a6e3a5458b6a6d54`  
**Canonical artifact:** `packages/fraud/policy/phase20-closed-beta-owner-approved.json`  
**activationAuthorized (artifact):** `false` (unchanged — activation remains external Owner authorization)  
**Machine snapshot:** `docs/phase20-step4c-preflight-snapshot.json`

---

## Explicit non-authorizations (this step)

This document and its tooling do **not** authorize or perform:

- staging / operational policy INSERT/UPDATE/DELETE
- Railway deploy or Railway variable changes
- live ACTIVE activation
- feature-flag mutation
- AdsGram production monetary enablement
- production monetary enablement
- payout resume / pause changes / auto-unpause / auto-resend
- signer operations / TON broadcast / Mainnet
- mission or referral content activation
- Phase 21

**Owner authorization is still required** before any future Step 4C execution ceremony.

---

## 1. Read-only staging discovery method

| Item | Value |
| ---- | ----- |
| Railway project | `ideal-perception` |
| Railway environment name | `production` (Railway label; app services are `*-staging`) |
| Postgres service used | `Postgres` (operational staging DB) |
| Explicitly not used | `Postgres-phase18-restore-*` restore sibling |
| Access | `railway connect Postgres --tunnel-only` + local client |
| Session safety | `application_name=phase20-step4c-preflight-ro` |
| | `options=-c default_transaction_read_only=on` |
| | `BEGIN READ ONLY` for discovery |
| Mutation probe | `CREATE TEMP TABLE` refused (`MUTATION_REFUSED=true`) |
| Writes performed | **NONE** |

Credentials were never written into this repository. Do not commit tunnel passwords.

---

## 2. Approved policy digests (SHA-256 of canonical JSON objects)

Computed from `packages/fraud/policy/phase20-closed-beta-owner-approved.json` via `JSON.stringify` (Node):

| Domain | Digest |
| ------ | ------ |
| Risk (`thresholds` + `signalWeights` + `signalParams` + `actions`) | `c81bf1edeb82b2e3bf8da45ef9a4b409f1557412da4b87d78d8f322e0045ebb5` |
| Trust (`trust` object) | `8b0d26cc3d3df43595ade3e63f70abc4a460dcb93a2bcf7afc1dd98d58ee5ba1` |
| Eligibility (`eligibility` object) | `69c714db79b687d85f199cf812d485bc243d6ef53e69c64bf05f830b392aac28` |
| Full artifact | `8f8e4cba511900d7320ca8d80205389648d81a7778ce3b86a0add790bc039eeb` |

Approved values are **not** altered by this step.

---

## 3. Staging current-state summary

Observed at `2026-10-01T23:45:28.357Z` (DB `now()`), database name `railway`.

### 3.1 Risk — `risk_rule_versions`

| Metric | Value |
| ------ | ----- |
| total rows | **0** |
| ACTIVE rows | **0** |
| resolver matches at `now()` | **0** |
| highest `rule_version` | **0** (none) |
| CURRENT_ACTIVE_VERSION | *(none)* |
| HIGHEST_EXISTING_VERSION | `0` |
| PROPOSED_NEXT_VERSION | **`1`** |

**Conflict:** none (zero ACTIVE).

### 3.2 Trust — `trust_rule_versions`

| Metric | Value |
| ------ | ----- |
| total rows | **0** |
| ACTIVE rows | **0** |
| resolver matches at `now()` | **0** |
| highest `rule_version` | **0** |
| CURRENT_ACTIVE_VERSION | *(none)* |
| HIGHEST_EXISTING_VERSION | `0` |
| PROPOSED_NEXT_VERSION | **`1`** |

**Conflict:** none.

### 3.3 Eligibility — `eligibility_policy_versions`

| Metric | Value |
| ------ | ----- |
| total rows | **0** |
| ACTIVE rows | **0** |
| resolver matches at `now()` | **0** |
| highest `policy_version` | **0** |
| CURRENT_ACTIVE_VERSION | *(none)* |
| HIGHEST_EXISTING_VERSION | `0` |
| PROPOSED_NEXT_VERSION | **`1`** |

**Conflict:** none.

### 3.4 Integrity verdict

```text
RISK_ACTIVE_COUNT=0
TRUST_ACTIVE_COUNT=0
ELIGIBILITY_ACTIVE_COUNT=0
ACTIVE_POLICY_CONFLICTS=NO
ACTIVATION_PREFLIGHT=READY_FOR_OWNER_AUTHORIZATION
```

GiST exclusion constraints (`EXCLUDE USING gist ... WHERE status='ACTIVE'`) are irrelevant until the first ACTIVE insert; with empty tables there is no overlapping ACTIVE window risk.

Authoritative resolvers currently fail-closed (`*_NOT_CONFIGURED`) until ACTIVE rows exist — expected.

---

## 4. Independent kill switches (must remain unchanged by activation)

Observed (read-only):

| Control | Staging observation | Activation may change? |
| ------- | ------------------- | ---------------------- |
| AdsGram `production_monetary_status` | **BLOCKED** (`lifecycle_state=SANDBOX`) | **NO** |
| `PAYOUT_DISPATCH_PAUSE` / STAGING | **enabled=true** | **NO** |
| `REFERRAL_REWARD_PAUSE` / STAGING | **enabled=true** | **NO** |
| `WITHDRAWAL_REQUESTS_PAUSE` / STAGING | **ROW MISSING** | **NO** (do not auto-create in policy activation) |
| `WITHDRAWAL_REQUESTS_PAUSE` / LOCAL | enabled=false | N/A |
| Signer / TON / Mainnet | out of scope; not touched | **NO** |
| Mission/referral content | not touched | **NO** |

**Important dependency (not a policy conflict):**  
Evaluating `WITHDRAWAL_REQUEST` eligibility on STAGING requires a `feature_flags` row for `WITHDRAWAL_REQUESTS_PAUSE` + environment `STAGING`. Missing row → `ELIGIBILITY_GATE_SOURCE_UNAVAILABLE` (fail-closed). That is **separate** from Risk/Trust/Eligibility policy activation and must not be silently invented by the activation ceremony. Prefer a later explicit Owner-gated flag seed if withdrawal eligibility validation on STAGING is required.

---

## 5. Exact mutation ceremony (DO NOT EXECUTE)

### 5.1 Semantics

Append-only versioned activation:

1. **No SUPERSEDE required** (zero ACTIVE / zero history).
2. In **one** database transaction:
   - concurrency guards (below);
   - `INSERT` Risk ACTIVE `rule_version=1`;
   - `INSERT` Trust ACTIVE `rule_version=1` with `policy_config`;
   - `INSERT` Eligibility ACTIVE `policy_version=1` with `policy_config`;
   - assert exactly one resolver match per domain at `now()`;
   - `COMMIT` only if all assertions pass; else `ROLLBACK`.
3. Do **not** UPDATE historical config JSON (none exists).
4. Do **not** modify feature flags, AdsGram, payout pause, signer, or content tables.

### 5.2 Proposed row payloads (logical)

Shared metadata (suggested — final wording Owner-approved at execution):

- `status`: `ACTIVE`
- `effective_from`: server `now()` (or Owner-chosen future instant)
- `effective_to`: `NULL` (open-ended)
- `reason`: e.g. `PHASE20_STEP4C_OWNER_APPROVED_CLOSED_BETA`
- `audit_reference`: e.g. `docs/PHASE_20_STEP4_OWNER_POLICY_APPROVAL.md@f870842` + execution commit

**Risk insert columns:**  
`rule_version=1`, `thresholds`, `signal_weights`, `signal_params`, `actions` from approved artifact Risk section  
Expected config digest after insert: `c81bf1ed…ebb5`

**Trust insert columns:**  
`rule_version=1`, `policy_config` = approved `trust` object  
Expected digest: `8b0d26cc…e5ba1`

**Eligibility insert columns:**  
`policy_version=1`, `policy_config` = approved `eligibility` object  
Expected digest: `69c714db…aac28`

### 5.3 Concurrency / optimistic guards (mandatory at execution)

Before inserts, inside the same TX (with appropriate locks, e.g. `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE` or `SELECT … FOR UPDATE` on sentinel if introduced):

```text
ASSERT count(*) FROM risk_rule_versions = 0
ASSERT count(*) FILTER (ACTIVE now-window) = 0  -- risk/trust/eligibility
ASSERT max(rule_version) IS NULL OR max=0
ASSERT proposed versions still free (no row with version 1)
```

After inserts:

```text
ASSERT exactly 1 ACTIVE now-window row per domain
ASSERT inserted digests match approved digests
ASSERT no feature_flags / ad_providers / payout rows changed in TX
```

On any mismatch → `ROLLBACK` (Rollback class A).

### 5.4 Expected effect after successful future activation

- Resolvers return ACTIVE v1 for Risk / Trust / Eligibility.
- AD_SESSION_START can evaluate under ACCOUNT_STATE + RISK_POLICY.
- HIGH/CRITICAL risk labels can block AD / WITHDRAWAL eligibility per approved allowlists.
- Trust remains observational (not an eligibility gate).
- Withdrawals remain blocked by `PAYOUT_DISPATCH_PAUSE` STAGING=true and missing/paused withdrawal request flag semantics — **no auto-approve payout**.
- AdsGram monetary remains BLOCKED.
- Founder membership still cannot bypass risk/eligibility/cooldown/account controls.

---

## 6. Rollback plan

### A. Transaction failure before commit

Full `ROLLBACK`. Staging remains with zero policy rows. No activation.

### B. Post-activation behavioral failure (after COMMIT)

Use versioned history — **do not rewrite** immutable config on the activated row:

1. Prefer fail-closed: set the bad ACTIVE row to `SUPERSEDED` or `REVOKED` with `effective_to=now()` (status lifecycle only), leaving config JSON intact as evidence.
2. Optionally insert a later corrective ACTIVE version (Owner-approved) if a safe replacement exists.
3. Never invent ALLOW-everything emergency policies.
4. Independent kill switches (payout pause, AdsGram BLOCKED, Mainnet OFF) remain authoritative monetary brakes.

---

## 7. Post-activation validation plan (later authorized execution only)

Disposable/controlled STAGING testers only. No production money. No TON broadcast. No signer ops.

### Risk

- Ordinary ACTIVE tester → score 0 / LOW / MANUAL_REVIEW; `neverAutoBan=true`
- Controlled OPEN HIGH fraud flag → 55 / HIGH / HELD; no account auto-ban
- Controlled OPEN CRITICAL → 80 / CRITICAL / WITHDRAWAL_BLOCKED; no account auto-ban

### Trust

- Brand-new → NEW (0)
- Age ≥1d → BASIC (25); age+wallet → ESTABLISHED (50); +rewarded AD → TRUSTED (75)
- Trust state must not bypass eligibility / pause / wallet / ledger / signer

### Eligibility

- Ordinary AD_SESSION_START → ELIGIBLE (ACTIVE + LOW risk)
- HIGH / CRITICAL → INELIGIBLE_RISK_POLICY for AD
- Withdrawal cooldown blocks WITHDRAWAL_REQUEST only (AD still eligible)
- WITHDRAWAL_REQUEST remains non-payable: pause / missing STAGING request-pause row / payout dispatch pause / engine freeze
- LOW risk ELIGIBLE ≠ payout APPROVED
- Founder: no risk/eligibility bypass

### Money safety assertions

- AdsGram still BLOCKED
- No real AdsGram reward credit
- No withdrawal broadcast / signer call / Mainnet

---

## 8. Future execution gate (not this step)

A later Step 4C **execution** requires **explicit Owner authorization** after independent review of this preflight.

Suggested future command shape (not implemented as executable activation here):

- Default: read-only / dry-run only
- Mutation mode: only with an explicit future env such as `PHASE20_STEP4C_ACTIVATE=1` **plus** Owner token/reason — out of scope for Step 4C preflight

This repository step ships read-only preflight tooling only.

---

## 9. Gap status (unchanged)

- `P20-GAP-009` = `OPEN / OWNER_APPROVED / READY_FOR_STAGING_ACTIVATION` (still blocks Closed Beta)
- `P20-GAP-017` = `OPEN / READY_FOR_OWNER_CONTENT_APPROVAL`
- Closed Beta blockers = 2; real-money = 8; archive = 2

---

## 10. Owner decision required to proceed

Owner must explicitly authorize a **separate** Step 4C execution after reviewing:

1. this preflight;
2. proposed versions = **1 / 1 / 1**;
3. empty-table activation ceremony;
4. kill-switch non-touch list;
5. WITHDRAWAL_REQUESTS_PAUSE STAGING missing-row dependency.

Until then: **STOP — DO NOT EXECUTE STAGING POLICY ACTIVATION.**