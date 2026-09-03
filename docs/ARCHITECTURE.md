# Architecture

ALEx Rewards begins as a modular monolith split into explicit deployable boundaries: Mini App,
Admin, API, Telegram Bot, Temporal Worker, and isolated Signer. Shared packages may be imported
by applications; applications may never import one another.

Phase 1 establishes those boundaries and platform dependencies only. PostgreSQL, Redis, and
Temporal are independent runtime dependencies. The Signer has no KMS dependency, signing route,
or production key configuration in this phase.

Readiness means a process can serve its intended current-phase role. Liveness means its event
loop and HTTP server are responsive. Dependency-aware services expose component status without
putting secrets in responses.
