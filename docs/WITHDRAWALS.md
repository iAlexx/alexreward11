# Withdrawal Engine (Phase 7 — Fake Chain)

Phase 7 implements the corrected withdrawal domain against a **deterministic fake payout
chain**. Money movement uses the Phase 4 ledger only. There is **no** real TON broadcast,
signer, KMS, mnemonic, or Jetton transfer in this phase.

Package: `@alex-rewards/withdrawals`. HTTP surface: authenticated Nest routes under `/v1`.
Schema integrity: forward migrations `0017_withdrawal_engine_integrity.sql` and
`0018_membership_plan_entitlement_rule_binding.sql` (do not edit `0001`–`0017` in place).

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

Binding integrity (fail closed):

- `mbr.id = mpe.rule_version_id`
- `mbr.entitlement_id = mpe.entitlement_id`
- `mbr.membership_plan_id IS NULL` (global) **or** `mbr.membership_plan_id = mp.id`

Migration `0018` enforces the same binding with a BEFORE INSERT/UPDATE trigger on
`membership_plan_entitlements`. Cross-bound fee→reward-bonus or cross-plan rules are rejected.

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

`PRIORITY_WITHDRAWAL_REVIEW` (INTERNAL / BOOLEAN catalogue) sets `priority_review` / queue
ordering only. Same binding integrity as fee discount. It does **not** bypass risk, manual
review, security gates, or auto-approve.

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
`withdrawal/{withdrawalId}` — **no synchronous Temporal call** inside the approval DB
transaction. The worker Outbox relay starts Temporal asynchronously.

Reject (definitive pre-broadcast) posts `WITHDRAWAL_RELEASE` for the **full gross once**
(Reserved → Available). Reconcile-origin `HELD` (`held_from_reconcile`) forbids REJECT until
append-only `DEFINITIVE_NONPAYMENT` evidence exists.

## Configuration

Typed keys in `@alex-rewards/config` (API + worker schemas):

| Key                              | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `WITHDRAWAL_QUOTE_TTL_SECONDS`   | Quote TTL                                                        |
| `WITHDRAWAL_RISK_POLICY_VERSION` | Risk policy version                                              |
| `WITHDRAWAL_NETWORK_CODE`        | Accepted network code                                            |
| `WITHDRAWAL_ASSET_SYMBOL`        | Withdrawal asset symbol (e.g. USDT)                              |
| `WITHDRAWAL_FAKE_CHAIN_ENABLED`  | Fake payout chain (LOCAL/TEST only)                              |
| `WITHDRAWAL_REAL_CHAIN_ENABLED`  | Phase 10 real Testnet path (default off)                         |
| `SIGNER_BASE_URL`                | Worker → signer HTTP base (sign only)                            |
| `TON_TESTNET_JETTON_MASTER`      | Owner-approved Testnet Jetton master (required if real chain on) |
| `TON_PRIMARY_PROVIDER_KIND`      | `toncenter` or `tonapi`                                          |
| `TON_PRIMARY_PROVIDER_URL`       | Primary Testnet provider base URL (worker broadcast/observe)     |
| `TON_PRIMARY_PROVIDER_API_KEY`   | Primary provider key (never commit; never expose to frontend)    |
| `TON_SECONDARY_PROVIDER_KIND`    | Independent secondary kind (`toncenter` or `tonapi`)             |
| `TON_SECONDARY_PROVIDER_URL`     | Independent secondary base URL (reconciliation)                  |
| `TON_SECONDARY_PROVIDER_API_KEY` | Secondary provider key (independent; never commit)               |

Local/test may receive documented fixture defaults via loader merge. Staging/production
**fail closed** if keys are missing, if `TON_TESTNET` is inherited, or if fake chain is enabled.
Real chain + empty Jetton master fails closed (Owner must supply the address — never invent).

Asset resolution requires `assets.network_id` = resolved network, matching symbol, `ACTIVE`,
and for USDT `is_native = false`. Zero or multiple matches → fail closed (no `rows[0]`).

## Outbox → Temporal workflow

1. Approval TX: state + Outbox `withdrawal.approved` + commit (no Temporal).
2. Worker relay claims PENDING rows and starts `withdrawalPayoutWorkflow` with
   `workflowId = withdrawal/{withdrawalId}`.
3. Duplicate start (`WorkflowExecutionAlreadyStarted`) recovers the original workflow.
4. Temporal unavailable → Outbox stays retryable; Reserved untouched.
5. Activities run the Phase 7 fake payout pipeline (LOCAL/TEST only) by default. When
   `realChainEnabled` is set and fake chain is off, the workflow calls
   `executeWithdrawalTestnetPayout` (Phase 10 foundation; fail-closed until Owner resources exist).
   Workflow code stays deterministic (no DB/network secrets in history).

