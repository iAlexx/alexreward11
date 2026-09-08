# Telegram authentication and membership identity binding

Phase 3 implements server-side Telegram Mini App authentication, PostgreSQL-backed
sessions, and Founder claim-code binding. Money engines remain out of scope.

## Authority boundaries

| Concern                          | Authority                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Telegram identity                | Validated `initData` signature only; never `initDataUnsafe`                    |
| User primary key                 | Internal UUID                                                                  |
| Provider identity                | `users.telegram_user_id` (`BIGINT`), API/TS as decimal **string**              |
| Session persistence / revocation | PostgreSQL `user_sessions`                                                     |
| Throttling / cache               | Redis only (non-authoritative)                                                 |
| Membership grant                 | `user_memberships` + `membership_claim_codes` + append-only grant/audit events |
| Money                            | Not touched in Phase 3                                                         |

## initData validation flow

1. Mini App reads raw `Telegram.WebApp.initData`.
2. Client `POST /v1/auth/telegram` with `{ "initData": "<raw>" }`.
3. API rate-limits the attempt (Redis).
4. `@alex-rewards/telegram` validates HMAC per Telegram WebApp docs (`WebAppData` secret key).
5. `auth_date` freshness is checked against `INITDATA_MAX_AGE_SECONDS`.
6. Only after success is the Telegram user JSON parsed.
7. User row is upserted atomically by `telegram_user_id` (`INSERT ... ON CONFLICT DO UPDATE`). Concurrent first logins for the same Telegram ID resolve to exactly one `users` row; each request may still mint its own session.
8. Profile/settings creation is idempotent. Username/name/`telegram_language_code`/`last_active_at` may update; `status`, `withdrawal_status`, risk/security fields, user-chosen `preferred_locale`, and financial state are never overwritten from Telegram profile data.
9. A PostgreSQL session row is created with hashed session/refresh secrets.
10. A short-lived access JWT and opaque refresh token are returned (Bearer transport; production cookie topology remains environment-specific / Owner-approved).

## Membership entitlement read model

`GET /v1/membership` and `GET /v1/membership/entitlements` return only **non-financial** entitlement metadata that is actively mapped to the caller's **active membership plan**:

- join `membership_plan_entitlements` → `membership_benefit_rule_versions` → `entitlements`;
- mapping `status = ACTIVE`, `valid_from <= now()`, and open or future `valid_to`;
- linked rule version `status = ACTIVE`, `effective_from <= now()`, and open or future `effective_to`;
- entitlement `security_classification` in (`PUBLIC`, `INTERNAL`) only — **FINANCIAL** metadata/values are never returned in Phase 3;
- benefit scalar values from rule versions are never selected;
- if the plan has no approved applicable mappings, the entitlement list is `[]`;
- Founder identity (`isFounder`, `founderNumber`) still comes from `user_memberships`;
- `securityBypass` is always `false`.

## Session lifecycle

- **Access token:** HS256 JWT (`sub` = user id, `sid` = session id), TTL `SESSION_ACCESS_TTL_SECONDS`.
- **Refresh token:** opaque random secret; only `sha256` hash stored in `user_sessions.refresh_token_hash`.
- **Rotation:** successful refresh revokes the old row with `ROTATED` and inserts a new row under row lock (`FOR UPDATE`). Replay of the old refresh fails. Concurrent double-refresh yields exactly one live chain.
- **Logout:** revokes current session (`USER_LOGOUT`).
- **Revoke-all:** `POST /v1/auth/revoke-all` marks every active session `SECURITY_EVENT`.
- **List/delete:** `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`.

## Founder claim sequence

1. Authenticated user `POST /v1/membership/founder/claim` with `{ "claimCode": "..." }`.
2. Rate limit applies (generalized failures; no existence oracle).
3. Transaction:
   - lock user; reject `SUSPENDED` / `BANNED` / `DELETED_ANONYMIZED`;
   - lock claim row by hash; reject unknown/expired/consumed/non-Founder;
   - reject if user already has active `FOUNDER_LIFETIME` or already consumed any claim code;
   - allocate Founder number (reserved or `founder_number_seq`);
   - insert `user_memberships` (`source=CLAIM_CODE`);
   - atomic consume update (`WHERE consumed_at IS NULL`);
   - append `membership_grant_events` + `audit_logs` without raw code;
   - commit (or full rollback).
4. Response includes membership metadata and explicitly `moneyIssued: false`, `ledgerPostings: 0`.

Owner direct grant remains admin-only and is not exposed on user routes.

## Security logging / redaction

- Raw `initData`, refresh tokens, claim codes, and bot tokens must never appear in logs or audit snapshots.
- `redactSensitive()` strips common secret field names.
- Generalized user-facing claim errors; detailed reason codes stay in `AuthDomainError.details` for internal diagnostics only.

## Threat model (Phase 3)

| Threat                      | Control                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- |
| Spoofed Telegram identity   | HMAC signature + auth_date                                                    |
| initDataUnsafe trust        | Not accepted by API                                                           |
| Username identity swap      | Unique `telegram_user_id` + race-safe upsert                                  |
| Concurrent first login      | `ON CONFLICT (telegram_user_id)` — one user, multiple sessions allowed        |
| Refresh theft / replay      | Rotation + hashed storage + revoke                                            |
| Claim brute force           | Rate limits (proven in CI against Redis) + opaque errors                      |
| Auth/refresh brute force    | Fixed-window Redis throttle; N ok / N+1 `RATE_LIMITED`; fail-closed on Redis  |
| Claim races                 | `FOR UPDATE` + uniqueness constraints                                         |
| Entitlement over-disclosure | Plan-mapped PUBLIC/INTERNAL only; FINANCIAL excluded                          |
| Self-assign Founder         | No public grant endpoint; client cannot supply Founder number/purchase fields |
| Membership as trust bypass  | `securityBypass: false`; account status still authoritative                   |

## Configuration

See `.env.example`.

| Environment              | Auth policy (`SESSION_*` TTLs, `INITDATA_MAX_AGE_SECONDS`, `CORS_ORIGINS`, auth/claim rate limits)                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local` / `test`         | Built-in local defaults may apply when unset (empty CORS is allowed for local Mini App tooling).                                                                                   |
| `staging` / `production` | **Fail closed**: every policy key must be set explicitly. Empty `CORS_ORIGINS` fails. Local-only secrets remain forbidden. No production values are invented by the config loader. |

Redis throttles (`consumeThrottle`) fail closed on Redis errors — traffic is not silently allowed when abuse protection is unavailable. PostgreSQL remains authoritative for sessions and claim state.
