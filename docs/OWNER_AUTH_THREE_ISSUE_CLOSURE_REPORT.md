# Owner Auth — Three-Issue Closure Report

**Status:** STOP for independent delta review

**Date:** 2026-09-20

**Branch:** `feature/owner-admin-session-auth`

**HEAD:** `f1798ca7b6b656a943dabadec1acdb7c96e8e6aa` (unchanged; no commit)

**Baseline:** `f1798ca7b6b656a943dabadec1acdb7c96e8e6aa`

**Previous reviewed archive SHA256:** `652d4580e789f5b00c71213e7846ab7283a50622d890fae77dced757010f8251`

**Delta-review reference file:** `ALEX_REWARDS_OWNER_AUTH_FINAL_CLOSURE_DELTA_REVIEW.md` was **not available** in the workspace; this closure follows the three issues and acceptance requirements stated in the Owner prompt.

No commit, push, merge, deploy, operational migration, Owner enrollment, Recovery CLI, Worker/Temporal/Signer/TON actions were performed.

---

## 1. Branch and HEAD

| Field | Value |
|-------|-------|
| Branch | `feature/owner-admin-session-auth` |
| HEAD | `f1798ca7b6b656a943dabadec1acdb7c96e8e6aa` |
| Working tree | Prior uncommitted Owner-auth work preserved; this closure only narrows two files (+ this report / review ZIP) |

---

## 2. Exact changed files (this closure)

| Path | Role |
|------|------|
| `packages/auth/src/admin-auth.ts` | Issue 1 — read-only transaction lifecycle |
| `packages/auth/test/owner-admin-auth.test.ts` | Issues 1–3 tests + Issue 3 pool timeouts |
| `docs/OWNER_AUTH_THREE_ISSUE_CLOSURE_REPORT.md` | This report |

Migration `0024` was **not** modified.

---

## 3. Issue 1 — Read-only transaction error handling: **FIXED**

### Problem (prior snapshot)
`withPoolOwnedReadOnlyTransaction` classified COMMIT failure by inspecting exception message text containing `"COMMIT failed"`. A work callback throwing `AuthDomainError` with that phrase could skip ROLLBACK and release a client with an open transaction.

### Fix
- Removed all exception-message-based transaction-state classification from the read-only helper.
- Explicit phase blocks: acquire → BEGIN → work → COMMIT, with ROLLBACK only on work failure.
- Work failure → always attempt ROLLBACK; release after successful cleanup; destroy client if ROLLBACK fails.
- COMMIT failure → indeterminate outcome message; destroy client; no automatic retry.
- Original error preserved on successful ROLLBACK; cleanup error wrapped with original message in details when ROLLBACK fails.
- Main writable helper `withPoolOwnedOwnerAuthTransaction` left unchanged (no demonstrated dependency).

### Evidence
- Mock tests in `owner-admin-auth.test.ts`:
  - A. Work throws `AuthDomainError` containing `"COMMIT failed"` → ROLLBACK + healthy release
  - B. Injected COMMIT failure → destroy + indeterminate wording
  - C. Injected ROLLBACK failure → destroy
  - D. Successful read-only transaction → release once
  - E. BEGIN failure → destroy; work never runs
  - F. Client release exactly once (covered in A/B/D)
  - G. No secret leakage in error serialization (`PASSWORD` absent from messages)
- Prior snapshot (`652d4580…`) used message-based `"COMMIT failed"` classification in the read-only path; current source has no `message.includes(...)` classification in that helper.
- Full suite: **65/65 passed** (includes all Issue 1 cases).

---

## 4. Issue 2 — Real reauth vs credential replacement: **FIXED** (bounded)

### What was proven
One integration test:

`Issue2: real reauth API vs real credential-replacement API under Owner-lock barrier`

exercises:

1. Synthetic Owner enrollment + session on isolated `alex_rewards_test`
2. Holder connection acquires `admin_users … FOR UPDATE` for the Owner row
3. **Real** `reauthenticateOwnerAdminSession` started first
4. Barrier wait uses **holder-pid-specific** `pg_locks` join + `pg_stat_activity.datname = current_database()` (not a generic unrelated waiter scan). At wait time only reauth is in flight against that Owner lock.
5. **Real** `completeOwnerAdminTotpEnrollment(..., replaceExisting: true, currentPassword/currentTotpCode)` started while barrier held
6. Holder COMMIT; both operations complete or reject safely via `Promise.allSettled`
7. Assertions:
   - No PostgreSQL deadlock wording in rejections
   - ≤1 ACTIVE credential per type; exactly 2 ACTIVE credentials total
   - No `idle in transaction` backends left on the test DB
   - If replacement fulfills: old session `revoked_at` set, `revoked_reason = SECURITY_EVENT`, zero open sessions; login with **new** password+TOTP succeeds; login with **old** password+TOTP fails
   - If replacement rejects: active credential cardinality still holds (safe reject)

