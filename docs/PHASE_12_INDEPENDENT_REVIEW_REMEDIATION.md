# Phase 12 Independent Review Remediation

**Status:** Remediation on branch `phase12-independent-remediation` — **not** independently
accepted until Owner review. Original Phase 12 package is preserved unchanged.

**Specification:** Master Spec V1.3  
**Remediation branch:** `phase12-independent-remediation`  
**Remediation tip SHA:** `73300fdf070a699d7d2f7fb2025e569d25cf5ab3`  
**GitHub draft PR:** https://github.com/iAlexx/alexreward11/pull/8 (Draft — **not merged**; base `main`)  
**GitHub Actions run:** https://github.com/iAlexx/alexreward11/actions/runs/36254709740

- `phase11-remediation`: **PASS**
- `phase12-remediation`: **PASS**
- `phase12-e2e`: **PASS**
- `quality`: **FAIL** — historical Prettier debt (kept visible; not weakened)

**Original Phase 12 implementation:** `7bfcab978ec39ae474b2d622dac4310d55fdee04`  
**Original Phase 12 packaging:** `6ef7a839f3085e4fb55bbdd77897b853b23f459b`  
**Original Phase 12 package SHA-256:**  
`e1f498cc0f1c8f1f8ad9c442b167b4e5da3006c0fafba2955584c9ac14aa912f`

**Accepted Phase 11 P11-01 provenance (forward-ported code/test/CI only):**

- Implementation: `e855c091c0bad68b231c685d6c2610e504dcc50a`
- R13/R5/CI restore: `9708d8213fab32f54d5f4c54b49b3eedf7d52210`
- Ads turbo build in CI: `c6be44d3c495f3dffa49f6512b22a6b55e40fae4`
- Independently verified Phase 11 remediation package:  
  `2663e87a545d6e281602b84cf7530bae438e4f4de4548c75f4eee2bbe2330b99`

**Historical Phase 11 report** `docs/PHASE_11_INDEPENDENT_REVIEW_REMEDIATION.md` is carried as
provenance evidence for that Phase 11 branch/package only — not a Phase 12 claim.

**AdsGram production monetary status:** **BLOCKED** (unchanged)  
**AdsGram clarification gate:** **NO** (unchanged; `PROVIDER_SIDE_REQUEST_LIMIT` remains OPEN)

**No Phase 13 work. No Phase 14. No forward integration into
`feature/owner-admin-session-auth`.**

---

## Findings (independent review)

### P12-01 — Required Standard/Founder E2E was not run

Original Phase 12 acceptance admitted browser E2E against live Telegram was **not** run.
Vitest/source scans are not a substitute for Master gate
“E2E standard-user + Founder-user flows pass.”

**Fix:** Playwright package `apps/miniapp-e2e` with isolated DB
`alex_rewards_phase12_e2e`, real `POST /v1/auth/telegram` session plant, standard /
Founder / client-tamper browser suites. Script: `pnpm test:phase12:e2e`.

### P12-02 — Request remaining model invalid after accepted P11-01

Phase 12 `user-read` used `ad_daily_counters.provider_requests` as REQUEST `usedCount`.
After P11-01 that column is authoritative provider-request evidence only; AdsGram has no
approved write path. Conservative authorize safety uses `COUNT(ad_sessions)`.

**Fix:** Forward-ported P11-01 authorize/lifecycle/tests/CI. Earn read model + contracts
expose typed `usageBasis`:
`SERVER_AUTHORIZED_SESSION_CONSERVATIVE` | `AUTHORITATIVE_PROVIDER_REQUEST` |
`SUCCESSFUL_REWARD`. AdsGram REQUEST uses session-conservative basis; SUCCESS uses
`SUCCESSFUL_REWARD`. UI labels no longer call this “proven provider requests.”
Watch/Earn disable path still follows server remaining; authorize remains final authority.

### P12-03 — Wallet UI incomplete vs Appendix C

