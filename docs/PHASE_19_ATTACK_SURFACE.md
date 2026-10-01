# Phase 19 — Attack Surface Inventory (Step 1)

## Primary HTTP surfaces

| Surface | Guard | Notes |
| --- | --- | --- |
| `POST /v1/membership/founder/claim` | AccessSessionGuard | Body claimCode only; session userId authority |
| `POST /v1/admin/memberships/founder/grant` | AdminSessionGuard | CSRF + gate + confirmation |
| `POST /v1/admin/memberships/claim-codes/issue` | AdminSessionGuard | CSRF + gate; **no confirmation** (P19-SEC-001) |
| `POST /v1/admin/policy/change` | AdminSessionGuard | FEATURE_FLAGS applied (P19-SEC-009); other families applied=false |
| `POST /v1/admin/feature-flags` | AdminSessionGuard | Full version/audit/silent-flip stack |
| `POST /v1/admin/review-queue/:id/actions` | AdminSessionGuard | RESOLVE_AFTER_DOMAIN invents domainSucceeded (P19-SEC-017) |
| `GET /webhooks/adsgram/reward` | Unauthenticated (provider design) | Uniform accepted; rewardCredited false |
| `POST /v1/ads/*` | AccessSessionGuard | Client authority fields refused |
| Mission claim `POST .../tasks/.../claim` | AccessSessionGuard | progressId path; session user |

## Domain packages

- `packages/auth` — membership claim/grant/entitlements
- `packages/control-center` — Founder admin, Review Queue, authorize
- `packages/ads` — sessions, limits, AdsGram adapter/webhook
- `packages/tasks` / `packages/rewards` — mission claim/issue
- `packages/notifications` — stub / draft-only Admin
- `packages/withdrawals` — pause flag + entitlements

## Out of scope for Step 1 live attack

AdsGram third-party, Railway/Vercel, Mainnet, signer unlock, TON broadcast, operational DB mutation.
