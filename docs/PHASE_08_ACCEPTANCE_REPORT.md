# Phase 8 Acceptance Report — Control Center + Unified Review Queue

**Status:** RUNTIME IMPLEMENTATION READY — CI/archive seal pending after push.

**Date:** 2026-09-09

**Authority:** `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md`

**Start tip:** `c452e1d138c30c7406402b5505edb7dc90ebdf46` (Phase 7 companion only)

**Phase 7 accepted runtime (do not reopen):** `3d4f57bc4b94b04911a59504e51b4ccd43655a26`

---

## A. Phase objective

Deliver the private Telegram Admin Control Center and Unified Review Queue as operational
projection/control surfaces over existing domain authority — secure Owner action tokens,
all 11 Forum Topics, withdrawal review via Phase 7 `decideWithdrawal`, Founder search/grant/
claim-code issuance with zero ledger mutation — without starting Phase 9.

## B. Exact scope delivered

- Migration `0019_control_center_security_integrity.sql` (Audit/System purposes; action-token
  expected_state / destination / chat / topic / nonce / confirmation parent; OWNER permissions)
- Package `@alex-rewards/control-center` (authorize, action-tokens, destinations, publications,
  review-queue, withdrawal-actions, founder-admin, topics, callback)
- Auth domain: `grantFounderMembership`, `issueFounderClaimCode`, `searchFounderMember`,
  `getFounderHistory`, `reassignFounderMembership` (unavailable)
- Bot wiring: opaque callback → `handleControlCenterCallback` → domain commands
- Typed bot Control Center + withdrawal engine config (fail-closed outside local/test)
- `pnpm test:phase8` + CI quality gate
- Docs: `CONTROL_CENTER.md`, `REVIEW_QUEUE.md`, SECURITY/DATABASE/migrations updates

## C. Files/modules changed

Primary:

- `migrations/0019_control_center_security_integrity.sql`
- `packages/control-center/**`
- `packages/auth/src/membership.ts`, `packages/auth/src/index.ts`
- `packages/config/src/index.ts`
- `packages/withdrawals/src/decide.ts` (`decisionSource: TELEGRAM`)
- `apps/bot/src/main.ts`, `apps/bot/package.json`
- `scripts/verify-boundaries.mjs`
- `package.json`, `.github/workflows/ci.yaml`, `pnpm-lock.yaml`
- Docs listed above

Migrations `0001`–`0018`: **byte-identical / unchanged**.

## D. Database migrations

| Migration                                    | Role                           |
| -------------------------------------------- | ------------------------------ |
| `0019_control_center_security_integrity.sql` | Forward-only Phase 8 integrity |

No in-place edits to `0001`–`0018`.

## E. Commands executed (local)

```bash
pnpm install
pnpm validate:migrations
pnpm verify:boundaries
pnpm --filter @alex-rewards/control-center run typecheck
pnpm --filter @alex-rewards/{auth,bot,config} run typecheck
PHASE8_DATABASE_URL=... pnpm test:phase8   # 38/38
pnpm format
```

## F. Test evidence

Official `pnpm test:phase8` = **38/38** (local Postgres):

| Suite                        | Focus                                                                       |
| ---------------------------- | --------------------------------------------------------------------------- |
| `phase8-migration`           | 0019 / Audit+System / token bindings / OWNER permissions                    |
| `phase8-action-tokens`       | Owner allowlist, wrong chat/topic, expire/consume, 100× duplicate           |
| `phase8-withdrawal-telegram` | APPROVE via `decideWithdrawal`, unauthorized, stale state, one Outbox       |
| `phase8-review-queue`        | All case types, assign/comment/escalate, no false resolve                   |
| `phase8-founder-admin`       | Grant 50 USD catalogue, claim hash-at-rest, races, reassignment unavailable |
| `phase8-topics-publications` | 11 topics, publication dedupe, retry, rate-limit                            |
| `phase8-config`              | Fail-closed Owner/DB/TTL                                                    |
| `phase8-boundary`            | No ledger/TON/KMS imports in src                                            |

