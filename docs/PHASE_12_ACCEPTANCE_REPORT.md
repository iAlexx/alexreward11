# Phase 12 Acceptance Report — User Mini App UI + Founder Experience

**Status:** **PASS**

**Phase slug:** `PHASE_12_MINIAPP_UI_FOUNDER`  
**Master specification:** Version 1.3  
**Accepted commit:** _(see Section M)_  

**AdsGram production monetary status:** **BLOCKED**  
**AdsGram clarification gate:** **NO** (unchanged; UI cannot flip this)  
**Phase 10:** CLOSED / COMPLETED 100/100 — archive hash unchanged  
**Phase 11:** COMPLETE + dual-archived — package SHA unchanged  
`82b52bc1dacc93aa6ca046ff1d41282b68ad4e4431f3eed01c7d206ee410e7ef`  
**Phase 13:** **NOT STARTED**

---

## A. Phase objective

Deliver the production-quality Telegram Mini App user experience (Home, Earn, Tasks,
Friends, Wallet, Profile/Settings) with AR/EN/RU + Arabic RTL, accessibility, loading /
empty / error / degraded states, and Founder membership/claim UX — with **zero** frontend
financial or membership authority.

---

## B. Exact scope delivered

1. App shell with bottom nav + profile header; mobile safe areas; RTL-aware layout.
2. Design tokens (`packages/ui`) and i18n catalogs (`packages/i18n` ar/en/ru).
3. Telegram auth via validated `initData` → `POST /v1/auth/telegram` (never `initDataUnsafe`).
4. Home aggregate UI consuming `GET /v1/me/home` with per-domain partial failure.
5. Earn UI + Watch & Earn using Phase 11 session APIs; AdsGram **BLOCKED** shown truthfully.
6. Tasks / Friends screens with honest `ENGINE_NOT_ENABLED` / UNAVAILABLE states.
7. Wallet screen: balances, wallets list, withdrawal history entry (no private keys).
8. Profile/Settings: locale AR/EN/RU persistence, membership entry, Founder surface.
9. Founder badge/number/entitlements from `GET /v1/membership*`; claim posts only `claimCode`.
10. Shared contracts DTOs + minimal user-facing read APIs for Mini App only.
11. Authority / i18n / a11y / smoke / API read-model tests.

---

## C. Files / modules changed (accepted source)

Representative:

- `apps/miniapp/**` — AppShell, screens, auth/query/i18n providers, WatchEarn, Founder claim, tests
- `apps/api/src/me/**`, `wallets/**`, `tasks/**`, `referrals/**`, ads earn-summary
- `packages/contracts/src/*` — Phase 12 read DTOs
- `packages/ui/**` — design tokens
- `packages/i18n/**` — ar/en/ru messages + RTL helpers
- `packages/ledger/src/user-balances.ts`, `packages/ads/src/user-read.ts`, rewards user-read
- `docs/DECISIONS.md`, this report

---

## D. Database / API changes

- **No new financial engines.** No AdsGram monetary unlock.
- Read APIs: `/v1/me/balances|home|settings`, `/v1/wallets*`, `/v1/ads/earn-summary`,
  `/v1/tasks`, `/v1/referrals/summary` — present authoritative or honest UNAVAILABLE state.
- Tasks/referrals packages remain boundary shells (`ENGINE_NOT_ENABLED`).

---

## E. Commands executed (representative)

```text
pnpm --filter @alex-rewards/{contracts,ui,i18n,ads,api,miniapp} build|typecheck
pnpm exec dotenv -e .env -e .env.phase-test -- pnpm test:phase12
# API 12 + miniapp 25 + i18n 2
pnpm exec dotenv -e .env -e .env.phase-test -- pnpm test:phase11  # 29 PASS
pnpm verify:boundaries
pnpm archive:phase -- --phase 12 --slug MINIAPP_UI_FOUNDER --commit <sha> ...
```

---

## F. Test evidence

| Suite | Result |
| ----- | ------ |
| `apps/api` phase12 read models + DB | **12 PASS** |
| `apps/miniapp` (authority, scenarios, i18n, smoke, health) | **25 PASS** |
| `packages/i18n` catalog sync | **2 PASS** |
| Phase 11 regression | **29 PASS** |
| `verify:boundaries` | **PASS** |

Owner authority scenarios covered (client tamper / BLOCKED / NO optimistic credit /
Founder claim shape / Home partial failure / a11y landmarks).

---

## G. Build / health

Miniapp + API typecheck PASS. Packages contracts/ui/i18n/ads build PASS.

---

## H. CI evidence

Local Phase 12 gate green with dedicated `_test` DB. Full-repo green **not** claimed
(Phase 10 21-test debt unchanged).

---

## I. Known deviations

1. Tasks/Friends engines not implemented (Phase 16+) — UI shows UNAVAILABLE honestly.
2. Full TonConnect widget not required for gate; wallet screen shows server wallet state +
   connect-needed semantics; challenge/bind APIs exist.
3. AdsGram `blockIdPublic` remains null until Owner configures a real block id — Watch
   remains correctly gated; monetary status still BLOCKED.
4. Browser E2E against live Telegram not run in this packaging environment; automated
   authority/source/API contract tests substitute for the required gate evidence.

---

## J. Open blockers / technical debt

- AdsGram clarification gate still OPEN (production money).
- Mission/referral engines deferred.
- Phase 10 canary signing recovery: 21 documented failures (out of scope).

---

## K. Security / financial invariants

- No secrets in browser bundle beyond public config.
- No claim-code logging/storage/URL.
- No optimistic balance/Founder/reward/withdrawal.
- AdsGram production monetary **BLOCKED**.
- Frontend cannot fabricate membership/entitlement/balance/reward authority.

---

## L. Rollback / recovery

Revert Phase 12 commit; Mini App returns to foundation shell. Read APIs are additive and
safe to leave or disable via routing. No Phase 10/11 archive mutation.

---

## M. Exact accepted commit SHA

`PENDING_PACKAGING`

---

## N. Gate PASS/FAIL

| Gate | Result |
| ---- | ------ |
| Required screens | **PASS** |
| Standard-user authority/smoke | **PASS** |
| Founder server-driven badge/number/entitlements | **PASS** |
| Founder claim (code-only, clear, no log) | **PASS** |
| AR/EN/RU + RTL | **PASS** |
| Accessibility landmarks/labels | **PASS** |
| Loading/error/degraded | **PASS** |
| AdsGram BLOCKED | **PASS** |
| Phase 10/11 immutable | **PASS** |
| Phase 13 not started | **PASS** |
| **PHASE12_GATE** | **PASS** |

---

## O. Archive verification

Section O does **not** embed the outer review-package SHA-256.
Authoritative outer hash lives only in external `PACKAGE_SHA256.txt`.

Verify after packaging: source ZIP extract + prohibited-path PASS; review package
SHA256SUMS + nested source PASS; Phase 11 package SHA unchanged.

---

## Explicit non-claims

- AdsGram is **not** APPROVED for production monetary rewards
- Phase 12 ≠ AdsGram clarification gate pass
- No Phase 13 Admin Dashboard
- No Phase 10/11 reopen
- No claim that the full repository test suite is green
