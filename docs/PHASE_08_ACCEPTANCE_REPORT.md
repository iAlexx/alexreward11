# Phase 8 Acceptance Report — Control Center + Unified Review Queue

**Status:** ACCEPTED RUNTIME — CI quality + docker-smoke PASS on tip below.

**Date:** 2026-09-09

**Authority:** `docs/ALEx_Rewards_Master_Product_Financial_Security_Engineering_Specification_v1.2.md`

**Start tip:** `c452e1d138c30c7406402b5505edb7dc90ebdf46` (Phase 7 companion only)

**Phase 7 accepted runtime (do not reopen):** `3d4f57bc4b94b04911a59504e51b4ccd43655a26`

**Accepted Phase 8 runtime SHA:** `a7554474b8b5ee22a3323a221d00bb1714d88ff7`

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

- Run URL: https://github.com/iAlexx/alexreward11/actions/runs/34388095264
- quality job `102589368462`: **PASS**
- docker-smoke job `102590824379`: **PASS**
- Accepted tip: `a7554474b8b5ee22a3323a221d00bb1714d88ff7`
  (Phase 8 runtime `876d04d` + ESLint fix `15c1516` + Phase 2 count for 0019)

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

`a7554474b8b5ee22a3323a221d00bb1714d88ff7`

## N. PASS/FAIL Phase 8 gates

| Gate                                           | Local          | CI   |
| ---------------------------------------------- | -------------- | ---- |
| 11 topics supported                            | PASS           | PASS |
| No hardcoded prod chat/topic IDs               | PASS           | PASS |
| Unauthorized Telegram cannot act               | PASS           | PASS |
| Wrong chat/topic/token/resource/state rejected | PASS           | PASS |
| One-time DB-authoritative action tokens        | PASS           | PASS |
| Duplicate approve → one Outbox/workflow        | PASS           | PASS |
| Review queue projection only                   | PASS           | PASS |
| Withdrawal → `decideWithdrawal`                | PASS           | PASS |
| Unsupported future-domain = unavailable        | PASS           | PASS |
| Founder search/grant/claim/history             | PASS           | PASS |
| Grant/claim cannot duplicate Founder           | PASS           | PASS |
| Claim secret hash-at-rest                      | PASS           | PASS |
| Reassignment mutation unavailable              | PASS           | PASS |
| Zero Founder ledger mutation                   | PASS           | PASS |
| Migrations 0001–0018 unchanged                 | PASS           | PASS |
| No Phase 9 work                                | PASS           | PASS |
| `pnpm test:phase8`                             | **38/38 PASS** | PASS |
| quality / docker-smoke                         | PASS           | PASS |

## O. Archive verification

Section O is filled after packaging. The authoritative final outer review-package
SHA256 is recorded only in external `PACKAGE_SHA256.txt` beside the package (not
embedded here — embedding an outer archive hash inside that same archive would
create a self-reference problem).

| Item | Result |
| --- | --- |
| Accepted runtime SHA | `a7554474b8b5ee22a3323a221d00bb1714d88ff7` |
| CI run | https://github.com/iAlexx/alexreward11/actions/runs/34388095264 |
| quality job | `102589368462` — PASS |
| docker-smoke job | `102590824379` — PASS |
| Phase 8 dedicated gate | 38 / 38 PASS |
| Canonical source ZIP | `ALEx_Rewards_PHASE_08_CONTROL_CENTER_REVIEW_QUEUE_20260909-182600_a755447.zip` |
| Canonical source SHA256 | `86bd1fac544330fa08ec8de40ac51f577eda1c6c116d149ad6b3af9d383772fe` |
| Final review-package ZIP | `PHASE_08_CONTROL_CENTER_REVIEW_QUEUE_PACKAGE_20260909-232806_a755447.zip` |
| Final review-package path | `phase-archives/PHASE_08_CONTROL_CENTER_REVIEW_QUEUE/PHASE_08_CONTROL_CENTER_REVIEW_QUEUE_PACKAGE_20260909-232806_a755447.zip` |
| Canonical source extraction | PASS |
| Canonical source prohibited-path scan | PASS |
| Review-package extraction | PASS |
| Review-package prohibited-path scan | PASS |
| Nested canonical source identity | PASS |
| SHA256SUMS verification | PASS |
| ZIP entry separator / forward-slash validation | PASS |
| Exactly four outer members | PASS |
| External `PACKAGE_SHA256.txt` | Authoritative outer hash beside the package (not embedded in this report) |
| Migrations 0001–0018 unchanged | YES (only forward `0019_control_center_security_integrity.sql`) |

Verified with `scripts/create-phase-archive.mjs` v2.1.0 (corrected outer stamp `20260909-232806`; canonical source stamp `20260909-182600` unchanged).

**No Phase 9 work started.**

---

## Locked decisions

- Package: `@alex-rewards/control-center`
- Reports → `CONTROL_CENTER_DAILY_REPORT`
- Reassignment mutation: UNAVAILABLE
- Future-domain review actions: review-only
