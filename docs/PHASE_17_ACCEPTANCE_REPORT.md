# Phase 17 Acceptance Report - Public Payout Logs

**Status:** **PASS**

**Phase slug:** `PHASE_17_PUBLIC_PAYOUT_LOGS`
**Master specification:** Version 1.3 (Public Payout Logs / confirmed publication / Telegram transport separation)
**Canonical accepted source commit:** `bea319ae389a458d87b4f874e4468b1b087d5e9f`
**Branch:** `staging-runtime-validation`

**AdsGram production monetary status:** **BLOCKED**
**Auto payout:** **NOT ENABLED**
**Mainnet:** **NOT ACTIVATED**
**Public payout production destination:** **UNCONFIGURED / DISABLED**
**Referral monetary production:** **NOT AUTHORIZED by Phase 17**
**Phase 18:** **NOT STARTED**

---

## A. Phase identification / status

Complete Master Specification V1.3 Phase 17 - Public Payout Logs, plus accepted staging
runtime-integration remediations that do **not** alter Phase 17 payout semantics.

**PHASE17_GATE:** **PASS** (Owner / independent review)

Archive gate: `PHASE_17_PUBLIC_PAYOUT_LOGS`. Then STOP - no Phase 18.

---

## B. Accepted scope

### B1. Phase 17 Public Payout Logs (feature)

1. Confirmed-only publication authority from settled/confirmed withdrawal + outbox.
2. Durable `withdrawal.confirmed` outbox after settlement (no Telegram send in outbox insert).
3. Publication builder creates `payout_publications` PENDING rows only when proofs and destination/feature checks pass.
4. Worker consumes confirmed outbox and creates publication work only - Worker never sends Telegram.
5. Bot owns Telegram public-payout transport (poller + Grammy sender).
6. Ambiguity-safe delivery engine: SUCCESS / DEFINITE_FAILURE / AMBIGUOUS classification.
7. AMBIGUOUS is fail-closed - no blind resend / no auto-return to SENDING.
8. Publication uniqueness/idempotency (`ON CONFLICT (withdrawal_id, destination_id)`).
9. Privacy identity snapshot at publication create; settings downgrade anti-TOCTOU under shared users-row lock.
10. Founder/member status is not a payout-public privacy bypass.
11. Feature flag `PUBLIC_PAYOUT_LOGS_ENABLED` + destination purpose fail-closed.
12. Non-MAINNET / Testnet publication remains blocked in STAGING/PRODUCTION publication paths pending Owner policy.
13. No production destination seeds; no historical backfill.

### B2. Accepted staging runtime remediations (product runtime; non-financial)

Carried forward into canonical source `bea319a` (do not alter payout semantics):

| Commit | Scope |
|--------|-------|
| `c5c9872` | TonConnect manifest exposure (`/tonconnect-manifest.json`) |
| `c1399a6` | Plain Telegram `/start` LOOTRA welcome response |
| `bf31a0f` | Native Mini App `web_app` button; `MINIAPP_PUBLIC_URL`; user-facing referral `?startapp=` |
| `bea319a` | Telegram account-context mismatch forces server reauthentication |

Staging operational validation (accepted as facts, not new code in this report commit):

- Bot polling works; plain `/start` + native Mini App button work.
- Direct `?startapp=ref_<code>` works; brand-new invitee created PENDING referral edge; `invitedCount=1`.
- Existing users cannot gain late referral attribution (`created === true` only).
- Staging Referral V1 activation rule exists operationally (age >= 86400s; valid rewarded ads >= 5; no OPEN CRITICAL fraud).
- `REFERRAL_REWARD_PAUSE` enabled on STAGING; no referral monetary issuance authorized by this archive.

Out of scope / non-delivery: Phase 18; Mainnet; production public payout destination seed; historical backfill; multiple mirrors; Testnet public publication policy; AdsGram production monetary; auto payout; TON Keeper/Testnet wallet-network compatibility validation (deferred).

---

## C. Files / modules changed (accepted source)

Representative modules on canonical commit `bea319a` (full tree via `git archive` of that SHA).
Lineage `6cb90c1..bea319a`:

**Public payout core**

