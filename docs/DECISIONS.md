# Implementation decisions

## ADR-001 — Phase 1 package shells

All shared packages named by v1.1 exist from the start. Business-domain packages export no
behavior in Phase 1, preventing temporary financial logic from surviving into later phases.

## ADR-002 — Runtime health servers

API uses NestJS 12 with Fastify. Bot, Worker, and Signer use Fastify directly because they are
independent processes rather than API modules. This preserves deployable boundaries without
pretending they are microservices with business APIs.

## ADR-003 — Local Telegram mode

The Bot supports an explicit `disabled` local transport mode so a new engineer can boot the stack
without a production or test Bot token. Polling/webhook modes fail fast unless a token is supplied.

## ADR-004 — Phase 1 Signer prohibition

The Signer exposes health endpoints only. Any KMS-key environment variable is rejected, and CI
forbids KMS imports outside `apps/signer` for the later implementation.

## ADR-005 — Version 1.2 adoption as source of truth

On 2026-09-08 the Owner adopted
`docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md` as the
active source of truth. Version 1.2 preserves the Version 1.1 financial, security, payout,
ledger, fraud, reconciliation, signer, and provider-safety baseline and adds product/platform
expansion architecture (membership/entitlements, provider limits/adapters, policy center,
eligibility/trust, economics, review queue, mission engine, phase archives).

No `OWNER_DECISION_REQUIRED`, `PROPOSED_DEFAULT`, or otherwise undecided production economic or
policy value was invented during this adoption. Existing Phase 1 foundation code is retained;
Version 1.2 does not authorize rebuilding correct Phase 1 work. Phase 2 must not begin until
Phase 0/Phase 1 archive gates pass and the Owner explicitly approves.

## ADR-006 — Dual phase-archive review package

Every accepted phase must produce both a deterministic canonical source ZIP (`git archive` of
the exact accepted commit) and a final Owner review-package ZIP containing that source ZIP plus
acceptance report, `MANIFEST.md`, and `SHA256SUMS.txt`, with `PACKAGE_SHA256.txt` beside the
outer package. Outer ZIP entry names use forward slashes. Acceptance report Section O must not
embed the outer package hash. Changing the outer review-package format does not invalidate sealed
canonical source ZIPs. Helper: `scripts/create-phase-archive.mjs`. Docs: `docs/PHASE_ARCHIVE.md`.

## ADR-007 — V1.2 locked initial economic values vs OWNER_DECISION_REQUIRED

Version 1.2 already locks certain **initial** production values. Those values remain authoritative
and must not be treated as undefined `OWNER_DECISION_REQUIRED` placeholders. Locked examples
include: minimum withdrawal 0.20 USDT gross; initial fixed platform withdrawal fee 0.01 USDT;
maximum single withdrawal 5 USDT gross; per-user hourly withdrawal 5 USDT gross; per-user daily
withdrawal 10 USDT gross / UTC day; Hot Wallet hourly payout volume 25 USDT gross; Hot Wallet
daily payout volume 100 USDT gross / UTC day; current AdsGram provider safety request limit of
maximum 30 requests/user/day; Founder Lifetime catalogue price 50 USD one-time.

Phase 2 does not seed production reward/payout rule rows. Locked V1.2 initials are instantiated
and versioned by their owning implementation phase. The AdsGram 30-request/user/day safety limit
remains the current provider hard/safety basis until approved evidence changes it. Changing a
provider limit such as 30 → 100 later creates a new approved `provider_limit_rules` version and
does not require application-code changes. Founder catalogue price remains 50 USD one-time;
Founder reward bonus remains configurable/proposed and must not be treated as guaranteed.

Values explicitly marked `OWNER_DECISION_REQUIRED` or proposed in V1.2 (including unset final
reward economics/share/eCPM/safety-factor/budgets, Founder bonus launch value/caps, unlocked
referral/mission values, and new-provider limits without an approved contract/documentation
source) remain unset until Owner approval.

## ADR-008 — Phase 3 Bearer session transport

Phase 3 uses short-lived Bearer access JWTs plus opaque refresh tokens persisted only as
hashes in PostgreSQL. Production cookie names, domains, SameSite, and CSRF topology remain
environment-specific and are not invented here. CORS is an explicit allowlist (`CORS_ORIGINS`);
an empty list disables browser cross-origin calls.

## ADR-009 — Unresolved ledger account classifications stay blocked

V1.2 requires an explicit accounting decision before production reporting for
`TREASURY_FUNDING_CLEARING`. Phase 4 therefore supports the enum/account type in the
catalogue but refuses silent get-or-create provision (`OWNER_DECISION_REQUIRED`) unless a
later Owner decision documents production class/side. The same fail-closed stance applies to
`INVALID_TRAFFIC_RECOVERY` until recognition policy is approved. No speculative production
classification is invented in Phase 4.

## ADR-010 — Projection chronology without a posting sequence column

Phase 5 will compose multiple ledger posts inside one outer PostgreSQL transaction. Those posts
can share identical `posted_at` values, so ordering by `posted_at` then UUID/`entry_index` is not
durable financial chronology and produced false CRITICAL last-pointer mismatches.

Decision: **Option 1 — no schema migration.**

- `balance_atomic` rebuilds exactly from immutable entries.
- `version` means the count of DISTINCT ledger transactions that touched the account.
- `last_ledger_transaction_id` is validated as: null iff no history; otherwise must touch the
  account and belong to the latest `posted_at` cohort (tie-aware; UUID order is not used).

A monotonic posting sequence (`0013`) is deferred until an Owner-approved requirement needs a
total order beyond what `posted_at` cohorts + the posting engine’s stored pointer already provide.

## ADR-011 — Linked reversals only via guarded posting path

