# Reward Engine

Phase 5 implements the monetary Reward Engine in `@alex-rewards/rewards`.

## Authority model

| Layer                                           | Role                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `reward_rules` (versioned)                      | Authoritative economics for quotes; financial fields immutable after insert (0013) |
| `reward_quotes.applied_economics`               | Frozen reconstruction evidence for every material rule/version used at quote time  |
| `reward_quotes` financial snapshot              | Immutable after insert (0014 trigger); lifecycle fields only                         |
| `simulated_reward_sources`                      | Server-authoritative simulated PROMOTION source registry                             |
| `economic_exposure_periods` / reservations      | Time-scoped atomic exposure counters (0014); Redis has zero authority                |
| `reward_budget_*` / `membership_bonus_budget_*` | Atomic reservation / consume / release projections in PostgreSQL                     |
| Ledger (`@alex-rewards/ledger`)                 | Financial source of truth for issued Pending/Available balances                    |
| Outbox                                          | Same-transaction domain events (`dedupe_key` unique)                               |
| Redis                                           | **Zero** reward authority                                                          |

Client-supplied monetary amounts are never trusted. There is no public `POST /reward` with an amount in Phase 5.

## Simulated source (Phase 5 scope)

Phase 5 does **not** enable AdsGram / provider monetary traffic.

- `source_type = PROMOTION`
- Internal provider code `SIMULATED_REWARD_SOURCE` with `production_monetary_status = BLOCKED`
- `source_id` is a server UUID persisted in `simulated_reward_sources` before quote authorization
- Completion/start is server-only via `completeSimulatedRewardSource` (binding + expiry checks)
- `markSimulatedSourceStarted` is **not** part of the public runtime API
- Start requires `completedAt <= expires_at`; late starts return `QUOTE_EXPIRED` and leave the quote releasable
- Issuance after `expires_at` requires `source_started_at IS NOT NULL AND source_started_at <= expires_at`

## Arithmetic

Integer-only (`bigint`). No `Number` for money. Strings at API boundaries.

Base (spec §21.1):

```text
raw = FLOOR(estimated_ecpm_atomic * user_share_bps * safety_factor_bps / (1000 * 10000 * 10000))
quoted = clamp(raw, min, max)   # or fixed_reward_atomic when set
```

Membership bonus (ADR-013 interim):

```text
bonus = FLOOR(base_amount_atomic * bonus_bps / 10000)
```

Zero after `FLOOR` means **no bonus** (amount `0`), not an error.

## Quote flow

`createRewardQuote` (one PostgreSQL transaction via `withLedgerTransaction`):

1. For `PROMOTION`, prove `simulated_reward_sources` eligibility (server-created, correct provider).
2. Resolve exactly one `ACTIVE` reward rule for context (`resolveRewardRule` fails closed on 0 or >1 matches). Rule family = `reward_rules.code`.
3. Validate base budget period as locator only (ACTIVE, asset, window, scope).
4. Resolve FINANCIAL `ELIGIBLE_REWARD_BONUS` candidates across all active memberships (0 → none; 1 → use; >1 → fail closed).
5. Under `BASE_REWARD_ONLY`, recognized bonus economic unavailability (exhausted/missing/inactive/cap/pause) yields bonus `0` with valid base; `BLOCK_QUOTE_BEFORE_START` fails closed with no surviving quote.
6. Evaluate guardrails with **candidate base + bonus**, lock current UTC exposure periods, snapshot all evaluated limit versions (ALLOW and BLOCK). `MIN_EXPECTED_MARGIN_BPS` when ACTIVE → `MARGIN_POLICY_UNDEFINED` / OWNER_DECISION_REQUIRED (no invented margin formula).
7. Insert quote + frozen `applied_economics` + reserve base budget + **all** applicable bonus budget periods + exposure reservations.
8. Insert outbox `reward_quote.created`.

`expireRewardQuote` is idempotent; releases ACTIVE base, bonus (multi-period), and exposure reservations once; **skips** release when `source_started_at` is set.

## Issuance ledger

`issueSimulatedReward` composes base + optional bonus in **one** outer transaction:

| Leg   | Debit                      | Credit                   | Type                        |
| ----- | -------------------------- | ------------------------ | --------------------------- |
| Base  | `PLATFORM_REWARD_EXPENSE`  | `USER_PENDING_LIABILITY` | `REWARD_ISSUANCE`           |
| Bonus | `MEMBERSHIP_BONUS_EXPENSE` | `USER_PENDING_LIABILITY` | `MEMBERSHIP_BONUS_ISSUANCE` |

Separate `reward_events`:

- Base: quote `source_type` / `source_id`, links `reward_quote_id`
- Bonus: `source_type = MEMBERSHIP_BONUS`, deterministic `source_id` from base event id, **`reward_quote_id = NULL`** (schema: nullable + `UNIQUE(reward_quote_id)`)

Linkage for bonus audit fields lives on `membership_bonus_budget_reservations` (`originating_reward_event_id`, `bonus_reward_event_id`).

Default pending hold: if `pending_hold_seconds = 0`, use **86400** (conservative Phase 5 for new/untrusted).

No `AD_NETWORK_RECEIVABLE` / `AD_REVENUE` posts in Phase 5.

## Maturity

`matureRewardEvent` is idempotent and concurrent-safe (`FOR UPDATE` + ledger idempotency).

- Ledger type `REWARD_MATURITY`
- Business reference type `reward-maturity`, id = reward event id
- Workflow key pattern: `reward-maturity/{reward_event_id}`

## Guardrails

- `GLOBAL_REWARDS_PAUSE` — block new quotes
- `MEMBERSHIP_BONUS_PAUSE` — treat bonus as unavailable (policy decides base-only vs block)
- Exposure limits use exact UTC hour/day/month windows and exact provider/country scope via `economic_exposure_periods`
- Successful quotes freeze **all** materially evaluated active limit IDs/versions in `applied_economics` (not only breaches)
- `MIN_EXPECTED_MARGIN_BPS` — fail closed until an Owner-approved expected-margin formula exists

## Owner config primitives

`createExposureLimitVersion`, `createBenefitRuleVersion`, `bindPlanEntitlement`, `setFeatureFlagEnabled` — internal only; no public HTTP.

Financial values/identity on benefit, exposure, and quote rows are **immutable** after insert.
Approved lifecycle supersession is allowed (e.g. `status`, `effective_to`, quote `status` / `source_started_at` NULL→once / `consumed_at` / `cancelled_at`). Do not treat entire rows as append-only if lifecycle fields may change.

## Tests

```bash
pnpm test:phase5
# or: PHASE5_DATABASE_URL=... / PHASE5_REWARD_TESTS=1 + DATABASE_URL
```

No mock data: suites use real PostgreSQL via `resetAndMigrate`.

## Explicit non-goals (Phase 5)

- AdsGram adapter / real provider money
- Withdrawals / TON payouts / Signer KMS
- Public reward HTTP APIs
- Referral / task / mission reward engines (later phases)
