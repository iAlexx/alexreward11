# Phase 20 Step 4C / 4C.1 / 4C.2 — Staging Policy Activation Pre-Flight

**PHASE20_GATE:** HOLD  
**Step:** 4C.2 — seal reproducible preflight evidence (two-commit ceremony; no activation)  
**Branch:** `phase20-closed-beta`  
**Canonical artifact:** `packages/fraud/policy/phase20-closed-beta-owner-approved.json`  
**activationAuthorized (artifact):** `false` (unchanged)  
**Machine snapshot:** `docs/phase20-step4c-preflight-snapshot.json`  
**Reproducible command:** `pnpm phase20:step4c:preflight` (requires `PHASE20_STAGING_PREFLIGHT_DATABASE_URL`)

### Commit semantics (intentional, non-circular)

| Role                                                      | Meaning                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tooling/source commit (`sourceCommit` / TOOLING_HEAD)** | Exact clean tracked commit whose preflight tooling performed the read-only discovery. Recorded **inside** the snapshot.                                             |
| **Evidence commit (EVIDENCE_HEAD)**                       | Later commit that stores the regenerated snapshot/docs. **Not** embedded as `sourceCommit` (would be circular). Filled in return output / DECISIONS after Commit B. |

**Tooling/source commit used for fresh discovery:** _(filled after Commit A — TOOLING_HEAD)_  
**Evidence commit storing snapshot/docs:** _(filled after Commit B — EVIDENCE_HEAD; not equal to sourceCommit)_

## Explicit non-authorizations

This document / tooling does **not** authorize or perform:

- staging policy INSERT/UPDATE/DELETE
- `WITHDRAWAL_REQUESTS_PAUSE` STAGING seed (planned only)
- any other feature-flag mutation
- Railway deploy / Railway variable changes
- AdsGram monetary enablement / production monetary enablement
- payout resume / pause changes / auto-unpause / auto-resend
- signer / TON broadcast / Mainnet
- mission or referral content activation
- Phase 21

External Owner authorization governs any future execution.

---

## 1. Tooling reproducibility (Step 4C.1 fix)

## 1a. Step 4C.2 evidence hygiene

- Snapshot `pathResolution` must be **repository-relative only** (`packages/fraud`, `.`, `docs/...`).
- Absolute Windows/home/desktop paths must never be committed.
- Live preflight refuses dirty tracked source (`git diff --quiet` + `git diff --cached --quiet`) before discovery.
- Unrelated untracked files are ignored and must not be deleted.
- Two-commit ceremony: Commit A = tooling seal; Commit B = evidence only; `sourceCommit` always = TOOLING_HEAD.

## 1b. Tooling reproducibility (Step 4C.1 fix)

### Bug

`packages/fraud/scripts/phase20-step4c-staging-preflight.mjs` previously treated
`packages/fraud` as repo root, resolving:

- artifact → `packages/fraud/packages/fraud/policy/...` (wrong)
- snapshot → `packages/fraud/docs/...` (wrong)

### Fix

Shared resolver: `packages/fraud/scripts/phase20-step4c-paths.mjs`

```text
fraudPackageRoot = <dir of scripts>/..
repoRoot         = fraudPackageRoot/../..
artifactPath     = fraudPackageRoot/policy/phase20-closed-beta-owner-approved.json
snapshotPath     = repoRoot/docs/phase20-step4c-preflight-snapshot.json
git cwd          = repoRoot
```

Root wrapper `scripts/phase20-step4c-staging-preflight.mjs` continues to invoke the package script.
Activation env `PHASE20_STEP4C_ACTIVATE=1` remains explicitly refused (exit 2).

Proof: `packages/fraud/test/phase20-step4c-preflight-paths.unit.test.ts`

---

## 2. Read-only discovery method (fresh)

| Item             | Value                                                 |
| ---------------- | ----------------------------------------------------- |
| Postgres service | `Postgres` (operational staging; not restore sibling) |
| Railway env name | `production` (services are `*-staging`)               |
| Access           | `railway connect Postgres --tunnel-only` + local URL  |
| Session          | `application_name=phase20-step4c-preflight-ro`        |
|                  | `default_transaction_read_only=on`                    |
|                  | `BEGIN READ ONLY`                                     |
| Mutation probe   | refused (`mutationRefused=true`)                      |
| Writes           | **NONE**                                              |

