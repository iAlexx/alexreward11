# ALEx Rewards Phase 3 Acceptance Report

Status: **PASS** — Phase 3 Telegram auth + membership identity binding is complete; GitHub Actions `quality` and `docker-smoke` are green on the accepted archival commit. Dual archive packaging follows; Phase 4 must not start until Owner approval.

Date: 2026-09-08

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                               | Value                                                           |
| ---------------------------------- | --------------------------------------------------------------- |
| Final accepted archival commit SHA | `421ea529cad487ff59b46cb1c9cb176f9450893b`                      |
| GitHub Actions run                 | https://github.com/iAlexx/alexreward11/actions/runs/34273751201 |
| `quality`                          | PASS — job `102221546933`                                       |
| `docker-smoke`                     | PASS — job `102222392491`                                       |

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
- Docs: `docs/AUTH.md`, this report; ADR-007 remains the locked-initials reference; ADR-008 records Bearer transport.

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
| `packages/config` env validation             | PASS (6)               |

## G–N. Gate checklist

| Gate                                                  | Result |
| ----------------------------------------------------- | ------ |
| Spoofed/invalid/stale/malformed initData rejected     | PASS   |
| Telegram ID string-safe                               | PASS   |
| Session rotate/revoke/replay/race                     | PASS   |
| Founder claim single-use / race / rollback / no money | PASS   |
| No self-assign Founder values                         | PASS   |
| Membership cannot bypass account security state       | PASS   |
| No Phase 2 migration edits                            | PASS   |
| Signer remains signing-disabled                       | PASS   |
| No Phase 4+ engines                                   | PASS   |
| `quality` / `docker-smoke`                            | PASS   |

## O. Archive verification

Verified for exact accepted commit `421ea529cad487ff59b46cb1c9cb176f9450893b` using `scripts/create-phase-archive.mjs` v2.1.0 (stamp `20260908-202100`).

| Item                                                                   | Result                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Canonical source ZIP                                                   | `ALEx_Rewards_PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING_20260908-202100_421ea52.zip` |
| Canonical source SHA-256                                               | `f6ab932a03a05d8f60e6b56db4782852f14c27fb61f0d28b1f950ccb0be6ac7e`                   |
| Review-package ZIP                                                     | `PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING_PACKAGE_20260908-202100_421ea52.zip`      |
| Outer package SHA-256                                                  | See external `PACKAGE_SHA256.txt` beside the review package (not embedded here)      |
| `MANIFEST.md` / `SHA256SUMS.txt`                                       | PASS — companion checksums match source ZIP, report, and manifest                    |
| Source extraction / prohibited-path scan                               | PASS / PASS                                                                          |
| Review-package extraction / prohibited-path / nested source validation | PASS / PASS / PASS                                                                   |
| Forward-slash ZIP entry names                                          | PASS — `PHASE_03_TELEGRAM_AUTH_MEMBERSHIP_BINDING/...` only                          |

Per `AGENTS.md` and `docs/PHASE_ARCHIVE.md`, the SHA-256 of the **outer** review package is published beside it in `PACKAGE_SHA256.txt` and is deliberately **not** embedded in this section.
