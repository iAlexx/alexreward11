# Post–Phase 13 Railway Staging Integration Closeout

**Document type:** deployment / integration evidence only  
**Not a numbered product phase.**  
**Phase 14 has NOT started.**

This record closes the Post–Phase 13 Railway staging infrastructure smoke that descended from the accepted Phase 13 remediation tip. It does not reopen Phase 13, merge PR #9, authorize production money, Mainnet, AdsGram monetary rewards, fake-chain payouts, real-chain payouts, Telegram polling, Owner Admin operational bootstrap, or Signer deployment.

---

## 1. Scope

- Railway staging networking and health for API, Admin frontend, Mini App, Worker, and Bot HTTP
- Explicit `STAGING_INTEGRATION_MODE` fail-closed config for Testnet-only staging smoke
- Migration ledger remediation for Phase 13 markers on a fresh staging DB
- Telegram Mini App live touch-navigation remediation
- Explicit Worker financial outbox relay gate (default off under staging integration)
- Explicit Bot disabled-transport exception for HTTP-only infrastructure smoke

Out of scope: Phase 14 product work, authenticated Owner Admin staging smoke, Signer, Telegram polling / Owner-review delivery, LOOTRA branding redesign, production money.

---

## 2. Accepted baseline

| Item | Value |
| --- | --- |
| Accepted Phase 13 remediation tip | `fcfc23244b3016bc0258f203ea81aa32b7fa5c0b` |
| Branch `phase13-independent-remediation` | unchanged at that tip |
| Draft PR #9 | OPEN, head still `fcfc232…`, unmerged |

---

## 3. Staging branch / head

| Item | Value |
| --- | --- |
| Branch | `staging-integration` |
| Started from | `fcfc23244b3016bc0258f203ea81aa32b7fa5c0b` |
| Closeout tip (this document commit’s parent) | `e53d1bd47bae954021e22cfcd9f482d952ee2ca9` |

---

## 4. Service topology

| Service | Role | Network |
| --- | --- | --- |
| Postgres | Financial / app DB | private |
| Redis | Cache / sessions | private |
| temporal-staging | Temporal cluster | **private-only** |
| api-staging | Nest/Fastify API | public HTTPS |
| admin-staging | Owner Admin frontend | public HTTPS |
| miniapp-staging | Telegram Mini App | public HTTPS |
| worker-staging | Temporal worker + HTTP health | **private-only** |
| bot-staging | Bot HTTP health (transport disabled) | **private-only** |

Signer is **not** part of this topology.

---

## 5. Public / private endpoint summary

**Public**

| Surface | URL |
| --- | --- |
| API | https://api-staging-production-5961.up.railway.app |
| Admin | https://admin-staging-production-5d8f.up.railway.app |
| Mini App | https://miniapp-staging-production.up.railway.app |

**Private-only (no public claim)**

- Temporal
- Worker
- Bot service

No secrets, tokens, or Railway credential values are recorded here.

---

## 6. API readiness

Verified Railway staging configuration (non-secret):

- `DEPLOYMENT_ENV=staging`
- `STAGING_INTEGRATION_MODE=true`
- `WITHDRAWAL_NETWORK_CODE=TON_TESTNET`
- `WITHDRAWAL_FAKE_CHAIN_ENABLED=false`
- Fastify bind via validated `API_LISTEN_HOST=::`

`/health/ready` **PASS** with:

- Postgres reachable
- Redis reachable
- Temporal reachable

---

## 7. Migration status

- Fresh DB final applied migration count: **33**
- Phase 13 legacy markers **0031–0033** repaired only after schema verification (fail closed on partial schema)
- Repeated migration run: **idempotent**

---

## 8. Mini App live smoke

Verified:

- Opens from Telegram
- Telegram `initData` authentication succeeds
- Home server-authoritative data loads
- Real mobile navigation works (BottomNav, Go to Earn, Profile)

Live Telegram / mobile bug remediated on `staging-integration`:

- Next App Router `Link` transition did not commit in Telegram WebView → plain document navigation for Mini App links
- Bottom nav hit-target / horizontal overflow issues fixed
- Pixel 5 click/touch E2E coverage added

**Branding:** intentional deferred. Visible ALEx Rewards branding is not claimed finalized. LOOTRA branding / front-end redesign is separate follow-up after this closeout.

---

## 9. Worker safety state

Verified:

