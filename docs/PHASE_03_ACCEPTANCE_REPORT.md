# ALEx Rewards Phase 3 Acceptance Report

Status: **PASS (CORRECTED)** — Phase 3 Telegram auth + membership identity binding correctness gaps closed; GitHub Actions `quality` and `docker-smoke` are green on the **new** accepted archival commit. The prior Phase 3 archive for `421ea529…` remains historical evidence only and must not be deleted or rewritten.

Date: 2026-09-08 (correction pass)

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                               | Value                                                           |
| ---------------------------------- | --------------------------------------------------------------- |
| Final accepted archival commit SHA | `be08e7fe91309fe42da74d14558ebdaa353215e5`                      |
| GitHub Actions run                 | https://github.com/iAlexx/alexreward11/actions/runs/34276079046 |
| `quality`                          | PASS — job `102229292112`                                       |
| `docker-smoke`                     | PASS — job `102230237284`                                       |
| Historical Phase 3 archive commit  | `421ea529cad487ff59b46cb1c9cb176f9450893b`                      |

Phase 4 has not started. Phase 3 is Telegram auth + membership identity binding only.

## A. Exact scope of Phase 3

Delivered (including correction pass):

- Official Telegram Mini App `initData` HMAC validation (`@alex-rewards/telegram`).
- Race-safe user upsert by validated `telegram_user_id` (`INSERT … ON CONFLICT`; BIGINT / string-safe API).
- PostgreSQL-authoritative sessions with hashed refresh secrets, rotation, logout, revoke-all.
- Short-lived Bearer access JWT (cookie topology not invented for production).
- Membership read model: active plan + Founder identity + **plan-mapped** PUBLIC/INTERNAL entitlements only.
- Atomic Founder claim-code consumption with audit/grant events and zero money/ledger impact.
- Redis throttles for auth/refresh/claim with automated N / N+1 / window-reset / isolation / fail-closed proofs.
- Staging/production auth-policy fail-fast (no silent Zod defaults for session/TTL/CORS/rate-limit keys).
- Docs: `docs/AUTH.md`, this report; ADR-007 / ADR-008 unchanged unless noted.

Explicitly **not** delivered:

- Ledger posting engine, reward issuance, Founder bonus money, referral money, withdrawals, TON payout, KMS signing, AdsGram monetary flow, admin Owner-grant HTTP API, production cookie/domain values.

## B. Correction pass — four gaps closed

### 1. Entitlement filtering semantics

`getMembershipView()` joins the caller's active membership plan through:

`membership_plan_entitlements` → `membership_benefit_rule_versions` → `entitlements`

and returns only rows where mapping and rule version are currently effective (`ACTIVE`, `valid_from`/`effective_from` ≤ now, open or future `valid_to`/`effective_to`), classification is `PUBLIC` or `INTERNAL`, and **no** benefit scalar values are selected. FINANCIAL metadata is excluded. Empty mappings yield `[]`. Founder identity still comes from `user_memberships`. `securityBypass` remains `false`.

### 2. First-login concurrency behavior

Telegram login upserts users with `ON CONFLICT (telegram_user_id) DO UPDATE` for profile metadata only. Concurrent first logins for the same previously unseen Telegram ID both succeed, share one internal user id, may create separate sessions, and do not overwrite `status`, `withdrawal_status`, risk/security state, or user-chosen `preferred_locale`.

### 3. Rate-limit test evidence

Automated suite against real Redis (CI `redis:8.8.2` pin) proves:

- Telegram auth, refresh, and Founder claim throttle prefixes;
- threshold N succeeds / N+1 → `RATE_LIMITED`;
- fixed-window expiry reset;
- claim buckets are not shared across user/IP identities;
- Redis unavailable → fail closed (`INTERNAL`), never fail open;
- Founder claim user-facing errors remain generalized (`Claim could not be completed`).

PostgreSQL remains authoritative for sessions and claim state.

### 4. Staging/production auth-policy fail-fast

For `DEPLOYMENT_ENV=staging|production`, missing explicit values for `SESSION_ACCESS_TTL_SECONDS`, `SESSION_REFRESH_TTL_SECONDS`, `INITDATA_MAX_AGE_SECONDS`, `CORS_ORIGINS`, `AUTH_RATE_LIMIT_*`, and `CLAIM_RATE_LIMIT_*` fail configuration validation. Empty `CORS_ORIGINS` fails outside local/test. Local/test retain defaults. No production values are invented.