Credentials are never committed.

---

## 3. Fresh staging policy state

| Domain                                      | total | ACTIVE (now-window) | highest version | proposed next |
| ------------------------------------------- | ----: | ------------------: | --------------: | ------------: |
| Risk (`risk_rule_versions`)                 | **0** |               **0** |           **0** |         **1** |
| Trust (`trust_rule_versions`)               | **0** |               **0** |           **0** |         **1** |
| Eligibility (`eligibility_policy_versions`) | **0** |               **0** |           **0** |         **1** |

```text
ACTIVE_POLICY_CONFLICTS=NO
ACTIVATION_PREFLIGHT=READY_FOR_OWNER_AUTHORIZATION
```

Compared to prior Step 4C snapshot: policy row counts / proposed versions **unchanged** (still empty → v1/v1/v1). Not `BLOCKED_FOR_REVIEW`.

Approved digests unchanged (artifact values not modified):

| Domain        | Digest                                                             |
| ------------- | ------------------------------------------------------------------ |
| Risk          | `c81bf1edeb82b2e3bf8da45ef9a4b409f1557412da4b87d78d8f322e0045ebb5` |
| Trust         | `8b0d26cc3d3df43595ade3e63f70abc4a460dcb93a2bcf7afc1dd98d58ee5ba1` |
| Eligibility   | `69c714db79b687d85f199cf812d485bc243d6ef53e69c64bf05f830b392aac28` |
| Full artifact | `8f8e4cba511900d7320ca8d80205389648d81a7778ce3b86a0add790bc039eeb` |

---

## 4. Owner decision item — `WITHDRAWAL_REQUESTS_PAUSE` / STAGING

### Observed

```text
WITHDRAWAL_REQUESTS_PAUSE / STAGING = MISSING
feature_flag_versions history for that pair = 0
```

This flag is **not** part of the Owner-approved Risk/Trust/Eligibility JSON and must **not** be invented inside the policy-row INSERT ceremony without explicit Owner decision.

### Why it matters (engine mismatch — do not change engines here)

| Engine                                                                                               | Missing-row semantics                                                 |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Withdrawal Engine `assertWithdrawalRequestsAllowed()` (`packages/withdrawals/src/flags.ts`)          | Missing row ⇒ **not paused** (only `enabled===true` throws)           |
| Eligibility Engine FEATURE_FLAG collector (`packages/fraud/src/evaluate-and-persist-eligibility.ts`) | Missing row ⇒ **`ELIGIBILITY_GATE_SOURCE_UNAVAILABLE`** (fail-closed) |

Approved Eligibility requires `WITHDRAWAL_REQUEST → FEATURE_FLAG → WITHDRAWAL_REQUESTS_PAUSE`. Therefore Closed Beta staging should seed an **explicit paused** STAGING row rather than relying on a missing-row error (or worse, Withdrawal Engine treating missing as open).

### Recommended seed (DO NOT EXECUTE in Step 4C.1)

`feature_flags` (exactly one row):

```text
flag_key=WITHDRAWAL_REQUESTS_PAUSE
environment=STAGING
enabled=true
description=Kill switch: pause new withdrawal requests.
```

`feature_flag_versions` (exactly one initial history row):

```text
flag_version=1
old_enabled=NULL
new_enabled=true
reason=PHASE20_CLOSED_BETA_WITHDRAWAL_REQUEST_PAUSE
effective_at=now()
changed_by_admin_id=NULL   # unless a real authenticated Admin ceremony exists
audit_log_id=NULL          # unless authoritative audit row is created in-ceremony
```

**Do not invent admin IDs.** If initial seed is performed outside Admin ceremony, document `changed_by_admin_id=NULL` explicitly as a bootstrap exception requiring Owner acknowledgment.

No other flags may be modified (including `PAYOUT_DISPATCH_PAUSE`, `REFERRAL_REWARD_PAUSE`, `MISSION_REWARD_PAUSE`, `AUTO_PAYOUT_PAUSE`, `GLOBAL_REWARDS_PAUSE`).