Missing TON Connect bind flow, all balance buckets, cooldown warning, and server
withdrawal quote fee/net display.

**Fix:** Wallet renders Available/Pending/Reserved from server. TonConnect via pinned
`@tonconnect/ui-react@3.0.2` against existing Phase 6 challenge/bind APIs. Config
`NEXT_PUBLIC_TONCONNECT_MANIFEST_URL` degrades honestly when unset. Withdrawal quote /
confirm / history use existing Phase 7 endpoints; no client fee math.

### P12-04 — Profile incomplete vs Appendix C

Payout privacy was read-only; Terms/Privacy links, support, and deletion request missing.

**Fix:** `PATCH /v1/me/settings` accepts `publicPayoutIdentityMode`
(`SHOW_USERNAME` | `HIDE_IDENTITY`). Public `NEXT_PUBLIC_TERMS_URL` /
`NEXT_PUBLIC_PRIVACY_URL` with honest degrade. Narrow user support API on migration 0010
tables. Account deletion is authenticated idempotent **request**
(`ACCOUNT_DELETION_REQUEST` ticket + event) — no ledger/audit deletion, no immediate
anonymization.

---

## Forward-ported Phase 11 files (exact)

Cherry-picked onto this branch (no later Phase 11 docs/package tip commits):

| Commit                | Files                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `e855c09` → `eb6d4cd` | `authorize.ts`, `lifecycle.ts`, phase11 tests/harness, `ADS_SPEC.md`, P11 report, ads `package.json`, CI phase11 step |
| `9708d82` → `9501a81` | P11 report restore, R13 lock test, R5 source-boundary, `phase11-remediation` CI job                                   |
| `c6be44d` → `bb10da3` | CI turbo build before ads typecheck                                                                                   |

Phase 12 `user-read.ts` and Mini App UI were **not** overwritten by P11; P12-01 adapted them.

---

## Auth transport debt (ADR-008)

Phase 12 Mini App still stores access + refresh tokens in `sessionStorage` (not
`localStorage`, not URLs). Documented as production XSS exposure debt. Final cookie
topology is **not** claimed solved. Refresh rotation/replay protection and logout revocation
remain server-enforced. CSP remains strict. Live Telegram smoke must validate transport
when configuration exists.

---

## Tests

| Category                          | Location                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| unit / contract / source-boundary | existing Vitest (`test:phase12`, `test:phase11`) — **not** E2E                     |
| integration                       | API DB tests for earn usageBasis, privacy, support ownership, deletion idempotence |
| browser E2E                       | `apps/miniapp-e2e` Playwright (standard / Founder / tamper)                        |
| live Telegram smoke               | **not run** — configuration unavailable (see below)                                |

---

## GitHub CI

Independent jobs (no `needs: quality`):

- `phase11-remediation` — retained from P11 forward-port
- `phase12-remediation` — report non-empty, scoped Prettier, build/boundaries, phase11+phase12 tests
- `phase12-e2e` — Playwright on isolated DB

`quality` historical Prettier failure remains visible and is **not** weakened.

Report separately (run `36254709740`):

- `PHASE11_REGRESSION_CI_PASS=YES`
- `PHASE12_GITHUB_CI_PASS=YES` (`phase12-remediation`)
- `PHASE12_BROWSER_E2E_CI_PASS=YES` (`phase12-e2e`)
- `OVERALL_REPOSITORY_CI_PASS=NO` (historical `quality` Prettier debt)

---

## Live Telegram smoke

**LIVE_TELEGRAM_SMOKE_PASS=NO**

**Inspection date (UTC):** 2026-09-26T16:54Z  
**Remediation tip at inspection:** `1f2869f93410c34b1629cc1b3b3164e1cef29aeb`

### Existing deployment / config (inspected only)