- `packages/withdrawals/src/public-payout-*.ts` - outbox, builder, delivery, feature, format, render, username
- `packages/withdrawals/src/settlement.ts` - confirmed outbox hook
- `packages/withdrawals/test/phase17-*.ts` - integrity / outbox / builder / delivery / runtime gate suites
- `apps/worker/src/main.ts`, `apps/worker/src/outbox-relay.ts` - publication work only
- `apps/bot/src/public-payout-poller.ts`, `apps/bot/src/public-payout-telegram-sender.ts`
- `apps/api/src/me/settings-write.ts` - privacy downgrade lock contract
- `packages/control-center/src/publications.ts` - publication status surface
- `migrations/0056` ... `0058` Phase 17 forward migrations

**Runtime remediations included in canonical SHA**

- `apps/miniapp/src/lib/tonconnect-manifest.ts` + route + tests
- `apps/bot/src/referral-start.ts`, `apps/bot/src/main.ts` (`/start` transport only)
- `packages/config/src/index.ts` (`MINIAPP_PUBLIC_URL`)
- `packages/referrals/src/telegram-links.ts` + API deep-link controller (transport URL shape)
- `apps/miniapp/src/lib/auth/telegram-user-id-hint.ts`, `boot-decision.ts`, `AuthProvider.tsx`

---

## D. Database migrations

| Migration | Purpose / integrity | Financial / security relevance | Seed status |
| --------- | ------------------- | ------------------------------ | ----------- |
| `0056_phase17_payout_publication_integrity.sql` | Publication status enum incl. AMBIGUOUS/SENDING; lease fields; state CHECKs; immutability comments | Delivery state machine; AMBIGUOUS never auto-retried to SENDING | **NO production seed** |
| `0057_phase17_publication_identity_freeze.sql` | Identity freeze / snapshot hardening | Privacy snapshot integrity | **NO production seed** |
| `0058_phase17_publication_delivery_snapshot.sql` | Delivery message/network snapshot fields | Send-authorization / retry safety | **NO production seed** |

Only `schema_migrations` inserts appear for these files.
**NO production Telegram destination / PUBLIC_PAYOUT_LOGS feature-flag enablement / historical backfill seeds.**

---

## E. Commands executed (final pre-archive gate)

Evidence recorded from accepted closeout review at software HEAD `bea319a` (documentation commits after that SHA are not re-executed as software gates):

```text
pnpm --filter @alex-rewards/bot test|typecheck|build
pnpm --filter @alex-rewards/miniapp test|typecheck|build
pnpm --filter @alex-rewards/api test|typecheck|build
pnpm --filter @alex-rewards/referrals test
pnpm --filter @alex-rewards/auth test
pnpm test:phase17
pnpm verify:boundaries
pnpm security:secrets
```

Archive packaging (this report):

```text
pnpm archive:phase -- --phase 17 --slug PUBLIC_PAYOUT_LOGS \
  --commit bea319ae389a458d87b4f874e4468b1b087d5e9f \
  --report docs/PHASE_17_ACCEPTANCE_REPORT.md \
  --roadmap-version 1.3 \
  --next-phase-status "No Phase 18 work has started at packaging time." \
  --stamp 20260930-180057
```

---

## F. Test / security evidence

| Suite | Result |
| ----- | ------ |
| Bot tests | **PASS** 18/18 |
| Bot typecheck / build | **PASS** |
| Mini App tests | **PASS** 151/151 |
| Mini App typecheck / build | **PASS** |
| API tests | **PASS** 97/97 |
| API typecheck / build | **PASS** |
| Referrals tests | **PASS** 64/64 |
| Auth tests | **PASS** 90/90 |
| `pnpm test:phase17` withdrawals | **PASS** 66 |
| `pnpm test:phase17` api privacy | **PASS** 5 |
| `pnpm test:phase17` worker | **PASS** 16 |
| `pnpm test:phase17` bot | **PASS** 18 |
| `pnpm verify:boundaries` | **PASS** |
| `pnpm security:secrets` | **PASS** |

Do not invent additional remote CI results beyond Owner/independent Railway evidence below.

---

## G. Build / health / runtime results

