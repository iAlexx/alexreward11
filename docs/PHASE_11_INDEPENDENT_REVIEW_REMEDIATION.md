# Phase 11 Independent Review Remediation — P11-01

**Status:** Remediation commit / package supersedes prior Owner approval state for
Phase 11 request-counting semantics. The original Phase 11 package is preserved unchanged.

**Specification:** Master Spec V1.3  
**Remediation branch:** `phase11-independent-remediation`  
**Base (original Phase 11 packaging):** `bad4bd59b43ce149eb893c1b5266672590ea5870`  
**Original implementation:** `85fc49190c186743498512861cc62f708debd056`  
**Original package SHA-256:**  
`82b52bc1dacc93aa6ca046ff1d41282b68ad4e4431f3eed01c7d206ee410e7ef`

**Remediation implementation SHA:** `e855c091c0bad68b231c685d6c2610e504dcc50a`  
**Latest remediation tip SHA:** `8c65118343ef8e8b0c889eb54868683d6fcd7141`  
**(Phase 11 job CI-green tip:** `c6be44d3c495f3dffa49f6512b22a6b55e40fae4` — subsequent tips are docs/packaging only)**

**GitHub draft PR:** https://github.com/iAlexx/alexreward11/pull/7 (Draft — **not merged**)  
**GitHub Actions run (Phase 11 job PASS):** https://github.com/iAlexx/alexreward11/actions/runs/36242298807

- `phase11-remediation` job: **PASS** (report non-empty, scoped Prettier, turbo build, typecheck, boundaries, `test:phase11`)
- `quality` job: **FAIL** — historical Prettier debt in Phase 11 ancestry (Foundation validation); kept visible, not weakened
- `docker-smoke`: skipped (needs quality)

**AdsGram production monetary status:** **BLOCKED** (unchanged)  
**AdsGram clarification gate:** **NO** (unchanged; `PROVIDER_SIDE_REQUEST_LIMIT` remains OPEN)

**Historical chronology note:** Phase 12 and Phase 13 were already implemented on
`feature/owner-admin-session-auth` before this remediation. This branch/package contains
**no** Phase 12 or Phase 13 implementation. **No forward integration** was performed at
packaging time. Do not cherry-pick until independent review accepts this remediation.

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

| Concept                             | Behavior                                                                                                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client `REQUEST_APPROVED`           | Append-only CLIENT/UNVERIFIED evidence only — **does not** increment `provider_requests`                                                                                                                                     |
| Client `NO_FILL` / FAILED / SKIPPED | Terminal outcome; no reward; no success count; no `provider_requests` from client claim                                                                                                                                      |
| Authoritative `provider_requests`   | Reserved for future approved provider counting proof; AdsGram has **no** such write path today                                                                                                                               |
| Conservative REQUEST safety         | At authorize: `INSERT` counter row `ON CONFLICT DO NOTHING`, then `SELECT … FOR UPDATE`, then `COUNT(ad_sessions)` for user/provider/UTC day vs versioned REQUEST/UTC_DAY limit. Does **not** increment `provider_requests`. |
| Historical policy                   | `AUTHORIZATION_PASSED` safe_payload records effective limits + rule id/version/scope/window                                                                                                                                  |

Concurrent authorize attempts serialize on the daily counter row so two transactions cannot
both observe N−1 and create sessions N and N+1. P11-R13 proves the `FOR UPDATE` serialization
point independently of one-live-session uniqueness.

---

## Migrations

None. Existing `ad_daily_counters` row is used as a lock/container; conservative usage is
derived from `ad_sessions` count. Avoids colliding with later-phase migration numbers.

---

## Regression tests

`packages/ads/test/phase11-p11-01-request-counting.test.ts` — P11-R1 through P11-R15
(with R5 = source-boundary / no AdsGram write path; R13 = lock-contention serialization).

Also updated:

- `phase11-certification.test.ts` TEST 15 (session-count seed)
- `phase11-limits-version.test.ts` (session-count seed)
- CI: separate `phase11-remediation` job (independent of `quality`) + `quality` still
  contains Phase 11 step for full-repo runs

---

## Local gates

See acceptance tip commit notes. Expected: `pnpm test:phase11` PASS, `verify:boundaries`
PASS, ads typecheck PASS, Prettier check on remediation-touched files PASS.

---

## GitHub CI

| Gate                                | Result                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Draft PR                            | #7 (not merged)                                                                          |
| Overall repository `quality` job    | **FAIL** — historical Prettier debt (Foundation validation). Kept visible; not weakened. |
| Dedicated `phase11-remediation` job | **PASS** on run `36242298807` (PR HEAD checkout; independent of `quality`)               |

`PHASE11_GITHUB_CI_JOB_PASS=YES`. `OVERALL_REPOSITORY_CI_PASS=NO`.

---

## Archives

- Original accepted Phase 11 package preserved:
  `82b52bc1dacc93aa6ca046ff1d41282b68ad4e4431f3eed01c7d206ee410e7ef`
- Previous remediation package (pre-final-corrections) preserved unchanged:
  `aa3bf47a5aa7d913a162afb477e715fc5a270d686c7706f1cf3d3072e5064916`
- Final remediation package SHA (built from tip `8c65118`):
  `2663e87a545d6e281602b84cf7530bae438e4f4de4548c75f4eee2bbe2330b99`
  Path: `phase-archives/PHASE_11_ADSGRAM_PROVIDER_FRAMEWORK/PHASE_11_ADSGRAM_PROVIDER_FRAMEWORK_PACKAGE_20260926-123535_8c65118.zip`
- Directory companions from original acceptance kept as `*.original-bad4bd5.*`
- **INDEPENDENT_ARCHIVE_VERIFIED:** NO until Owner independently hashes package bytes

---

## Explicit non-claims

- AdsGram is **not** APPROVED for production monetary rewards
- Clarification gate is **not** passed
- This is **not** Phase 12/13/14 work
- Forward cherry-pick into `feature/owner-admin-session-auth` is **not** done
- Overall repository CI green is **not** claimed while historical Prettier debt remains
- Independent archive verification is **not** claimed until Owner hashes the ZIP
