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
