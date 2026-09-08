# ALEx Rewards Phase 3 Acceptance Report

Status: **PASS (CORRECTED)** — Phase 3 Telegram auth + membership identity binding correctness gaps closed; GitHub Actions `quality` and `docker-smoke` must be green on the **new** accepted archival commit below. The prior Phase 3 archive for `421ea529…` remains historical evidence only and must not be deleted or rewritten.

Date: 2026-09-08 (correction pass)

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                               | Value                                      |
| ---------------------------------- | ------------------------------------------ |
| Final accepted archival commit SHA | _(filled after CI-green push)_             |
| GitHub Actions run                 | _(filled after CI-green push)_             |
| `quality`                          | _(filled after CI)_                        |
| `docker-smoke`                     | _(filled after CI)_                        |
| Historical Phase 3 archive commit  | `421ea529cad487ff59b46cb1c9cb176f9450893b` |

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
| `@alex-rewards/telegram` initData unit tests      | PASS                                             |
| `@alex-rewards/auth` Phase 3 auth/membership      | PASS (incl. entitlement auth + concurrent login) |
| `@alex-rewards/auth` Phase 3 throttle/brute-force | PASS (real Redis)                                |
| Phase 2 migration/constraint gates                | PASS (27) — regression                           |
| `packages/config` env validation                  | PASS (incl. staging/production fail-closed)      |

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
| `quality` / `docker-smoke`                            | _(CI)_ |

## O. Archive verification

New dual archive will be created from the **new** accepted CI-green commit only. Historical package for `421ea529…` is retained under `phase-archives/PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING/` and must not be deleted or rewritten.

_(Filled after packaging.)_
