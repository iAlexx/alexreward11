# Phase 13 Independent Review Remediation

**Status:** Remediation on branch `phase13-independent-remediation` — **not** independently
accepted until Owner review. Original Phase 13 package / acceptance report is preserved;
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

| Area | Location |
| ---- | -------- |
| Confirmation refuse/success/replay | `packages/auth/test/phase13-admin-web-confirmations.test.ts` |
| Auth matrix + P13 source gates | `apps/api/test/phase13-admin-security-matrix.test.ts` |
| WebAuthn enroll reauth / session bind | `packages/auth/test/phase13-admin-auth.test.ts` |

---

## Explicit non-claims

- AdsGram remains **BLOCKED**
- No Phase 14
- This remediation is not independently accepted until Owner review
- No archive / package hash claimed in this document