### Scope honesty
- Proves the coordinated Owner-lock interaction for these two production APIs under a controlled barrier.
- Does **not** claim all possible race schedules are impossible.
- Does **not** rename an incomplete manual-revoke test as coverage; FS-04 (manual revoke) remains separate; Issue 2 is the real replace path.

---

## 5. Issue 3 — Test connection timeout coverage: **FIXED**

### Problem
Session-level `SET lock_timeout` / `SET statement_timeout` on one checked-out client did not apply to other Pool connections (max 8).

### Fix
`createIsolatedAuthTestPool` uses verified **pg@8.23.0** Pool constructor option:

```text
options: "-c lock_timeout=8s -c statement_timeout=60s"
```

(libpq startup `options` — applies to every new backend, including `pool.query()` and `pool.connect()`). No un-awaited connect-callback SET.

### Evidence
Test `Issue3: two distinct clients both inherit lock_timeout and statement_timeout`:

- Client A and B both report `lock_timeout = 8s`
- Both report `statement_timeout = 1min` (PostgreSQL display form of 60s)

Vitest file timeout remains a separate outer safety layer (`240_000` / per-test bounds).

Operational PostgreSQL configuration was not changed.

---

## 6. Exact tests executed and results

### Preflight isolation (before DB tests)

```text
TEST { db: 'alex_rewards_test', usr: 'alex_rewards', port: 5432 }
OPS  { db: 'alex_rewards',      usr: 'alex_rewards', port: 5432 }
ISOLATION_OK
```

Connection target: `127.0.0.1:55432` / database name `alex_rewards_test` only.

Destructive-test guards remain in harness (`assertSafeDestructiveTestDatabaseUrl` / expectedDatabase checks in suite).

### Commands and results

| Command | Result |
|---------|--------|
| `pnpm --filter @alex-rewards/auth run build` | PASS |
| `pnpm --filter @alex-rewards/auth run typecheck` | PASS |
| `pnpm --filter @alex-rewards/auth run lint` | PASS |
| `OWNER_ADMIN_AUTH_DATABASE_URL=…/alex_rewards_test OWNER_ADMIN_AUTH_TESTS=1 pnpm --filter @alex-rewards/auth run test:owner-admin-auth` | **65 passed / 65** (302s class; final run ~295s) |
| `PHASE7_DATABASE_URL=…/alex_rewards_test` vitest `phase10-canary-signing-recovery.test.ts` (unit/integration fixtures; **not** Recovery CLI) | **26 passed / 26** |

### Distinction

| Suite | Kind |
|-------|------|
| Issue 1 mock Pool fault tests | **Mock** (no PostgreSQL) |
| Owner-admin-auth Round 2 / FS / Issue2 / Issue3 | **PostgreSQL integration** on `alex_rewards_test` |
| Phase10 canary signing recovery test file | **Isolated fixture** tests (DB reset on `alex_rewards_test`); library APIs only — **Recovery CLI not executed** |

---

## 7. Failed / skipped / not-executed

| Item | Status |
|------|--------|
| Final full Owner-auth suite | No failures, no skips on final run |
| Recovery CLI | **Not executed** (forbidden) |
| Operational DB writes / migration 0024 apply | **Not executed** |
| Misleading-message regression on *old* code binary | Proven by prior-snapshot source diff + current mock test A (would skip ROLLBACK under message classification; now ROLLBACKs). Old binary not re-run in-process. |

---

## 8. Final database-state assertions (Issue 2)

On `alex_rewards_test` after both APIs settle:

- ACTIVE credentials: exactly one per `credential_type`, total count 2
- If replace fulfilled: original session revoked (`SECURITY_EVENT`); zero unrevoked sessions; new factors authenticate; old factors do not
- No leftover `idle in transaction` on the test database

---

## 9. Remaining risks

1. Issue 2 covers one controlled barrier schedule; other interleavings (e.g. replace arriving before reauth wait visibility) are not exhaustively enumerated.
2. Shared TOTP step between concurrent reauth and replace can cause one side to fail closed on step reuse — accepted safe reject path.
3. Test Pool `options` timeouts are test-only; production Pool configuration is unchanged and out of scope.
4. Full multi-host / replica failover behavior is out of scope.

---

## 10. Preserved operational restrictions

Confirmed unchanged / still gated in code and suite:

- Operational Owner-auth default-deny (`alex_rewards`)
- Operational first-enrollment refusal
- Read-only enrollment preflight (no INSERT / FOR UPDATE)
- Owner role + active status checks
- Credential verification, TOTP replay protection, durable failure accounting
- Session expiry / revocation
- Same-session 15-minute reauthentication
- Session-token hash compatibility
- Credential rotation → session revocation
- Recovery fencing / no-broadcast requirements (Recovery unit suite green; CLI not run)
- Migration `0024` content unchanged in this closure
- Bootstrap / operational authentication not activated

---

## Review package

See companion sanitized ZIP beside this report under `phase-archives/OWNER_AUTH_THREE_ISSUE_CLOSURE/` (absolute path and SHA256 recorded in the export meta / `PACKAGE_SHA256.txt`).