## G. Build/health

Package/typecheck for control-center, auth, bot, config: PASS (local).

## H. CI

Pending push of accepted runtime commit. Fill after GitHub Actions:

- Run URL:
- quality job/result:
- docker-smoke job/result:

## I. Known deviations

- Official Phase 8 suite is **38** tests (condensed matrices covering mandatory gates). Additional
  concurrent stress beyond existing 100× token consume / grant races can be expanded later without
  changing product authority.
- Daily report / Ads / Wallet topic **metrics** render only when authoritative data exists; Phase 8
  provides routing + publication infrastructure rather than fabricating provider metrics.
- Founder reassignment mutation intentionally unavailable (no Telegram Owner reauthentication).

## J. Open blockers / technical debt

- Production Owner Telegram IDs and Control Center destination rows must be configured explicitly
  (never seeded in source).
- Second-confirmation framework columns exist; high-impact domain actions beyond Phase 8 scope
  remain unimplemented by design.

## K. Security / domain invariants

- Group membership ≠ authorization
- Opaque callbacks only; no trusted money/state in `callback_data`
- Action tokens: hash-at-rest, expected-state + chat/topic binding, one-time consume after domain success protocol
- Withdrawal decisions → Phase 7 `decideWithdrawal` only
- No Telegram fabricate of reconciliation evidence
- Founder grant/claim: zero ledger / reward / balance mutation
- Redis not used as authority
- Review queue is projection only

## L. Rollback / recovery

- Roll forward: disable bot transport / destinations `enabled=false`
- Schema: do not edit `0019` in place; add a forward migration if correction required
- Stale Telegram buttons fail closed (`Already processed` / `STATE_CHANGED`)

## M. Exact accepted SHA

Pending CI-green runtime commit (to be recorded here after quality + docker-smoke PASS).

## N. PASS/FAIL Phase 8 gates

| Gate                                           | Local          | CI      |
| ---------------------------------------------- | -------------- | ------- |
| 11 topics supported                            | PASS           | pending |
| No hardcoded prod chat/topic IDs               | PASS           | pending |
| Unauthorized Telegram cannot act               | PASS           | pending |
| Wrong chat/topic/token/resource/state rejected | PASS           | pending |
| One-time DB-authoritative action tokens        | PASS           | pending |
| Duplicate approve → one Outbox/workflow        | PASS           | pending |
| Review queue projection only                   | PASS           | pending |
| Withdrawal → `decideWithdrawal`                | PASS           | pending |
| Unsupported future-domain = unavailable        | PASS           | pending |
| Founder search/grant/claim/history             | PASS           | pending |
| Grant/claim cannot duplicate Founder           | PASS           | pending |
| Claim secret hash-at-rest                      | PASS           | pending |
| Reassignment mutation unavailable              | PASS           | pending |
| Zero Founder ledger mutation                   | PASS           | pending |
| Migrations 0001–0018 unchanged                 | PASS           | pending |
| No Phase 9 work                                | PASS           | pending |
| `pnpm test:phase8`                             | **38/38 PASS** | pending |
| quality / docker-smoke                         | pending        | pending |

## O. Archive verification

Complete **after** CI-green accepted commit and dual archive packaging.

- Accepted Phase 8 commit:
- Canonical source ZIP SHA256:
- Review package filename/path:
- PACKAGE SHA256:
- Extraction / prohibited-path / checksum / four-member / forward-slash checks:
- Migrations 0001–0018 unchanged confirmation:
- Explicit: **No Phase 9 work started.**

---

## Locked decisions

- Package: `@alex-rewards/control-center`
- Reports → `CONTROL_CENTER_DAILY_REPORT`
- Reassignment mutation: UNAVAILABLE
- Future-domain review actions: review-only
