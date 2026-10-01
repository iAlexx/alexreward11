# Phase 19 — Attack Surface Inventory (Step 2A)

## Primary HTTP surfaces

| Surface | Guard | Notes |
| --- | --- | --- |
| `POST /v1/membership/founder/claim` | AccessSessionGuard | Body claimCode only; session userId authority |
| `POST /v1/admin/memberships/founder/grant` | AdminSessionGuard | CSRF + gate + confirmation |
| `POST /v1/admin/memberships/claim-codes/issue` | AdminSessionGuard | CSRF + gate + consumed confirmation (DB proofs Step 2B) |
| `POST /v1/admin/policy/change` | AdminSessionGuard | FEATURE_FLAGS → applied=false (DB proof Step 2B) |
| `POST /v1/admin/feature-flags` | AdminSessionGuard | Sole web FEATURE_FLAGS mutation authority |
| `POST /v1/admin/review-queue/:id/actions` | AdminSessionGuard | ASSIGN/COMMENT/ESCALATE only |
| `GET /webhooks/adsgram/reward` | Unauthenticated (provider design) | Uniform accepted; rewardCredited false |
| `POST /v1/ads/*` | AccessSessionGuard | Client authority fields refused |
| Mission claim `POST .../tasks/.../claim` | AccessSessionGuard | NEW claims refuse DRAFT/REVOKED; issuance refuse DRAFT/REVOKED |

## Domain packages

- `packages/auth` — membership claim/grant/entitlements
- `packages/control-center` — Founder admin, Review Queue, authorize
- `packages/ads` — sessions, limits, AdsGram adapter/webhook
- `packages/tasks` / `packages/rewards` — mission claim/issue (DRAFT/REVOKED fail-closed)
- `packages/notifications` — stub / draft-only Admin
- `packages/withdrawals` — pause flag fail-closed for STAGING/PRODUCTION when missing

## Dependency attack surface (Step 2B)

- Next.js **16.3.6** (P19-SEC-019 RESOLVED; no ImageResponse usage observed)
- `@nestjs/platform-fastify` **12.0.3** (P19-SEC-020 RESOLVED; no MiddlewareConsumer observed)
- `@grpc/grpc-js` **1.14.5** via Temporal (P19-SEC-021 RESOLVED; address-only Temporal connect)
- `fast-uri` **4.1.4** runtime / **3.1.7** build-dev (P19-SEC-022 RESOLVED)
- Fastify **5.12.2** (P19-SEC-018 RESOLVED)
- Remaining audit High: `brace-expansion` (eslint build/dev + otel transitive nested-brace DoS path not used) — build/dev or unused path; not production-reachable Mainnet blockers

## Out of scope for Phase 19 live attack

AdsGram third-party, Railway/Vercel, Mainnet, signer unlock, TON broadcast, operational DB mutation,
live STAGING `PAYOUT_DISPATCH_PAUSE` changes.