## Fake payout adapter

LOCAL/TEST uses `FakePayoutChain` inside Temporal activities (and in-process harness helpers).
Staging/production keep `fakeChainEnabled = false`.

## Phase 10 Testnet broadcast (outside signer)

Broadcast and TON RPC live in the worker / `@alex-rewards/withdrawals` + `@alex-rewards/ton`
path — **never** in `apps/signer`. Pre-broadcast evidence (`signed_external_message_boc`,
signed hash) is persisted before `sendBoc`. Ambiguous submit outcomes set
`broadcast_submitted_at` / `broadcast_ambiguity_class` and forbid blind resend. Confirmation
requires hot wallet + Jetton master + recipient + exact amount + queryId + success + not bounced.
See `docs/PHASE_10_ACCEPTANCE_REPORT.md` for Owner blockers.

## Attempts + dispatch fencing

Each payout attempt stores immutable intent (attempt number, hot wallet, query id, seqno,
canonical message hash, fencing token). Hot-wallet dispatch leases increment a fencing token;
stale fencing cannot dispatch. Duplicate live attempts for the same withdrawal are prevented.

## Possible-broadcast → RECONCILE_REQUIRED

If broadcast **may** have started, the withdrawal moves to `RECONCILE_REQUIRED` (or reconcile-
origin `HELD`). **Reserved is never released** on ambiguity. No blind resend.

## Reconciliation

`withdrawal_payout_reconciliations` is **append-only** (UPDATE/DELETE rejected). Runtime
reconcile uses `reconcileWithdrawalAttemptFromAdapter`: the trusted chain adapter
(`FakePayoutChain` in Phase 7) supplies a branded authoritative observation for the exact
`withdrawalId` + `attemptId`. Callers cannot inject plain `FakePayoutObservation` objects as
financial authority (TypeScript interfaces are not a trust boundary).

DB lookup requires `attempt.id = attemptId AND attempt.withdrawal_id = withdrawalId`.

Before `INTENDED_PAYOUT_PROVEN` or `DEFINITIVE_NONPAYMENT`, the observation must bind to the
exact attempt (withdrawalId, attemptId, queryId, recipient, net atomic, asset, correlation,
canonical message hash). Mismatch → `AMBIGUOUS` (never definitive proof).

### Real-chain reconcile-only (`reconcileRealWithdrawalAttemptOnly`)

Safety classifier only: never signs, broadcasts, settles, rejects, releases Reserved, or
creates attempts. Allowed while `PAYOUT_DISPATCH_PAUSE=true`.

Supported durable outcomes:

| Resolution | When |
| --- | --- |
| `INTENDED_PAYOUT_PROVEN` | Dual-provider COMPLETE TEP-74 match (no confirm/settle in this path) |
| `AMBIGUOUS` | Fail-closed default (including provider disagreement / incomplete evidence) |
| `DEFINITIVE_NONPAYMENT` | **Only** reason `WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO` (below) |

#### `WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO`

Narrowly scoped to verified Wallet V5R1 `auth_signed_external` (`0x7369676e`) requests
built via `@ton/ton` `WalletContractV5R1`. **All** of the following must hold:

1. Exact persisted signed request identity validates (canonical hash, seqno, `valid_until`,
   hashes / Hot Wallet destination where present).
2. Decoded `valid_until` is strictly before the observation clock (`observedAt > valid_until`).
   No invented grace period.
3. TonAPI and TonCenter independently return the same current wallet seqno, and that seqno
   equals the attempt `expected_seqno` (slot unconsumed).
4. No positive payout proof already exists (`INTENDED_PAYOUT_PROVEN`, settlement, confirmation).
5. Dual-provider TEP-74 observation does **not** COMPLETE-match the intended transfer
   (defense-in-depth / conflict detection — **provider “not found” alone is never sufficient**).

If `currentSeqno > expectedSeqno`, this rule **must not** classify nonpayment (forensics
required). If `observedAt <= valid_until`, result stays `AMBIGUOUS`.

Persisting `DEFINITIVE_NONPAYMENT` here does **not** transition the withdrawal, release
Reserved, or queue retry — a separate Owner-authorized domain command is required for any
post-proof financial action.

#### Real-chain DNP hold bridge (`holdReconciledWithdrawalAfterDefinitiveNonpayment`)

