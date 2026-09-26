# Phase 11 Independent Review Remediation — P11-01

**Status:** Remediation commit / package supersedes prior Owner approval state for
Phase 11 request-counting semantics. The original Phase 11 package is preserved unchanged.

**Specification:** Master Spec V1.3  
**Remediation branch:** `phase11-independent-remediation`  
**Base (original Phase 11 packaging):** `bad4bd59b43ce149eb893c1b5266672590ea5870`  
**Original implementation:** `85fc49190c186743498512861cc62f708debd056`  
**Original package SHA-256:**  
`82b52bc1dacc93aa6ca046ff1d41282b68ad4e4431f3eed01c7d206ee410e7ef`

**AdsGram production monetary status:** **BLOCKED** (unchanged)  
**AdsGram clarification gate:** **NO** (unchanged; `PROVIDER_SIDE_REQUEST_LIMIT` remains OPEN)

**Historical chronology note:** Phase 12 and Phase 13 were already implemented on
`feature/owner-admin-session-auth` before this remediation. This branch/package contains
**no** Phase 12 or Phase 13 implementation. No forward integration was performed at
packaging time.

---

## Finding P11-01

Client signal `REQUEST_APPROVED` (source=`CLIENT`, authenticity=`UNVERIFIED`) was treated
as authoritative provider-request evidence: after appending the signal,
`countProviderRequest` incremented `ad_daily_counters.provider_requests`.

That violated Spec separation of:

- UI / client-observed attempt
- actual provider request
- loaded / started / completed / verified reward

and contradicted clarification item `PROVIDER_SIDE_REQUEST_LIMIT` (browser-asserted
request counts carry no authority).

### Integrity problems

1. **False counting** — a client could report `REQUEST_APPROVED` without any AdsGram request.
2. **Undercount / bypass of safety** — a modified client could omit the signal and avoid
   incrementing the counter that authorize previously read for REQUEST limits.

Production money was already blocked (`BLOCKED`), but the counting model was still wrong.

---

## Fix (after)

| Concept | Behavior |
| ------- | -------- |
| Client `REQUEST_APPROVED` | Append-only CLIENT/UNVERIFIED evidence only — **does not** increment `provider_requests` |
| Client `NO_FILL` / FAILED / SKIPPED | Terminal outcome; no reward; no success count; no `provider_requests` from client claim |
| Authoritative `provider_requests` | Reserved for future approved provider counting proof; AdsGram has **no** such path today |
| Conservative REQUEST safety | At authorize: `INSERT` counter row `ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`, then `COUNT(ad_sessions)` for user/provider/UTC day vs versioned REQUEST/UTC_DAY limit. Does **not** increment `provider_requests`. |
| Historical policy | `AUTHORIZATION_PASSED` safe_payload records effective limits + rule id/version/scope/window |

Concurrent authorize attempts serialize on the daily counter row so two transactions cannot
both observe N−1 and create sessions N and N+1.

---

## Migrations

None. Existing `ad_daily_counters` row is used as a lock/container; conservative usage is
derived from `ad_sessions` count. Avoids colliding with later-phase migration numbers.

---

## Regression tests

`packages/ads/test/phase11-p11-01-request-counting.test.ts` — P11-R1 through P11-R15.

Also updated:

- `phase11-certification.test.ts` TEST 15 (session-count seed)
- `phase11-limits-version.test.ts` (session-count seed)
- CI: `pnpm test:phase11` after Phase 10

Local result: **44 PASS** (`test:phase11`), `verify:boundaries` PASS, ads typecheck PASS.

---

## Remediation commit SHA

_(filled after commit)_

---

## Archives

- Original package ZIP preserved under
  `phase-archives/PHASE_11_ADSGRAM_PROVIDER_FRAMEWORK/`
  with hash `82b52bc1…e7ef` (verified before and after packaging).
- New remediation stamped package created alongside; directory-level companions from the
  original acceptance are preserved as `*.original-bad4bd5.*`.

---

## Explicit non-claims

- AdsGram is **not** APPROVED for production monetary rewards
- Clarification gate is **not** passed
- This is **not** Phase 12/13/14 work
- Forward cherry-pick into `feature/owner-admin-session-auth` is **not** done here
