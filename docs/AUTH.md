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
7. User row is created/updated by `telegram_user_id` (username changes never create a second user).
8. Profile/settings metadata may update; `status` / `withdrawal_status` / risk fields are not overwritten from Telegram profile data.
9. A PostgreSQL session row is created with hashed session/refresh secrets.
10. A short-lived access JWT and opaque refresh token are returned (Bearer transport; production cookie topology remains environment-specific / Owner-approved).

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

| Threat                     | Control                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| Spoofed Telegram identity  | HMAC signature + auth_date                                                    |
| initDataUnsafe trust       | Not accepted by API                                                           |
| Username identity swap     | Unique `telegram_user_id` only                                                |
| Refresh theft / replay     | Rotation + hashed storage + revoke                                            |
| Claim brute force          | Rate limits + opaque errors                                                   |
| Claim races                | `FOR UPDATE` + uniqueness constraints                                         |
| Self-assign Founder        | No public grant endpoint; client cannot supply Founder number/purchase fields |
| Membership as trust bypass | `securityBypass: false`; account status still authoritative                   |

## Configuration

See `.env.example`. Local/test defaults are explicitly marked `local-only-*`. Production
must supply managed secrets and Owner-approved CORS/session policy values.