Purpose-specific Owner/domain command. Atomic, fail-closed:

```
RECONCILE_REQUIRED
  ↓  durable DEFINITIVE_NONPAYMENT (WALLET_V5R1_EXPIRED_UNCONSUMED_SEQNO)
Owner/domain bridge
  ↓
HELD + held_from_reconcile=true
  ↓  separate Owner decideWithdrawal(REJECT, definitiveNonpayment:true)
REJECTED + WITHDRAWAL_RELEASE
```

The bridge itself performs **zero** ledger posting: Available and Reserved are unchanged.
It does not REJECT, release, approve, queue, sign, broadcast, settle, or create attempts.
Safe while `PAYOUT_DISPATCH_PAUSE=true` / REAL=false / FAKE=false / signer LOCKED.
Idempotent replay of an already-applied successful bridge returns `alreadyApplied` without
a second mutation. Normal Owner `HOLD` (non-reconcile) must not set `held_from_reconcile`.

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
- Phase 8 Control Center / Telegram admin review UI — **delivered** in `@alex-rewards/control-center`
  (see `docs/CONTROL_CENTER.md`); Owner `decideWithdrawal` accepts `decisionSource: 'TELEGRAM'`

## HTTP APIs (authenticated session)

| Method | Path                               | Purpose                           |
| ------ | ---------------------------------- | --------------------------------- |
| `POST` | `/v1/withdrawals/quote`            | Create `OPEN` quote               |
| `POST` | `/v1/withdrawal-quotes/:id/cancel` | Cancel `OPEN` quote               |
| `POST` | `/v1/withdrawals`                  | Create from quote + reserve       |
| `GET`  | `/v1/withdrawals`                  | List current user's withdrawals   |
| `GET`  | `/v1/withdrawals/:id`              | Get one withdrawal (owner-scoped) |

Owner `decideWithdrawal` is exposed to the private Control Center over Telegram action tokens
(`decisionSource: 'TELEGRAM'`, idempotency `aat:{token.id}`). Fake pipeline helpers remain
LOCAL/TEST harness only.

## Migration

`0017_withdrawal_engine_integrity.sql` — quote/withdrawal provenance; fee/limit ACTIVE
overlap EXCLUDE; financial immutability triggers; frozen quotes; attempt intent immutability;
`withdrawal_volume_periods` / reservations; append-only `withdrawal_payout_reconciliations`.

`0018_membership_plan_entitlement_rule_binding.sql` — fail-closed trigger so plan entitlement
mappings cannot point at a benefit rule for a different entitlement or another plan.

See `docs/LEDGER.md` (Phase 7 accounting), `docs/DATABASE.md`, and
`docs/PHASE_07_ACCEPTANCE_REPORT.md`.

## Phase 21 Mainnet micro-launch foundation (Step 1)

Phase 10 Testnet payout config remains unchanged and continues to refuse Mainnet.

Phase 21 adds an explicit Mainnet layer (`packages/withdrawals/src/phase21-*.ts`):

- Network: `TON_MAINNET` / `-239` only when `phase21MainnetEnabled=true`
- Manual approval only; auto payout / auto unpause / auto resend forbidden
- Jetton master must be Owner-supplied (`TON_MAINNET_USDT_JETTON_MASTER`); no placeholders
- Expansion gate: 50 confirmed+reconciled+ledger_ok; never automatic expansion
- CLI: `pnpm phase21:readiness` / `pnpm phase21:preflight` (expect BLOCKED in Step 1)

Worker schema still refuses MAINNET `WITHDRAWAL_NETWORK_CODE` until a later step wires
live Phase 21 dispatch. No real Mainnet payout in Step 1.


## Phase 21 Step 2

Worker supports explicit PHASE21_MAINNET_ENABLED selection (default OFF). Real payout pipeline accepts Phase10 or Phase21 network binding. Mainnet transfer policy: BLOCKED_OWNER_DECISION_MAINNET_TRANSFER_GAS_POLICY until Owner approves.

## Phase 21 Step 3

Forward GRAM gas policy Owner-approved at 1 nanogram; attached GRAM lifecycle remains ESTIMATED (not activated). Controlled Mainnet Available provision tooling status: `SOURCE_IMPLEMENTED_OWNER_APPROVED_BUT_NOT_EXECUTED` (SUPPORT_ADJUSTMENT; ceiling 10_000_000 atomic USDT; disabled). Readiness may reach `READY_FOR_OWNER_PROVISIONING_CEREMONY`; `READY_FOR_LIVE_PAYOUT=NO`. No live Mainnet payout in Step 3.
