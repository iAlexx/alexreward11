# Architecture

ALEx Rewards begins as a modular monolith split into explicit deployable boundaries: Mini App,
Admin, API, Telegram Bot, Temporal Worker, and isolated Signer. Shared packages may be imported
by applications; applications may never import one another.

Phase 1 establishes those boundaries and platform dependencies only. PostgreSQL, Redis, and
Temporal are independent runtime dependencies.

Phase 9 activates the Signer spike boundary: `@alex-rewards/signing` reconstructs Wallet V5 R1 /
TEP-74 intent; `apps/signer` is the only process with usable Hot Wallet private signing capability
after unlock of a self-hosted encrypted Ed25519 bundle (`FALLBACK_ENCRYPTED`). AWS KMS is
historical evidence only (Owner rejected AWS production custody). Signer has no public ingress,
no financial DB writes, and no TON broadcast. Production gate: formally reviewed,
Testnet-validated self-hosted encrypted signer — not an AWS KMS spike.

Phase 10 adds the **Testnet payout foundation outside the signer**: provider-neutral
`@alex-rewards/ton` chain port, pre-broadcast BOC evidence on attempts, worker-side broadcast gate
(no blind resend), and Jetton confirmation matching. Signer may return signed external-message BOC
but still must not call TON RPC or broadcast. Real chain stays fail-closed until Owner supplies
Testnet Jetton master + providers (`docs/PHASE_10_ACCEPTANCE_REPORT.md`).

Phase 11 adds the **advertising provider plugin boundary**: `@alex-rewards/ads` owns ad session
evidence, derived session state and the provider-neutral monetary eligibility gate. Providers are
plugins behind one contract (`RewardedAdProvider`) listed in a **compile-time** registry — nothing
is loaded dynamically, so the set of providers that can ever touch money is fixed at build time.
The package composes transactions through `@alex-rewards/rewards` and must never import
`@alex-rewards/ledger` or post a ledger transaction; that boundary is asserted against the source
on disk by `packages/ads/test/phase11-boundaries.test.ts` as well as by the CI architecture check.
Provider SDKs stay out of the domain: `@adsgram/react` lives in `apps/miniapp`, and `packages/ads`
exports only the client signal data contract (`docs/ADS_SPEC.md`).

Readiness means a process can serve its intended current-phase role. Liveness means its event
loop and HTTP server are responsive. Dependency-aware services expose component status without
putting secrets in responses.
