# Phase 13 Independent Review Remediation

**Status:** Independent remediation complete on `phase13-independent-remediation`
(dedicated Phase 13 GitHub gates PASS on tip `2b5079c`). **Not** Owner-accepted until
external archive/code review. Original Phase 13 package / acceptance report is preserved;
see supersession pointer on `docs/PHASE_13_ACCEPTANCE_REPORT.md`.

**Specification:** Master Spec V1.3  
**Remediation branch:** `phase13-independent-remediation`  
**AdsGram production monetary status:** **BLOCKED** (unchanged)  
**No Phase 14.**

---

## Findings

### P13-01 — High-impact confirmation was client-forgeable

`assertOptionalConfirmation` no-oped when missing; `HighImpactConfirmationBinding` hashes
were client-computed and did not authorize server-side.

**Fix:** Migration `0032_phase13_admin_web_confirmations.sql`. Server
`prepare → confirm → consume` in `@alex-rewards/auth` with routes
`POST /v1/admin/confirmations/prepare` and `POST /v1/admin/confirmations/:id/confirm`.
All high-impact Admin controllers mandatorily consume `confirmationId`. Client binding
helpers remain display-only and never authorize. Admin UI `HighImpactCeremony` uses the
server phrase.

### P13-02 — Admin browser sessionToken in JSON + sessionStorage bearer

Login/recovery JSON returned `sessionToken`; Admin UI stored bearer in sessionStorage,
which wins over cookie and skips CSRF.

**Fix:** Cookie-only browser auth. Login/recovery JSON omits `sessionToken` (cookie still
set). Admin UI uses `credentials: 'include'`; `session-store` neutralized for browser;
`AdminSessionProvider` refreshes from cookie after login.

### P13-03 — WebAuthn enroll lacked recent reauth / session bind

Registration options/verify did not require recent reauth; challenges lacked
`admin_session_id`.

**Fix:** Migration `0033_phase13_admin_webauthn_session_bind.sql`.
`assertRecentReauth` (via enrollment reauth gate) on register options **and** verify;
REGISTRATION/REAUTH challenges bound to `admin_session_id`.

### P13-04 — Economics labeled withdrawal principal as settled margin

`SUM(withdrawals.net_amount_atomic WHERE CONFIRMED)` was returned as `settled` /
UI `settledMarginAtomic`.

**Fix:** Typed Spec §156M metrics contract. Confirmed withdrawal principal is
`CONFIRMED_WITHDRAWAL_PRINCIPAL_OPERATIONAL` (basis `OPERATIONAL`) only. Missing inputs
are `UNAVAILABLE`. Docs: `docs/ADMIN_ECONOMICS.md`.

---

## Tests

| Area                                  | Location                                                     |
| ------------------------------------- | ------------------------------------------------------------ |
| Confirmation refuse/success/replay    | `packages/auth/test/phase13-admin-web-confirmations.test.ts` |
| Auth matrix + P13 source gates        | `apps/api/test/phase13-admin-security-matrix.test.ts`        |
| WebAuthn enroll reauth / session bind | `packages/auth/test/phase13-admin-auth.test.ts`              |

---

## Admin browser E2E (Playwright)

Package: `apps/admin-e2e` (`@alex-rewards/admin-e2e`), Playwright **1.55.1**.

Gate: `PHASE13_ADMIN_E2E=1`. Isolated DB default `alex_rewards_phase13_e2e` via
`PHASE13_DATABASE_URL` / `PHASE13_ADMIN_E2E_DATABASE_URL`. Redis:
`PHASE13_ADMIN_E2E_REDIS_URL`. Ports: Admin **3031**, API **3032**.

Runner: `pnpm test:phase13:admin-e2e` → builds `@alex-rewards/api` + `@alex-rewards/admin`,
installs Chromium, runs Playwright with `globalSetup` that seeds Owner password+TOTP
(public meta only on disk; no session tokens in sessionStorage).

Covered suites (real Chromium):

