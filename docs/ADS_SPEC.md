# Advertising specification

Phase 11 implements the rewarded-ad foundation in `@alex-rewards/ads`: a compile-time provider
registry, an append-only evidence trail, a derived session state machine, versioned provider
limits, and a provider-neutral monetary eligibility gate.

> **AdsGram production monetary issuance is BLOCKED.** The seeded AdsGram provider carries
> `production_monetary_status = BLOCKED` with six OPEN clarification items. Phase 11 makes AdsGram
> observable and testable end to end; it does not make it payable. See
> `docs/ADSGRAM_CLARIFICATION_REGISTER.md`.

## Authority model

| Layer                                 | Role                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------- |
| Compile-time provider registry        | The only set of providers that may be used for money; no dynamic loading  |
| `ad_providers`                        | Per-provider policy, production monetary status, open clarification count |
| `ad_provider_capabilities` (manifest) | Declared authentication, correlation and policy capabilities              |
| `provider_limit_rules` (versioned)    | Authoritative REQUEST / SUCCESS limits, per dimension, with source        |
| `ad_session_signals`                  | Append-only evidence; never mutated, never deleted                        |
| `ad_sessions.state`                   | **Derived** from signals, then persisted; never client-assigned           |
| `provider_health_snapshots`           | Gates new authorization only; never reverses an issued reward             |
| `reward_quotes` (Reward Engine)       | Authoritative economics; `ad_session_id` is the single authoritative FK   |
| Ledger (`@alex-rewards/ledger`)       | Financial source of truth, reached only through `issueAdReward`           |
| Client / SDK                          | **Zero** monetary authority                                               |

Client evidence is never money (spec §20). A client completion is a signal like any other; it
raises no balance and cannot advance a session past `CLIENT_COMPLETED`.

## Session lifecycle

Authorization creates the session and its reward quote in **one** transaction with pre-generated
UUIDs, emitting `SESSION_CREATED`, `QUOTE_COMMITTED` and `AUTHORIZATION_PASSED`. It refuses when
the provider is unregistered, unhealthy, over a REQUEST or SUCCESS limit, or already has a live
session for that user (`ad_sessions_one_active_per_user_provider_idx`).

```text
AUTHORIZED → REQUESTED → LOADED → STARTED → CLIENT_COMPLETED → VERIFIED → REWARDED
                     ↘ NO_FILL / FAILED / SKIPPED / EXPIRED / REJECTED (terminal)
```

State is recomputed from the signal history on every append, so replaying the evidence
reproduces the state exactly. Terminal non-reward outcomes release the quote's budget,
membership-bonus and exposure reservations and set the quote to `CANCELLED` — but only while the
quote is still `OPEN` with `source_started_at IS NULL`, so a protected start is never disturbed.

## Monetary eligibility gate

`evaluateProviderMonetaryEligibility` reads data only. It refuses with explicit reason codes and
never branches on a provider name:

| Reason code                                 | Refused because                                          |
| ------------------------------------------- | -------------------------------------------------------- |
| `PRODUCTION_MONETARY_STATUS_BLOCKED`        | Provider is not approved for production money            |
| `CASH_REWARD_POLICY_NOT_APPROVED`           | Provider policy does not permit cash-equivalent rewards  |
| `SERVER_SIGNAL_AUTHENTICATION_INSUFFICIENT` | Server signal is unauthenticated or weakly authenticated |
| `SESSION_CORRELATION_NOT_CONFIRMED`         | Signal cannot be bound to exactly one session            |
| `SIGNAL_CORRELATION_AMBIGUOUS`              | Correlation matched more than one candidate              |
| `OPEN_CLARIFICATION_ITEMS`                  | Unanswered provider clarifications remain open           |
| `PROVIDER_CONFIRMATION_MISSING`             | Only client evidence exists                              |

AdsGram fails on five of these simultaneously. Approving it means changing provider data and
closing clarifications, not changing code.

## Provider limits are configuration

Limits are resolved **per dimension** (`limit_metric` + `limit_window`) as the MINIMUM `max_count`
across every applicable ACTIVE rule version, so a platform, user-tier or country rule can only be
stricter than a provider or contract hard limit — never looser. No numeric limit exists as a code
constant. The seeded AdsGram values (30 REQUEST / 25 SUCCESS per user per UTC day) come from
migration 0030 and are raised or lowered by inserting a new approved, sourced rule version and
superseding the old one. `phase11-limits-version.test.ts` proves a 30 → 100 change with no code
change, while SUCCESS stays at 25.

## Provider SDK boundary

A provider is added by implementing `RewardedAdProvider` (`src/provider-sdk/contract.ts`) and
registering it in the compile-time registry. Providers declare capabilities rather than asserting
trust; the gate reads those declarations. `packages/ads` declares no React dependency: the
official `@adsgram/react` SDK lives in `apps/miniapp`, and the package exports only the
`ClientCompletionSignalPayload` data contract.

## AdsGram Reward URL

`GET /webhooks/adsgram/reward` is unauthenticated by provider design. It stores evidence, attempts
best-effort correlation, records replays as `DUPLICATE`, and returns one uniform
`{ accepted: true, rewardCredited: false }` body for every outcome so it cannot be used as an
oracle. It has no monetary authority, and it fails closed when its throttle store is unavailable.

## HTTP surface

| Endpoint                                   | Auth             | Purpose                                    |
| ------------------------------------------ | ---------------- | ------------------------------------------ |
| `POST /v1/ads/sessions/authorize`          | Access session   | Create session + quote atomically          |
| `POST /v1/ads/sessions/:id/client-signal`  | Access session   | Append client evidence or terminal outcome |
| `POST /v1/ads/sessions/:id/attempt-verify` | Access session   | Run the gate; may issue via Reward Engine  |
| `GET /v1/ads/providers/:code/admin-view`   | Access session   | Read-only provider posture                 |
| `GET /webhooks/adsgram/reward`             | None (throttled) | Provider Reward URL evidence ingestion     |

Requests carrying reward-authority fields (amount, bonus, verification or ledger fields) are
refused with `400` before any domain call. There are no debug or fake-completion endpoints.

## Tests

```bash
pnpm test:phase11
# PHASE11_DATABASE_URL=... or PHASE11_ADS_TESTS=1 + DATABASE_URL
```

Real PostgreSQL via `resetAndMigrate`; no mock data. See `docs/TEST_PLAN.md`.

## Explicit non-goals (Phase 11)

- AdsGram production monetary issuance
- The Earn UI (Phase 12)
- Ad revenue recognition (`AD_NETWORK_RECEIVABLE` / `AD_REVENUE`) posts
- Any provider loaded at runtime rather than at compile time