- Connected to Temporal
- Temporal Worker state: **RUNNING**
- Task queue: `alex-rewards-staging-smoke`
- `listenHost=::`
- `fakeChainEnabled=false`
- `realChainEnabled=false`
- `outboxRelayEnabled=false` (`WORKER_OUTBOX_RELAY_ENABLED=false`)
- `/health/ready` **PASS**

With outbox relay disabled, this smoke does **not**:

- claim financial outbox events
- dispatch withdrawal workflows from financial outbox
- retry / dead-letter financial outbox events
- broadcast payouts

---

## 10. Bot disabled-transport state

Verified:

- HTTP service online
- `listenHost=::`, port `3003`
- `/health/ready` **PASS**
- `BOT_TRANSPORT_MODE=disabled`

Therefore:

- no Telegram polling
- no Telegram Bot API runtime connectivity
- no Owner-review delivery
- no Control Center callbacks
- no Owner Telegram allowlist required for this disabled smoke
- no DB pool opened for Telegram transport flow

Launching the Mini App from `@LOOTRAbot` via BotFather is **separate** from server polling. Server Telegram polling is **not** validated.

---

## 11. Admin exclusion

Admin frontend loads on its Railway staging domain.

Authenticated Owner Admin staging smoke: **BLOCKED_BY_DESIGN**

Operational first-Owner trust establishment remains blocked by design. This closeout does **not**:

- create manual Owner DB rows
- invent credentials
- use isolated_test ceremony tooling against staging
- bypass Option C trust-establishment requirements

`ADMIN_AUTHENTICATED_STAGING_SMOKE: BLOCKED_BY_DESIGN` — explicit known exclusion, not a silent PASS.

---

## 12. Signer exclusion

`SIGNER_STAGING_DEPLOYMENT: NOT_RUN_INTENTIONALLY`

- Signer intentionally not deployed for initial Railway staging
- No production signer key in Railway
- No signer passphrase / private key / seed introduced by this work

---

## 13. Financial safety statement

| Control | State |
| --- | --- |
| Network | Testnet configuration only (`TON_TESTNET` under staging integration) |
| Fake chain | **OFF** |
| Real chain | **OFF** |
| Worker outbox relay | **OFF** |
| Bot transport | **disabled** (no Owner-review payout path from bot) |
| Production money | **NO** |
| Mainnet | **NO** |

This closeout authorizes **no** payout broadcast and **no** production monetary issuance.

---

## 14. AdsGram status

| Item | Status |
| --- | --- |
| AdsGram production monetary status | **BLOCKED** |
| Clarification gate | **NO** |

---

## 15. Known debt (recorded, not fixed)

1. `pnpm --filter @alex-rewards/withdrawals typecheck` fails with pre-existing **TS2367** in `packages/withdrawals/test/phase10-success-batch-runner.test.ts` (~line 194). Predates the staging integration withdrawal alignment patch. **Not fixed in this closeout.**
2. Historical global formatting debt remains unrelated and is not addressed here.

---

## 16. PASS / BLOCKED / NOT_RUN table

| Item | Result |
| --- | --- |
| Postgres | **PASS** (online) |
| Redis | **PASS** (online) |
| Temporal | **PASS** (online, private-only) |
| API `/health/ready` | **PASS** |
| API Postgres / Redis / Temporal deps | **PASS** |
| Migration ledger (33, idempotent, 0031–0033 repair) | **PASS** |
| Admin frontend load | **PASS** |
| Admin authenticated Owner smoke | **BLOCKED_BY_DESIGN** |
| Mini App live Telegram smoke | **PASS** |
| Mini App branding finalized | **NOT_RUN** (deferred) |
| Worker Temporal RUNNING | **PASS** |
| Worker outbox relay | **PASS** (explicitly **disabled**) |
| Bot HTTP `/health/ready` | **PASS** |
| Bot Telegram polling | **NOT_RUN** (`BOT_TRANSPORT_MODE=disabled`) |
| Bot Owner-review delivery | **NOT_RUN** |
| Signer staging deployment | **NOT_RUN_INTENTIONALLY** |
| Fake chain | **OFF** |
| Real chain | **OFF** |
| Mainnet | **NO** |
| AdsGram production monetary | **BLOCKED** |
| Phase 14 | **NOT STARTED** |

---

## 17. Phase 14 statement

**Phase 14 has NOT started.**

This document is Post–Phase 13 Railway staging integration evidence only. Future numbered product phases require separate explicit Owner authorization.

---

*End of closeout. No secrets included.*
