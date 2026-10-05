# Phase 1 failure matrix

| Failure                                      | Expected behavior                                                | Verification            |
| -------------------------------------------- | ---------------------------------------------------------------- | ----------------------- |
| Missing/invalid environment value            | Process exits before listening                                   | Config unit tests       |
| PostgreSQL unavailable                       | API readiness is `503`; liveness remains responsive              | Docker smoke/fault test |
| Redis unavailable                            | API readiness is `503`; liveness remains responsive              | Docker smoke/fault test |
| Temporal unavailable                         | API/Worker readiness is `503`; no financial fallback exists      | Docker smoke/fault test |
| Telegram token absent in disabled local mode | Bot boots explicitly disabled                                    | Bot tests and smoke     |
| Telegram token absent in enabled mode        | Bot fails before listening                                       | Config unit tests       |
| KMS configuration supplied to Phase 1 Signer | Signer fails before listening                                    | Config unit tests       |
| OTLP collector unavailable                   | Application continues; telemetry export reports non-secret error | Unit/smoke checks       |
| Shutdown signal                              | Listener closes and clients/workers drain                        | Lifecycle tests/smoke   |
| Secret-like material committed               | CI secret scan fails                                             | Security job            |
| Forbidden app/package dependency             | CI boundary check fails                                          | Architecture job        |

## Phase 11 advertising

| Failure                                            | Expected behavior                                                         | Verification                 |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------- |
| Provider not in the compile-time registry          | Authorization refused `PROVIDER_NOT_REGISTERED`; no session, no quote     | Certification TEST 3         |
| Provider `production_monetary_status = BLOCKED`    | Gate refuses; evidence stored; zero ledger transactions                   | Certification TEST 3, 14     |
| Open provider clarification items                  | Gate refuses `OPEN_CLARIFICATION_ITEMS`                                   | Certification TEST 14        |
| Client completion with no provider confirmation    | Session stops at `CLIENT_COMPLETED`; `PROVIDER_CONFIRMATION_MISSING`      | Certification TEST 7         |
| Reward URL for an unauthenticated provider         | Evidence stored `UNVERIFIED`; `rewardCredited: false`                     | Certification TEST 8         |
| Replayed Reward URL call                           | Recorded once as `DUPLICATE`; one event row, one signal                   | Certification TEST 9         |
| Correlation matches more than one session          | Gate refuses `SIGNAL_CORRELATION_AMBIGUOUS` even for an approved provider | Certification TEST 10        |
| Signal for the wrong user, provider or session     | Refused; no state change                                                  | Certification TEST 11        |
| No fill, load/start failure, user skip             | Terminal state; quote `CANCELLED`; reservations released; no money        | Certification TEST 12        |
| Session expiry                                     | Terminal; quote released; later verification refused `SESSION_TERMINAL`   | Certification TEST 13        |
| REQUEST / SUCCESS daily limit reached              | Authorization refused from data, naming the deciding rule                 | Certification TEST 15        |
| Retried verification after a reward                | Idempotent; no second ledger transaction, no second reward event          | Certification TEST 17        |
| Provider health degraded after a reward            | New authorization refused; the issued reward is never reversed            | Certification TEST 18        |
| Skipped mandatory certification case               | Not treated as a pass; production approval not recommended                | Certification TEST 19        |
| Client sends a reward amount or verification field | API refuses `400` before any domain call                                  | `apps/api/src/ads/http.ts`   |
| Webhook throttle store unavailable                 | Reward URL ingestion fails closed                                         | Webhook controller           |
| `packages/ads` reaches the ledger directly         | Test and CI boundary check fail                                           | `phase11-boundaries.test.ts` |

## Phase 13 Admin control plane

| Failure | Expected behavior | Verification |
| ------- | ----------------- | ------------ |
| Unauthenticated Admin API | 401 / denied | `phase13-admin-auth` API |
| Telegram user JWT on Admin | refused by `AdminSessionGuard` | auth isolation tests |
| Password-only or TOTP-only Owner login | insufficient | `packages/auth` phase13 |
| Used recovery code replay | refused | `packages/auth` phase13 |
| Stale high-impact reauth | mutation refused | assertRecentReauth |
| Second-confirmation after payload change | invalid | confirmation binding tests |
| Arbitrary JS/SQL policy payload | impossible / refused | Policy Center matrix |
| Provider limit above PROVIDER_HARD | refused / effective ≤ hard | ads admin-limits gate |
| AdsGram monetary APPROVED with open clarifications | refused | admin-monetary-approval |
| Direct balance editor field/API | absent | security matrix + admin UI scan |
| Review Queue action without domain command | refused / no ledger write | Review Queue matrix |
| Feature flag trying to bypass auth / hard limit | impossible | feature-flag safety tests |
| Unconfigured exposure production number | not invented; UNAVAILABLE | economics / exposure controllers |
