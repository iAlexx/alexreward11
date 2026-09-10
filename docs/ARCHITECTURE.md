# Architecture

ALEx Rewards begins as a modular monolith split into explicit deployable boundaries: Mini App,
Admin, API, Telegram Bot, Temporal Worker, and isolated Signer. Shared packages may be imported
by applications; applications may never import one another.

Phase 1 establishes those boundaries and platform dependencies only. PostgreSQL, Redis, and
Temporal are independent runtime dependencies.

Phase 9 activates the Signer spike boundary: `@alex-rewards/signing` reconstructs Wallet V5 R1 /
TEP-74 intent; only `apps/signer` may call AWS KMS (`ED25519_SHA_512` + `MessageType=RAW` on the
32-byte Cell hash). Signer has no public ingress, no financial DB writes, and no TON broadcast
(Phase 10). Formal acceptance additionally requires a real `ECC_NIST_EDWARDS25519` spike run.

Readiness means a process can serve its intended current-phase role. Liveness means its event
loop and HTTP server are responsive. Dependency-aware services expose component status without
putting secrets in responses.