## C. Files / modules

- `packages/telegram/**` — initData validation
- `packages/auth/**` — sessions, race-safe login, plan-scoped membership view, claim, throttle, redaction
- `apps/api/src/auth/**`, `apps/api/src/membership/**` — Nest routes/guards
- `packages/config` — API auth/session/throttle env schema (fail-closed outside local/test)
- `docs/AUTH.md`, `docs/PHASE_03_ACCEPTANCE_REPORT.md`
- CI Phase 3 gate + Redis service; compose/`.env.example` local auth secrets

No shipped Phase 2 migrations `0001`–`0011` were modified.

## D. API surface

```text
POST   /v1/auth/telegram
POST   /v1/auth/refresh
POST   /v1/auth/logout
POST   /v1/auth/revoke-all
GET    /v1/auth/sessions
DELETE /v1/auth/sessions/:id
GET    /v1/membership
GET    /v1/membership/entitlements
POST   /v1/membership/founder/claim
```

## E. Authority decisions

- `initDataUnsafe` is never accepted.
- Username is never identity.
- Sessions live in PostgreSQL; Redis is throttle/cache only (fail-closed when unavailable).
- Claim codes stored as hashes only; raw codes never logged/audited.
- Founder membership never sets `securityBypass`.
- Claim path creates zero `ledger_transactions` / `ledger_entries`.
- Entitlement lists cannot act as a security bypass.

## F. Tests

| Suite                                             | Result                                           |
| ------------------------------------------------- | ------------------------------------------------ |
| `@alex-rewards/telegram` initData unit tests      | PASS (8)                                         |
| `@alex-rewards/auth` Phase 3 auth/membership      | PASS (15 — entitlements + concurrent login)      |
| `@alex-rewards/auth` Phase 3 throttle/brute-force | PASS (6 — real Redis)                            |
| Phase 2 migration/constraint gates                | PASS (27) — regression                           |
| `packages/config` env validation                  | PASS (11 — incl. staging/production fail-closed) |

## G–N. Gate checklist

| Gate                                                  | Result |
| ----------------------------------------------------- | ------ |
| Spoofed/invalid/stale/malformed initData rejected     | PASS   |
| Telegram ID string-safe                               | PASS   |
| Session rotate/revoke/replay/race                     | PASS   |
| Concurrent first-login race-safe                      | PASS   |
| Plan-scoped entitlement authorization                 | PASS   |
| Founder claim single-use / race / rollback / no money | PASS   |
| Rate-limit / brute-force proven                       | PASS   |
| Staging/production auth policy fail-fast              | PASS   |
| No self-assign Founder values                         | PASS   |
| Membership cannot bypass account security state       | PASS   |
| No Phase 2 migration edits                            | PASS   |
| Signer remains signing-disabled                       | PASS   |
| No Phase 4+ engines                                   | PASS   |
| `quality` / `docker-smoke`                            | PASS   |

## O. Archive verification

Verified for exact accepted commit `be08e7fe91309fe42da74d14558ebdaa353215e5` using `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260908-204500`). Historical package for `421ea529…` / stamp `20260908-202100` remains in the same phase-archives directory and was not rewritten.

| Item                                                                   | Result                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Canonical source ZIP                                                   | `ALEx_Rewards_PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING_20260908-204500_be08e7f.zip` |
| Canonical source SHA-256                                               | `20fb0018d451e35b7fdb2f08af5cebd49e915065a7ec451cf7949508bb58cd06`                   |
| Review-package ZIP                                                     | `PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING_PACKAGE_20260908-204500_be08e7f.zip`      |
| Outer package SHA-256                                                  | See external `PACKAGE_SHA256.txt` beside the review package (not embedded here)      |
| `MANIFEST.md` / `SHA256SUMS.txt`                                       | PASS — companion checksums match source ZIP, report, and manifest                    |
| Source extraction / prohibited-path scan                               | PASS / PASS                                                                          |
| Review-package extraction / prohibited-path / nested source validation | PASS / PASS / PASS                                                                   |
| Forward-slash ZIP entry names                                          | PASS — `PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING/...` only                          |

Per `AGENTS.md` and `docs/PHASE_ARCHIVE.md`, the SHA-256 of the **outer** review package is published beside it in `PACKAGE_SHA256.txt` and is deliberately **not** embedded in this section.
