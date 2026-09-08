# Reward Engine

Phase 5 implements the monetary Reward Engine in `@alex-rewards/rewards`.

## Authority model

| Layer                                           | Role                                                                               |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `reward_rules` (versioned)                      | Authoritative economics for quotes; financial fields immutable after insert (0013) |
| `reward_quotes.applied_economics`               | Frozen reconstruction evidence for every material rule/version used at quote time  |
| `reward_budget_*` / `membership_bonus_budget_*` | Atomic reservation / consume / release projections in PostgreSQL                   |
| Ledger (`@alex-rewards/ledger`)                 | Financial source of truth for issued Pending/Available balances                    |
| Outbox                                          | Same-transaction domain events (`dedupe_key` unique)                               |
| Redis                                           | **Zero** reward authority                                                          |

Client-supplied monetary amounts are never trusted. There is no public `POST /reward` with an amount in Phase 5.

## Simulated source (Phase 5 scope)

Phase 5 does **not** enable AdsGram / provider monetary traffic.

- `source_type = PROMOTION`
- Internal provider code `SIMULATED_REWARD_SOURCE` with `production_monetary_status = BLOCKED`
- `source_id` is a server UUID
- Completion/start is server-only (`completeSimulatedRewardSource` / `markSimulatedSourceStarted`)
- Issuance requires `source_started_at` set; expiry release is skipped after a protected start

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

1. Resolve exactly one `ACTIVE` reward rule for context (`resolveRewardRule` fails closed on 0 or >1 matches). Rule family = `reward_rules.code`.
2. Evaluate guardrails (global pause, exposure limits, margin) — **new quotes only**.
3. Compute base amount; optionally evaluate Founder/`ELIGIBLE_REWARD_BONUS`.
4. Require `bonusUnavailablePolicy` when bonus evaluation is in scope (`BASE_REWARD_ONLY` | `BLOCK_QUOTE_BEFORE_START`).
5. Insert quote + `applied_economics` + base budget reservation (`base_amount_atomic` only).
6. Optionally reserve membership bonus budget separately.
7. Insert outbox `reward_quote.created`.

`expireRewardQuote` is idempotent; releases ACTIVE reservations once; **skips** release when `source_started_at` is set.

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
- `economic_exposure_limits` — block new quotes when breached; never rewrite started quotes

## Owner config primitives

`createExposureLimitVersion`, `createBenefitRuleVersion`, `bindPlanEntitlement`, `setFeatureFlagEnabled` — internal only; no public HTTP.

Benefit / exposure rows are **append-only** after insert (0013). Overlapping `ACTIVE` windows fail closed via `EXCLUDE`.

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