---

## 5. Future atomic ceremony order (PLAN ONLY — DO NOT EXECUTE)

Single controlled transaction / Owner-gated ceremony:

1. **Revalidate** policy tables still match preflight expectations (empty → next=1, or re-blocked if changed).
2. **Revalidate** `WITHDRAWAL_REQUESTS_PAUSE/STAGING` still MISSING.
3. **Seed** explicit paused flag + `feature_flag_versions` v1 (as above).
4. **Insert** approved ACTIVE Risk v1 / Trust v1 / Eligibility v1 (append-only; no silent JSON rewrite of history).
5. **Assert:**
   - exactly one now-window ACTIVE Risk / Trust / Eligibility;
   - digests match approved;
   - `WITHDRAWAL_REQUESTS_PAUSE/STAGING` exists and `enabled=true`;
   - `PAYOUT_DISPATCH_PAUSE/STAGING` remains `enabled=true`;
   - AdsGram `production_monetary_status` remains `BLOCKED`;
   - no unrelated flag rows changed.
6. **COMMIT** only if all assertions pass; else **ROLLBACK**.

Concurrency: lock / count guards as in prior Step 4C plan; expected old ACTIVE count = 0.

---

## 6. Rollback

### A. Before commit

Full transaction rollback — no flag seed, no policy rows.

### B. After commit (behavioral failure)

Versioned only:

- SUPERSEDE/REVOKE bad ACTIVE policy rows (`effective_to` close); do not rewrite config JSON evidence.
- Flag rollback (if needed) must append a new `feature_flag_versions` row flipping `enabled` — never mutate immutable version history rows.
- Prefer fail-closed; never invent ALLOW-everything policies.
- Independent kill switches remain authoritative for money.

---

## 7. Post-activation validation plan (assumes pause seed applied)

Assumes future ceremony left `WITHDRAWAL_REQUESTS_PAUSE/STAGING=true` and policies ACTIVE.

- Risk/Trust resolvers return ACTIVE v1.
- Ordinary AD_SESSION_START evaluable (ACTIVE + LOW risk → ELIGIBLE).
- HIGH/CRITICAL → AD blocked by RISK_POLICY.
- Withdrawal requests **explicitly paused** (Eligibility FEATURE_FLAG + Withdrawal Engine pause).
- No withdrawal creation / payout enablement.
- `PAYOUT_DISPATCH_PAUSE/STAGING` remains true.
- AdsGram monetary remains BLOCKED.
- No signer / TON / Mainnet.
- For Risk-specific withdrawal gating evidence: use bounded Eligibility/Risk tests **without** disabling the safety pause unless separately Owner-authorized.

---

## 8. Independent kill switches (must remain untouched by activation)

| Control                             | Fresh observation                     | May change during activation?           |
| ----------------------------------- | ------------------------------------- | --------------------------------------- |
| AdsGram monetary                    | **BLOCKED** / SANDBOX                 | **NO**                                  |
| `PAYOUT_DISPATCH_PAUSE` STAGING     | **enabled=true**                      | **NO**                                  |
| `REFERRAL_REWARD_PAUSE` STAGING     | **enabled=true**                      | **NO**                                  |
| `WITHDRAWAL_REQUESTS_PAUSE` STAGING | **MISSING** (seed planned separately) | Only via explicit Owner-authorized seed |

---

## 9. Gap status (unchanged)

- `P20-GAP-009` = `OPEN / OWNER_APPROVED / READY_FOR_STAGING_ACTIVATION`
- `P20-GAP-017` = `OPEN / READY_FOR_OWNER_CONTENT_APPROVAL`
- Closed Beta blockers = 2; real-money = 8; archive = 2

---

## 10. Owner authorization still required

Before any execution:

1. Independent review of corrected tooling + fresh snapshot.
2. Explicit approval of `WITHDRAWAL_REQUESTS_PAUSE/STAGING enabled=true` seed + version history.
3. Explicit approval of Risk/Trust/Eligibility v1 activation ceremony.

Until then: **STOP — DO NOT EXECUTE POLICY ACTIVATION. DO NOT CREATE THE STAGING FEATURE FLAG YET.**
