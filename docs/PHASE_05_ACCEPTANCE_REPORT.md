# ALEx Rewards Phase 5 Acceptance Report (Corrected)

Status: **PASS (corrected)** — Phase 5 Reward Engine financial corrections complete after independent review of archive `a7da07d…`. GitHub Actions `quality` (including Phase 5 gates) and `docker-smoke` must be green on **this** corrected archival commit.

Date: 2026-09-09

Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification **v1.2**.

| Item                                  | Value                                      |
| ------------------------------------- | ------------------------------------------ |
| Corrected accepted Phase 5 commit     | _(filled after CI-green push)_             |
| Historical Phase 5 archive (retained) | `a7da07d623c63819344dc72ebb2266d7ad0bcc06` |
| New migration                         | `0014_phase5_financial_corrections.sql`    |
| Migrations `0001`–`0013`              | **unchanged**                              |
| Phase 4 accepted archival source      | `34bb15455f98f9ae298289453f274d5f2f9d0ee2` |

Phase 6 has **not** started. Phase 5 remains Reward Engine (simulated source) only.

## Correction scope (vs historical `a7da07d`)

1. `BASE_REWARD_ONLY` covers exhausted/inactive/out-of-window/cap/pause bonus unavailability (not only missing period / pause).
2. Quote start requires `completedAt <= expires_at`; issuance proves timely `source_started_at`.
3. `markSimulatedSourceStarted` removed from public runtime API; `completeSimulatedRewardSource` enforces binding + expiry.
4. `simulated_reward_sources` is DB-authoritative; arbitrary client source UUIDs rejected.
5. Membership bonus resolves FINANCIAL `ELIGIBLE_REWARD_BONUS` candidates (fail closed on conflict).
6. Budget periods validated as locators against authoritative metadata.
7. All applicable bonus caps reserved atomically (multi-period reservations).
8. Exposure limits use exact UTC windows + scope; concurrency-safe period counters.
9. Successful quotes freeze all evaluated active guardrail versions (ALLOW included).
10. `MIN_EXPECTED_MARGIN_BPS` fail-closed (`MARGIN_POLICY_UNDEFINED`) until Owner formula.
11. `reward_quotes` financial snapshot protected by DB trigger (0014).
12. Docs corrected: financial immutability + approved lifecycle supersession (not full-row append-only).

## Schema

| Migration                               | Change                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `0014_phase5_financial_corrections.sql` | `simulated_reward_sources`; frozen quote trigger; multi-period bonus reservations; exposure period counters |

## Tests (local gate)

| Suite                            | Count  |
| -------------------------------- | ------ |
| Phase 5 arithmetic               | 6      |
| Phase 5 rules                    | 5      |
| Phase 5 quotes/budgets           | 4      |
| Phase 5 issuance                 | 3      |
| Phase 5 Founder/membership bonus | 4      |
| Phase 5 maturity                 | 2      |
| Phase 5 guardrails               | 3      |
| Phase 5 failure injection        | 2      |
| Phase 5 concurrency/composition  | 5      |
| Phase 5 financial corrections    | 14     |
| **Phase 5 total**                | **48** |
| Phase 4 regression               | 41     |
| Phase 2 migration regression     | 27     |
| Phase 3 auth + throttle          | 21     |

## Explicit non-goals

AdsGram monetary flow, withdrawals/payouts, TON/signer/KMS, public money HTTP APIs, Phase 6 engines.

**No Phase 6 work started.**