| Check | Result |
| ----- | ------ |
| Package builds (bot/miniapp/api) | **PASS** |
| Live/ready foundations | unchanged; not re-architected |
| Staging bot polling | **OBSERVED WORKING** |
| Staging plain `/start` + native Mini App button | **OBSERVED WORKING** |
| Staging direct `?startapp` referral | **OBSERVED WORKING** |
| Staging PENDING referral on new invitee | **OBSERVED** (`invitedCount=1`) |

---

## H. Remote / staging status

| Surface | Status |
| ------- | ------ |
| Branch `staging-runtime-validation` | Canonical software `bea319a`; later docs-only commits exist |
| Railway auto-deploy after docs commit `c67d5bc` | miniapp-staging Deployment `6703476f-b40f-46c4-8874-1cf12f0da949` **SUCCESS** |
| Railway auto-deploy after docs correction `673b7c9` | miniapp-staging Deployment `d9ade703-097b-4f1b-aad0-8a20f30ff64b` **SUCCESS** |
| Manual deployment for closeout | **NONE** |
| Mainnet deployment | **NONE** |
| API/Bot/Worker Phase 17 financial deploy from docs commits | **NOT TRIGGERED by docs-only commits** |

**Do not claim ALL REMOTE CI GREEN** beyond the observed Railway miniapp-staging auto-deploys above.

---

## I. Known deviations / unresolved Owner policy

1. **TON Keeper / Testnet account-network compatibility validation** - **DEFERRED** (not solved).
2. **Mainnet** - **OFF**.
3. **Public payout production destination** - unconfigured/disabled.
4. **Historical payout backfill** - Owner policy decision; not implemented.
5. **Multiple payout mirrors/destinations** - Owner policy decision; not implemented.
6. **Testnet public payout publication** - Owner policy decision; code remains fail-closed for non-MAINNET in STAGING/PRODUCTION publication paths.
7. **Ambiguous Telegram delivery manual reconciliation / runbook** - unresolved (`docs/OPERATIONS_RUNBOOK.md` does not yet document Phase 17 AMBIGUOUS handling).
8. **Referral monetary production values** - not authorized by Phase 17 (`REFERRAL_REWARD_PAUSE` on STAGING).
9. **AdsGram production monetary** - remains **BLOCKED**.
10. **Auto payout** - **NOT ENABLED**.

---

## J. Open blockers / technical debt

**IMPLEMENTATION BLOCKERS:** NONE for Phase 17 archive acceptance.

**OWNER / OPERATIONS FOLLOW-UPS (do not authorize money):**

- TON Keeper/Testnet network compatibility validation
- whether/when to enable PUBLIC_PAYOUT_LOGS + production destination
- historical backfill policy
- multi-destination/mirror policy
- Testnet public publication policy
- AMBIGUOUS publication operator runbook
- referral monetary production configuration (separate from Phase 17)

---

## K. Security / financial invariant table

| Invariant | Value |
| --------- | ----- |
| PUBLIC_PAYOUT_SOURCE | CONFIRMED_SETTLED_WITHDRAWAL_OUTBOX |
| WORKER_TELEGRAM_SEND | NO |
| BOT_PUBLIC_PAYOUT_TRANSPORT | YES |
| CONFIRMED_ONLY_PUBLICATION | YES |
| DUPLICATE_PUBLICATION_PROTECTION | YES |
| PRIVACY_SNAPSHOT_AT_CREATE | YES |
| PRIVACY_DOWNGRADE_TOCTOU_SAFE | YES |
| FOUNDER_PRIVACY_BYPASS | NO |
| AMBIGUOUS_SEND_BLIND_RESEND | NO |
| AMBIGUOUS_AUTO_RETRY_TO_SENDING | NO |
| FEATURE_FLAG_FAIL_CLOSED | YES |
| PRODUCTION_DESTINATION_SEEDED | NO |
| HISTORICAL_BACKFILL | NO |
| LEDGER_MUTATION_BY_PUBLICATION | NO |
| CLIENT_REFERRAL_ATTRIBUTION_AUTHORITY | NO |
| BOT_REFERRAL_ATTRIBUTION_AUTHORITY | NO |
| TELEGRAM_INITDATA_SERVER_AUTHORITY | YES |
| CLIENT_TELEGRAM_USER_HINT_AUTHORITY | UNTRUSTED_REAUTH_HINT_ONLY |
| REFERRAL_ATTRIBUTION | CREATED_ONLY |
| SELF_REFERRAL | BLOCKED |
| REFERRAL_MONETARY_PHASE17 | NOT_AUTHORIZED |
| ADSGRAM_PRODUCTION_MONETARY | BLOCKED |
| AUTO_PAYOUT | NO |
| MAINNET_ACTIVATED | NO |

