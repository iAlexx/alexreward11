# Phase 19 — Attack Surface Inventory (Step 2A)

## Primary HTTP surfaces

| Surface | Guard | Notes |
| --- | --- | --- |
| `POST /v1/membership/founder/claim` | AccessSessionGuard | Body claimCode only; session userId authority |
| `POST /v1/admin/memberships/founder/grant` | AdminSessionGuard | CSRF + gate + confirmation |
| `POST /v1/admin/memberships/claim-codes/issue` | AdminSessionGuard | CSRF + gate + **consumed confirmation** (P19-SEC-001 RESOLVED) |
| `POST /v1/admin/policy/change` | AdminSessionGuard | FEATURE_FLAGS / PROVIDER_LIMITS / REWARD_RULES / BENEFIT_RULES / WITHDRAWAL_LIMITS → `applied=false` |
| `POST /v1/admin/feature-flags` | AdminSessionGuard | Sole web FEATURE_FLAGS mutation authority |
| `POST /v1/admin/review-queue/:id/actions` | AdminSessionGuard | ASSIGN/COMMENT/ESCALATE only; RESOLVE_AFTER_DOMAIN removed from public union |
| `GET /webhooks/adsgram/reward` | Unauthenticated (provider design) | Uniform accepted; rewardCredited false |
| `POST /v1/ads/*` | AccessSessionGuard | Client authority fields refused |
| Mission claim `POST .../tasks/.../claim` | AccessSessionGuard | NEW claims refuse DRAFT/REVOKED versions; issuance also refuse DRAFT/REVOKED |

## Domain packages

- `packages/auth` — membership claim/grant/entitlements
- `packages/control-center` — Founder admin, Review Queue, authorize
- `packages/ads` — sessions, limits, AdsGram adapter/webhook
- `packages/tasks` / `packages/rewards` — mission claim/issue (DRAFT/REVOKED fail-closed)
- `packages/notifications` — stub / draft-only Admin
- `packages/withdrawals` — pause flag fail-closed for STAGING/PRODUCTION when missing

## Dependency attack surface (open)

- Next.js 16.3.4 ImageResponse RCE (P19-SEC-019)
- `@nestjs/platform-fastify` 12.0.1 middleware bypass (P19-SEC-020)
- `@grpc/grpc-js` 1.14.4 Temporal path (P19-SEC-021)
- `fast-uri` 4.1.3 via Fastify runtime (P19-SEC-022)
- Fastify itself pinned to 5.12.2 (P19-SEC-018 RESOLVED)

## Out of scope for Phase 19 live attack

AdsGram third-party, Railway/Vercel, Mainnet, signer unlock, TON broadcast, operational DB mutation,
live STAGING `PAYOUT_DISPATCH_PAUSE` changes.