- **A** Cookie-only password+TOTP login (no `sessionToken` JSON; HttpOnly cookie; no
  credential storage; Overview loads via cookie)
- **B** WebAuthn enroll (virtual authenticator / CDP) → logout → WebAuthn login cookie-only
- **C** Stale reauth blocks high-impact prepare; password+TOTP reauth refreshes freshness
- **D** Server confirmation prepare → confirm → mutate once; replay + altered payload fail
- **E** Attacker Origin cannot mutate with cookie (CSRF)
- **F** Economics truthful categories; no “settled margin” from confirmed payout principal;
  `UNAVAILABLE` when provider settlement is absent
- **G** Client tampering cannot grant Founder / raise provider hard limit / approve AdsGram /
  edit balances / mint confirmation

---

## CI jobs

Independent of historical `quality` (same pattern as Phase 11/12 remediation):

1. **`phase13-remediation`** — frozen install; non-empty
   `docs/PHASE_13_INDEPENDENT_REVIEW_REMEDIATION.md`; scoped Prettier on remediation-touched
   paths; turbo build api+admin+auth+contracts; `verify:boundaries`; `pnpm test:phase11`,
   `pnpm test:phase12`, `pnpm test:phase13`.
2. **`phase13-admin-e2e`** — postgres `alex_rewards_phase13_e2e` + redis; Playwright Chromium
   with deps; `PHASE13_ADMIN_E2E=1`; `pnpm test:phase13:admin-e2e`.

### GitHub CI on tip `2b5079c` (run `36269004238`)

| Gate                  | Result                                          |
| --------------------- | ----------------------------------------------- |
| `phase11-remediation` | SUCCESS                                         |
| `phase12-remediation` | SUCCESS                                         |
| `phase12-e2e`         | SUCCESS                                         |
| `phase13-remediation` | SUCCESS                                         |
| `phase13-admin-e2e`   | SUCCESS                                         |
| Historical `quality`  | FAIL (Prettier debt kept visible; not weakened) |
| `docker-smoke`        | SKIPPED (needs `quality`)                       |
| OVERALL_REPOSITORY_CI | NO (`quality` FAIL)                             |

Draft PR: https://github.com/iAlexx/alexreward11/pull/9  
Base: `phase12-independent-remediation` · Draft · **not merged**.

---

## Baseline / forward-port

- Independently accepted Phase 12 tip: `8994802887e624a323fa224e42626a3f7ea06943`
- Historical Phase 13 implementation forward-ported: `56900dbd840ee918d76735f24b13d7d3edbc0197`
- Historical docs tip **not** cherry-picked as acceptance truth: `68a53ddef934941fe507d164c1344d229ae57a48`
- Historical branch `feature/owner-admin-session-auth` left untouched

---

## Historical Phase 13 package (preserved, unchanged)

- Path (main worktree archives):  
  `phase-archives/PHASE_13_ADMIN_POLICY_ECONOMICS/PHASE_13_ADMIN_POLICY_ECONOMICS_PACKAGE_20260925-223636_68a53dd.zip`
- Outer SHA-256:  
  `2e1abba0a5e36f686a3836e8dcb6b640419c72eab0edad70203941bbb3a38832`
- Master archive identity for the historical package remains  
  `PHASE_13_ADMIN_POLICY_ECONOMICS`.
- New independent remediation package uses visibly separate directory  
  `PHASE_13_INDEPENDENT_REVIEW_REMEDIATION` (same pattern as Phase 12).

Live hardware passkey smoke: **NOT_RUN_CONFIG_REQUIRED** (no Owner-approved
production Admin RP ID / origin for this remediation).

---

## Explicit non-claims

- AdsGram remains **BLOCKED**
- Clarification gate remains **NO**
- No Phase 14
- This remediation is not independently accepted until Owner review
- `INDEPENDENT_PHASE13_ARCHIVE_VERIFIED` remains **NO** until Owner external verification
- No archive / package hash claimed in this document (see external `PACKAGE_SHA256.txt`)