---

## L. Rollback / recovery notes

- Publication creation is idempotent per `(withdrawal_id, destination_id)`.
- Delivery leases serialize send attempts; AMBIGUOUS rows must not be blindly resent.
- Privacy downgrade freezes SHOW_USERNAME toward HIDE_IDENTITY under users-row lock vs publication claim.
- Worker restart recreates publication work from durable outbox/publication state; Bot restart resumes poller without inventing financial authority.
- Absent feature flag / destination / MAINNET network authority fails closed (no silent public send).
- Canonical software rollback target for Phase 17 product behavior is `bea319a` (not later docs-only commits).

---

## M. Exact canonical accepted source SHA

**CANONICAL_ACCEPTED_SOURCE_COMMIT:**

`bea319ae389a458d87b4f874e4468b1b087d5e9f`

**Branch:** `staging-runtime-validation`

Documentation-only closeout commits that are **NOT** canonical software source:

- `c67d5bc5180f1597e089fd74dff56eb5537d3001` - runtime-integration closeout document
- `673b7c92640e501730104be6ce4c70b97d919f2d` - deployment wording correction
- This acceptance-report documentation commit (recorded after packaging in git history) is also **not** the canonical software source.

Archive packaging always targets the canonical SHA above via `git archive`.

---

## N. Gate PASS/FAIL

| Gate | Result |
| ---- | ------ |
| Bot tests / typecheck / build | **PASS** |
| Mini App tests / typecheck / build | **PASS** |
| API tests / typecheck / build | **PASS** |
| Referrals tests | **PASS** |
| Auth tests | **PASS** |
| `pnpm test:phase17` | **PASS** |
| verify:boundaries | **PASS** |
| security:secrets | **PASS** |
| Confirmed-only publication | **PASS** |
| Duplicate publication protection | **PASS** |
| Privacy / Founder non-bypass | **PASS** |
| Ambiguous send fail-closed | **PASS** |
| Mainnet active | **NO** (required) |
| **PHASE17_GATE** | **PASS** |

---

## O. Archive verification

Archive helper version: **2.1.0**
Fixed packaging stamp: **20260930-180057**
Exact accepted source commit: `bea319ae389a458d87b4f874e4468b1b087d5e9f`

| Artifact | Result |
| -------- | ------ |
| Canonical source ZIP | `ALEx_Rewards_PHASE_17_PUBLIC_PAYOUT_LOGS_20260930-180057_bea319a.zip` |
| Canonical source ZIP path | `phase-archives/PHASE_17_PUBLIC_PAYOUT_LOGS/ALEx_Rewards_PHASE_17_PUBLIC_PAYOUT_LOGS_20260930-180057_bea319a.zip` |
| Canonical source ZIP SHA256 | *(filled after packaging; see `SHA256SUMS.txt`)* |
| Final review-package filename | `PHASE_17_PUBLIC_PAYOUT_LOGS_PACKAGE_20260930-180057_bea319a.zip` |
| Source extraction | **PASS** (required) |
| Outer package extraction | **PASS** (required) |
| Prohibited-path scan (source + outer) | **PASS** (required) |
| Nested source validation | **PASS** (required) |
| Forward-slash ZIP entry names | **PASS** (required; entries under `PHASE_17_PUBLIC_PAYOUT_LOGS/`) |
| SHA256SUMS verification | **PASS** (required) |

Final review-package SHA256 is recorded externally in `PACKAGE_SHA256.txt` beside the package.
Section O does **not** embed the outer package SHA256.
