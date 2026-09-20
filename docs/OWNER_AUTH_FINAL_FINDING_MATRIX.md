# Owner Auth Final Stabilization — Finding Matrix (pre-implementation)

**Branch:** `feature/owner-admin-session-auth`

**Baseline:** `f1798ca7b6b656a943dabadec1acdb7c96e8e6aa`

**Authoritative review:** `ALEX_REWARDS_OWNER_AUTH_ROUND2_INDEPENDENT_REVIEW.md` **NOT FOUND locally**. Findings taken from Owner stabilization prompt (RR2-01…RR2-06).

## Consistent interaction design (shared)

| Priority | Resource |
| --- | --- |
| 1 | `admin_users` Owner row `FOR UPDATE` |
| 2 | `admin_auth_throttle` `FOR UPDATE` |
| 3 | Relevant `admin_credentials` `FOR UPDATE` (ordered by type) |
| 4 | Target / bulk `admin_sessions` locks |

Reauth must **not** lock the session before the Owner row. Resolve session ownership with a non-locking read, lock Owner→throttle, then lock the session and revalidate.

Transaction helper owns the full lifecycle with explicit phase tracking; destroy untrusted connections.

Delete unused `runOnCallerOwnedOwnerAuthClient` (tests-only); keep pool-owned path only.

| ID | Root cause | Affected paths | Required change | Regression risks | Tests | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| RR2-01 | Reauth locks session then Owner; replace locks Owner then sessions | reauth, replace, login, logout | Unified lock hierarchy; reauth resolve-then-lock-owner-then-session | Reauth TOCTOU if recheck weak | A–F concurrency | No deadlock; revoke wins vs stale reauth |
| RR2-02 | Private `_txStatus`; null allowed | `runOnCallerOwned…` | Delete unused helper; drop exports/tests | None if unused | Compile + unit | No private API |
| RR2-03 | COMMIT fail releases damaged client; weak classification | `withPoolOwned…` | Phase machine; destroy on untrusted | Pool churn | Fault injection | Correct cleanup |
| RR2-04 | Prior suite not full concurrency proof | tests | Integrated matrix + barriers | Flaky tests | Matrix | State assertions |
| RR2-05 | system_identifier insufficient alone | gate + docs | Keep ops BLOCKED; expand design | Over-blocking | Static + refuse tests | Ops first enroll blocked |
| RR2-06 | CLI shows TOTP before DB preflight | CLI enroll | Preflight then secrets; authoritative TX checks remain | UX change | Preflight refuse | No secret before gate |