| Item                                                | Finding                                                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel Mini App project                             | `alex-rewards-miniapp` (team `y720183p-2353s-projects`); linked from primary worktree `.vercel`                                           |
| Public Mini App URL                                 | `https://alex-rewards-miniapp.vercel.app` — `/api/health/live` returned **200**                                                           |
| Public API URL                                      | **NONE** usable for Telegram. Local `NEXT_PUBLIC_API_BASE_URL` host is `http://localhost:3002` only                                       |
| Local API                                           | Docker/local `127.0.0.1:3002` health **200** (not reachable from Telegram clients)                                                        |
| Telegram test bot                                   | **No real BotFather bot.** Local `TELEGRAM_BOT_TOKEN` is a **local-only test placeholder** shape for Vitest/E2E HMAC — not a live bot     |
| `NEXT_PUBLIC_TONCONNECT_MANIFEST_URL`               | **NOT SET**                                                                                                                               |
| `NEXT_PUBLIC_TERMS_URL` / `NEXT_PUBLIC_PRIVACY_URL` | **NOT SET** (honest Profile degrade)                                                                                                      |
| Mini App CSP                                        | No `frame-ancestors 'none'` on Mini App (Referrer-Policy / nosniff / Permissions-Policy only) — embedding not blocked by Mini App headers |
| API CSP                                             | API uses `frame-ancestors 'none'` (correct for API; not the Mini App document)                                                            |
| Phase 12 worktree `.env`                            | **ABSENT** (no secrets in remediation worktree)                                                                                           |

Secret presence (values never recorded):

- `TELEGRAM_BOT_TOKEN`: SET in primary `.env` but **LOCAL_TEST_PLACEHOLDER** (not live BotFather)
- `NEXT_PUBLIC_API_BASE_URL`: SET → localhost only
- `NEXT_PUBLIC_TONCONNECT_MANIFEST_URL`: NOT SET
- `SESSION_ACCESS_SECRET`: SET (local)
- `DATABASE_URL` / `REDIS_URL`: SET (local docker hosts)

### Blockers (Owner rule §4 — STOP before creating/changing a bot)

1. **`LIVE_TELEGRAM_BLOCKER=TEST_BOT_REQUIRED`** — no non-production Telegram bot is configured for live Mini App smoke. Owner may create/configure a test bot via BotFather and place the token into local/Vercel secret storage (not into chat).
2. **`LIVE_TELEGRAM_BLOCKER=PUBLIC_TEST_API_REQUIRED`** — Telegram clients cannot call `http://localhost:3002`. A non-production HTTPS API deployment (isolated DB/Redis) is required and must be wired as Mini App `NEXT_PUBLIC_API_BASE_URL`.
3. After bot + public API exist: register Mini App/Web App URL in BotFather to `https://alex-rewards-miniapp.vercel.app` (or the chosen test Mini App HTTPS URL) — never production money.

Isolated Playwright HMAC fixture remains **not** a substitute for Telegram WebView CSP/frame / genuine `initData` smoke.

Phase 12 independent closure remains **pending** live smoke + Owner archive acceptance.
Archive creation remains **deferred** until `LIVE_TELEGRAM_SMOKE_PASS=YES`.

---

## Archives

- Original Phase 12 package preserved byte-identical:  
  `e1f498cc0f1c8f1f8ad9c442b167b4e5da3006c0fafba2955584c9ac14aa912f`
- New remediation archive: **deferred** until GitHub Phase 12 CI PASS **and** live Telegram
  smoke PASS (Owner rule). Do not overwrite the original package.

---

## Explicit non-claims

- AdsGram is **not** APPROVED for production monetary rewards
- Clarification gate is **not** passed
- This is **not** Phase 13/14 work
- Forward integration into `feature/owner-admin-session-auth` is **not** done
- Overall repository CI green is **not** claimed while historical Prettier debt remains
- Live Telegram Mini App smoke is **not** claimed PASS
- Independent archive verification is **not** claimed
- Final production cookie auth topology is **not** solved
