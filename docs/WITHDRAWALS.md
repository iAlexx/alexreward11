# Withdrawal Engine (Phase 7 — Fake Chain)

Phase 7 implements the corrected withdrawal domain against a **deterministic fake payout
chain**. Money movement uses the Phase 4 ledger only. There is **no** real TON broadcast,
signer, KMS, mnemonic, or Jetton transfer in this phase.

Package: `@alex-rewards/withdrawals`. HTTP surface: authenticated Nest routes under `/v1`.
Schema integrity: forward migration `0017_withdrawal_engine_integrity.sql` (do not edit
`0001`–`0016`).

## Quote lifecycle

Statuses: `OPEN` → (`CONSUMED` | `CANCELLED` | `EXPIRED`).

| Status      | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `OPEN`      | Server-produced fee/limit snapshot; TTL-bound; **no ledger reservation** |
| `CONSUMED`  | Consumed exactly once by successful withdrawal create                    |
| `CANCELLED` | Explicit user cancel while still `OPEN`                                  |
| `EXPIRED`   | Past `expires_at` (lazy on cancel/create paths)                          |

Quotes never reserve Available balance. Reservation happens only when a withdrawal is created
from an `OPEN` quote.

## Fixed fee (V1) and locked initials

V1 uses the **fixed fee** path from an ACTIVE `withdrawal_fee_rules` row (`percentage_bps = 0`).
Local/test fixtures may instantiate locked V1.2 initials (`LOCKED_INITIAL_WITHDRAWAL`):

| Field                         | Atomic (6-decimal USDT) | Human         |
| ----------------------------- | ----------------------- | ------------- |
| `minWithdrawalAtomic`         | `200000`                | 0.20          |
| `fixedFeeAtomic`              | `10000`                 | 0.01          |
| `maxSingleWithdrawalAtomic`   | `5000000`               | 5             |
| `maxUserHourlyAtomic`         | `5000000`               | 5 / hour      |
| `maxUserDailyAtomic`          | `10000000`              | 10 / UTC day  |
| `maxHotWalletHourlyAtomic`    | `25000000`              | 25 / hour     |
| `maxHotWalletDailyAtomic`     | `100000000`             | 100 / UTC day |
| `walletChangeCooldownSeconds` | `86400`                 | 24h           |

Production rows remain explicitly provisioned — not seeded by migration `0017`.

Net: `net = gross − final_fee` (must be positive). Amounts are `bigint` / API atomic strings only.

## Fee benefit resolution

Entitlement code `WITHDRAWAL_PLATFORM_FEE_DISCOUNT` (FINANCIAL / BPS) resolves through:

`user_memberships` → plan → `membership_plan_entitlements` → `membership_benefit_rule_versions`.

Arithmetic (FLOOR):

```text
discount = FLOOR(base_platform_fee_atomic * discount_bps / 10000)
final_fee = base − discount
```

- **Founder (or any membership) alone = zero discount** unless an ACTIVE approved entitlement
  rule exists.
- Ambiguous FINANCIAL candidates → fail closed (`ENTITLEMENT_AMBIGUOUS`).
- Quote/withdrawal store `base_platform_fee_atomic`, `membership_fee_discount_bps`, and
  `fee_entitlement_rule_version_id` for reconstruction.

## Priority entitlement

`PRIORITY_WITHDRAWAL_REVIEW` sets `priority_review` / queue ordering only. It does **not**
bypass risk, manual review, security gates, or auto-approve.

## Limits and volume concurrency

Limits are **gross** (requested amount). Fee discount does not inflate headroom.

Concurrency authority is PostgreSQL `withdrawal_volume_periods` +
`withdrawal_volume_reservations` (scopes: `USER_HOURLY`, `USER_UTC_DAY`,
`HOT_WALLET_HOURLY`, `HOT_WALLET_UTC_DAY`). Redis has zero volume authority. Committed
`REQUESTED` withdrawals consume the original UTC period permanently (idempotent per
withdrawal).

## Frozen quote + DB protection

Migration `0017` freezes quote money/provenance via trigger: identity, amounts, fee/limit
versions, entitlement bindings, and `expires_at` are immutable after insert. Status may only
transition `OPEN` → `CONSUMED` | `CANCELLED` | `EXPIRED`. Fee/limit ACTIVE windows use
`EXCLUDE USING gist`; financial fields on fee/limit rules are immutable in place.

Withdrawals freeze structural money/provenance; ledger tx id columns are set-once.
Attempt intent fields (query id, fencing token, message hash, etc.) are immutable.

## Reservation (Available → Reserved)

On create from quote, one ledger post:

- Type: `WITHDRAWAL_RESERVATION`
- DR `USER_AVAILABLE_LIABILITY` gross / CR `USER_RESERVED_LIABILITY` gross
- **No fee revenue** at reservation