`PostLedgerCommand` no longer accepts `reversesTransactionId`. Linked reversals are created only
through `reverseLedgerTransaction` → `postLedgerTransactionWithReversalLink`, which enforces an
order-safe exact economic reversal multiset **before** insert so malformed linked attempts cannot
consume the one-reversal unique slot.

## ADR-012 — Reward rule family, immutability, and migration 0013

Phase 5 treats `reward_rules.code` as the logical rule **family**. At most one `ACTIVE` validity
window may exist per `code` (PostgreSQL `EXCLUDE` on `tstzrange(valid_from, valid_to)`). Application
`resolveRewardRule` still fails closed if zero or more than one `ACTIVE` row matches the resolution
context (source_type / provider / country / asset), because multiple families could otherwise match.

Financially authoritative fields on `reward_rules`, `membership_benefit_rule_versions`, and
`economic_exposure_limits` are immutable in place (0013 triggers). Approved lifecycle supersession
is allowed (status / `valid_to` / `effective_to` / reason / `updated_at` as applicable). Overlapping
`ACTIVE` windows fail closed via `EXCLUDE`.

Quote reconstruction requires frozen `reward_quotes.applied_economics`, plus `source_started_at`
and explicit `bonus_unavailable_policy` when bonus evaluation is in scope.

## ADR-013 — Membership bonus FLOOR formula (interim)

Until an Owner locks a different production formula, membership bonus amount is:

```text
FLOOR(base_amount_atomic * bonus_bps / 10000)
```

using the post-clamp quoted base. A zero result after `FLOOR` is treated as **no bonus** (amount 0),
not an error. Base and bonus remain separately reserved, posted, and audited.

## ADR-014 — Membership bonus unavailable policies

When membership bonus evaluation is in scope, an explicit pre-start policy is mandatory
(`BASE_REWARD_ONLY` | `BLOCK_QUOTE_BEFORE_START`). Missing policy fails closed.

- `BASE_REWARD_ONLY` — quote/issue the base reward; omit bonus reservation/issuance when bonus
  cannot be honored (pause, missing entitlement/budget, exhausted caps, zero after FLOOR).
  Only recognized economic unavailability may downgrade; arbitrary DB/internal errors must not.
- `BLOCK_QUOTE_BEFORE_START` — refuse quote creation when bonus cannot be fully reserved/honored
  before source start. Never silently drop a promised bonus after a valid start. No surviving
  quote/reservation state on failure.

## ADR-015 — Phase 5 financial correction migration 0014

Independent review found runtime gaps after the first Phase 5 archive (`a7da07d…`). Correction
requires forward migration `0014_phase5_financial_corrections.sql` (do not edit `0001`–`0013`):

1. `simulated_reward_sources` — DB-authoritative simulated PROMOTION identities (Outbox alone is
   insufficient).
2. `reward_quotes` financial snapshot trigger — reject in-place mutation of money/identity/
   `applied_economics`; allow narrow lifecycle; `source_started_at` NULL→timestamp once.
3. Multi-period membership bonus reservations — drop single-quote unique; unique
   `(reward_quote_id, budget_period_id)` so daily/monthly/plan/user/global caps reserve together.
4. `economic_exposure_periods` + `economic_exposure_reservations` — concurrency-safe, time-scoped
   exposure authorization under PostgreSQL locks. Redis has zero financial authority.

`MIN_EXPECTED_MARGIN_BPS` when ACTIVE fails closed (`MARGIN_POLICY_UNDEFINED`) until an
Owner-approved expected-margin formula exists. Do not treat `10000 - user_share_bps` as margin.

## ADR-016 — Wallet proof nonce invalidation lifecycle (migration 0016)

V1.2 §29 requires pending old-wallet challenges to be invalidated when the primary wallet changes.
`user_wallet_proof_nonces.consumed_at` alone cannot distinguish successful **CONSUMED** from
**SECURITY_INVALIDATED** without corrupting audit semantics.

Phase 6 therefore adds forward migration `0016_wallet_proof_nonce_lifecycle.sql` (do not edit
`0001`–`0015`) with:

- `invalidated_at` / `invalidation_reason` (e.g. `PRIMARY_WALLET_CHANGED`);
- exclusive terminal CHECK: not both consumed and invalidated;
- open-index predicate: `consumed_at IS NULL AND invalidated_at IS NULL`.

Domain authority for `ton_proof` remains server config (`expectedTonProofDomain`), never request
Host/Origin. Staging/production reject localhost domain inheritance.

## ADR-017 — Phase 7 Outbox → Temporal withdrawal payout (fake activities LOCAL/TEST)

Phase 7 requires Outbox-started payout work with deterministic workflow ID
`withdrawal/{withdrawalId}`.

Decision:

1. **Approval transaction** writes withdrawal APPROVED + `withdrawal.approved` Outbox row and
   commits. There is **no** Temporal call inside that DB transaction.
2. **Outbox relay** (worker) claims PENDING `withdrawal.approved` rows and starts Temporal workflow
   `withdrawalPayoutWorkflow` with `workflowId = withdrawal/{withdrawalId}`.
   `WorkflowExecutionAlreadyStarted` is treated as recovery of the original workflow (mark Outbox
   DISPATCHED); Temporal unavailable leaves Outbox PENDING/retryable with Reserved untouched.
3. **Workflow code is deterministic**; PostgreSQL/network/domain mutation lives in Activities.
4. Activities call the **FakePayoutChain** pipeline for LOCAL/TEST only
   (`WITHDRAWAL_FAKE_CHAIN_ENABLED`). Staging/production keep fake chain disabled (fail closed).
   Real TON/signer/KMS remains Phase 9/10.

In-process `runFakePayoutPipeline` remains available for unit/integration tests that do not need a
full Temporal env; official Phase 7 Temporal gates use `@temporalio/testing`.
