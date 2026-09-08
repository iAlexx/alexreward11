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
