# ALEx Rewards Phase 3 Acceptance Report

Status: **PENDING CI** — implementation and local gates complete; archival commit CI not yet recorded.

Date: 2026-09-08

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                               | Value   |
| ---------------------------------- | ------- |
| Final accepted archival commit SHA | `TBD`   |
| GitHub Actions run                 | `TBD`   |
| `quality`                          | PENDING |
| `docker-smoke`                     | PENDING |

Phase 4 has not started. Phase 3 is Telegram auth + membership identity binding only.

## A. Exact scope of Phase 3

Delivered:

- Official Telegram Mini App `initData` HMAC validation (`@alex-rewards/telegram`).
- User create/update by validated `telegram_user_id` (`BIGINT` / string-safe API).
- PostgreSQL-authoritative sessions with hashed refresh secrets, rotation, logout, revoke-all.
- Short-lived Bearer access JWT (cookie topology not invented for production).
- Membership read model (status/plan/Founder number + non-FINANCIAL entitlement vocabulary).
- Atomic Founder claim-code consumption with audit/grant events and zero money/ledger impact.
- Redis throttles for auth/refresh/claim; CORS allowlist; security response headers; redaction helper.
- Docs: `docs/AUTH.md`, this report; ADR-007 remains the locked-initials reference.

Explicitly **not** delivered:

- Ledger posting engine, reward issuance, Founder bonus money, referral money, withdrawals, TON payout, KMS signing, AdsGram monetary flow, admin Owner-grant HTTP API, production cookie/domain values.

## B. Files / modules

Added/updated:

- `packages/telegram/**` — initData validation
- `packages/auth/**` — sessions, login, membership claim, throttle, redaction
- `apps/api/src/auth/**`, `apps/api/src/membership/**` — Nest routes/guards
- `packages/config` — API auth/session/throttle env schema
- `docs/AUTH.md`, `docs/PHASE_03_ACCEPTANCE_REPORT.md`
- CI Phase 3 gate; compose/`.env.example` local auth secrets

No shipped Phase 2 migrations `0001`–`0011` were modified.

## C. API surface

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

## D. Authority decisions

- `initDataUnsafe` is never accepted.
- Username is never identity.
- Sessions live in PostgreSQL; Redis is throttle/cache only.
- Claim codes stored as hashes only; raw codes never logged/audited.
- Founder membership never sets `securityBypass`.
- Claim path creates zero `ledger_transactions` / `ledger_entries`.

## E. Configuration note

`SESSION_*`, `CORS_ORIGINS`, and rate-limit env values ship with **local/test** defaults explicitly marked `local-only-*` where applicable. Production cookie topology and final TTLs remain environment-specific and must not silently inherit local defaults without Owner approval.

## F. Tests

| Suite                                        | Result                 |
| -------------------------------------------- | ---------------------- |
| `@alex-rewards/telegram` initData unit tests | PASS (8)               |
| `@alex-rewards/auth` Phase 3 integration     | PASS (12)              |
| Phase 2 migration/constraint gates           | PASS (27) — regression |
| `packages/config` env validation             | PASS                   |

## G–N. Gate checklist

| Gate                                                  | Result  |
| ----------------------------------------------------- | ------- |
| Spoofed/invalid/stale/malformed initData rejected     | PASS    |
| Telegram ID string-safe                               | PASS    |
| Session rotate/revoke/replay/race                     | PASS    |
| Founder claim single-use / race / rollback / no money | PASS    |
| No self-assign Founder values                         | PASS    |
| Membership cannot bypass account security state       | PASS    |
| No Phase 2 migration edits                            | PASS    |
| Signer remains signing-disabled                       | PASS    |
| No Phase 4+ engines                                   | PASS    |
| `quality` / `docker-smoke`                            | PENDING |

## O. Archive verification

Placeholder — filled after CI-green archival commit and `pnpm archive:phase`.
