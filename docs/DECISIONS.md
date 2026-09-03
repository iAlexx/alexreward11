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