Idempotency: `(idempotency_scope, idempotency_key)` + unique quote consumption. Exact retry
recovers; conflicting intent fails closed. Duplicate create cannot double-reserve.

## Risk policy (V1)

V1 `WithdrawalRiskPolicy` **never auto-approves**. Ordinary / LOW → `MANUAL_REVIEW`.
Blocked/suspended accounts → reject + release. Priority cannot skip this path.

## Manual Owner decision + Outbox

`decideWithdrawal` is the authoritative Owner/admin command (`APPROVE` | `HOLD` | `REJECT`).
Approve writes transactional Outbox `withdrawal.approved` with payload workflow id
`withdrawal/{withdrawalId}` — **no synchronous Temporal call** in Phase 7.

Reject (definitive pre-broadcast) posts `WITHDRAWAL_RELEASE` for the **full gross once**
(Reserved → Available). Reconcile-origin `HELD` (`held_from_reconcile`) forbids REJECT until
append-only `DEFINITIVE_NONPAYMENT` evidence exists.

## Fake Temporal substitute + workflow ID

LOCAL/TEST uses in-process `FakePayoutChain` + `runFakePayoutPipeline` as an Outbox-driven
pipeline substitute. Workflow ID contract remains `withdrawal/{withdrawalId}` so a real Temporal
worker can later wrap the same activities without changing identity. Staging/production must
keep `fakeChainEnabled = false` (config validation fails closed).

## Attempts + dispatch fencing

Each payout attempt stores immutable intent (attempt number, hot wallet, query id, seqno,
canonical message hash, fencing token). Hot-wallet dispatch leases increment a fencing token;
stale fencing cannot dispatch. Duplicate live attempts for the same withdrawal are prevented.

## Possible-broadcast → RECONCILE_REQUIRED

If broadcast **may** have started, the withdrawal moves to `RECONCILE_REQUIRED` (or reconcile-
origin `HELD`). **Reserved is never released** on ambiguity. No blind resend.

## Reconciliation

`withdrawal_payout_reconciliations` is **append-only** (UPDATE/DELETE rejected). Resolutions:
`UNRESOLVED` | `INTENDED_PAYOUT_PROVEN` | `DEFINITIVE_NONPAYMENT` | `AMBIGUOUS`. Evidence is
required before reject-from-reconcile; ledger history is never silently rewritten.

## Settlement (CONFIRMED)

At `CONFIRMED`, one `WITHDRAWAL_SETTLEMENT`:

- DR `USER_RESERVED_LIABILITY` gross
- CR `HOT_WALLET_USDT_ASSET` net
- CR `WITHDRAWAL_FEE_REVENUE` fee

Fee revenue is recognized **only** at confirmation. No fake TON gas / network-fee expense in
Phase 7.

## Failure recovery invariants

| Situation                       | Behavior                                            |
| ------------------------------- | --------------------------------------------------- |
| Definite pre-broadcast failure  | Safely retryable; Reserved untouched until reject   |
| Possible / unknown broadcast    | Reconcile; preserve Reserved; no blind retry        |
| Definitive pre-broadcast reject | `WITHDRAWAL_RELEASE` full gross exactly once        |
| Confirmation                    | Settlement exactly once (set-once settlement tx id) |
| Idempotent approve/reject       | Same key recovers; conflicting decision conflicts   |
| Crash mid-pipeline              | Resume from durable state + Outbox; no double money |

## Explicit non-goals (Phase 7)

- Real signer / KMS / mnemonic / seed storage
- Real TON / Jetton broadcast or Testnet payout
- Production Temporal worker wiring (contract reserved)
- Phase 8 Control Center / Telegram admin review UI

## HTTP APIs (authenticated session)

| Method | Path                               | Purpose                           |
| ------ | ---------------------------------- | --------------------------------- |
| `POST` | `/v1/withdrawals/quote`            | Create `OPEN` quote               |
| `POST` | `/v1/withdrawal-quotes/:id/cancel` | Cancel `OPEN` quote               |
| `POST` | `/v1/withdrawals`                  | Create from quote + reserve       |
| `GET`  | `/v1/withdrawals`                  | List current user's withdrawals   |
| `GET`  | `/v1/withdrawals/:id`              | Get one withdrawal (owner-scoped) |

Owner `decideWithdrawal` is a domain command (Phase 8 Control Center will expose it over
admin channels). Fake pipeline helpers are LOCAL/TEST harness only.

## Migration

`0017_withdrawal_engine_integrity.sql` — quote/withdrawal provenance; fee/limit ACTIVE
overlap EXCLUDE; financial immutability triggers; frozen quotes; attempt intent immutability;
`withdrawal_volume_periods` / reservations; append-only `withdrawal_payout_reconciliations`.

See `docs/LEDGER.md` (Phase 7 accounting), `docs/DATABASE.md`, and
`docs/PHASE_07_ACCEPTANCE_REPORT.md`.
