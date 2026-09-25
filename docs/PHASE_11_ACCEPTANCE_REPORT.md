# Phase 11 Acceptance Report — AdsGram + Provider Framework Foundation

**Status:** **PASS** (implementation + certification gate)

**Phase slug:** `PHASE_11_ADSGRAM_PROVIDER_FRAMEWORK`  
**Master specification:** Version 1.3  
**Accepted commit:** _(filled at packaging — see Section M)_  

**AdsGram production monetary status:** **BLOCKED**  
**AdsGram clarification gate:** **NOT PASSED** (six OPEN clarification items)  
**Phase 10:** remains **CLOSED** / campaign **COMPLETED** 100/100  
**Phase 12:** **NOT STARTED**

---

## A. Phase objective

Build a provider-neutral rewarded-ad framework and the AdsGram adapter without coupling
core reward/business logic to AdsGram-specific constants, without enabling production
monetary rewards for AdsGram, and without reopening Phase 10 or starting Phase 12.

---

## B. Exact scope delivered

1. Provider Adapter/SDK contracts (`RewardedAdProvider`) and compile-time registry.
2. AdsGram adapter with honest capability manifest (`BLOCKED`, unknowns not invented).
3. Versioned provider limit engine with **per-dimension** resolution (REQUEST vs SUCCESS).
4. Rewarded ad sessions + DB one-active-session enforcement.
5. Independent append-only client/provider signals + derived lifecycle.
6. NO_FILL / FAILED / SKIPPED handling without reward.
7. Dynamic reward quotes via Reward Engine; pre-generated session+quote IDs in one TX.
8. Authoritative FK: `reward_quotes.ad_session_id` (UNIQUE); mirror `ad_sessions.reward_quote_id`.
9. AdsGram Reward URL webhook (evidence only; never UPDATE balance).
10. Central provider-neutral monetary eligibility gate (AdsGram **data** → BLOCKED).
11. Provider health snapshots controlling NEW session authorization.
12. Atomic `issueAdReward` (Reward Engine): validate, idempotency, issue, counter++,
    consume reservation, ledger post, session → REWARDED, outbox — one PostgreSQL TX.
13. Adapter has **no** direct ledger write path (boundary enforced).
14. Admin-readable provider metadata API foundation (not Phase 13 dashboard).
15. Certification harness + Owner gate tests 1–20 (+ limits version + boundaries).
16. Official `@adsgram/react@1.0.2` client boundary in miniapp (not Phase 12 Earn UI).
17. Clarification register (doc + DB rows).

---

## C. Files / modules changed (accepted source)

Representative modules (full tree in accepted commit / source ZIP):

- `packages/ads/**` — provider framework, AdsGram adapter, limits, monetary gate,
  sessions/signals, health, admin-read, webhook ingest, certification harness + tests
- `packages/rewards/src/issue-ad.ts`, `quotes.ts`, `types.ts`, `index.ts` — AD quotes +
  atomic `issueAdReward`
- `migrations/0030_phase11_adsgram_foundation.sql` — FK correction, health/clarification
  tables, AdsGram BLOCKED seed, REQUEST=30 / SUCCESS=25 versioned rules
- `apps/api/src/ads/**` — session endpoints + AdsGram Reward URL webhook
- `apps/miniapp/src/ads/AdsGramRewardedBridge.tsx` — thin official SDK bridge (unmounted)
- `scripts/verify-boundaries.mjs` — unlock ads shell; forbid ads→ledger imports
- Docs: `ADS_SPEC.md`, `ADSGRAM_CLARIFICATION_REGISTER.md`, `ARCHITECTURE.md`,
  `DATABASE.md`, `SECURITY.md`, `TEST_PLAN.md`, `FAILURE_MATRIX.md`, `DECISIONS.md`,
  `REWARDS.md`, this report

---

## D. Database migrations

- `migrations/0030_phase11_adsgram_foundation.sql`
  - Adds `reward_quotes.ad_session_id` (+ uniqueness + AD CHECK)
  - Backfill from legacy `ad_sessions.reward_quote_id` with ambiguity fail-closed
  - `provider_health_snapshots`, `provider_clarification_items`
  - AdsGram seed: `production_monetary_status=BLOCKED`, six OPEN clarifications
  - Limit rules: PROVIDER_HARD REQUEST UTC_DAY **30**; PLATFORM_SOFT SUCCESS UTC_DAY **25**

---

## E. Commands executed (representative)

```text
pnpm --filter @alex-rewards/rewards build
pnpm --filter @alex-rewards/ads build
pnpm verify:boundaries
pnpm test:phase11
# → 3 files, 29 tests passed
pnpm archive:phase -- --phase 11 --slug ADSGRAM_PROVIDER_FRAMEWORK --commit <accepted> \
  --report docs/PHASE_11_ACCEPTANCE_REPORT.md --roadmap-version 1.3
```

---

## F. Unit / integration / E2E / failure / security tests

| Suite | Result |
| ----- | ------ |
| `phase11-boundaries.test.ts` | PASS |
| `phase11-certification.test.ts` (Owner TEST 1–20) | PASS |
| `phase11-limits-version.test.ts` (30→100 REQUEST via rule version) | PASS |
| **Total** | **29/29 PASS** |

Mandatory end-marker expectations covered:

- Ad click / failed / NO_FILL → no reward
- Client-only completion → no monetary credit
- Duplicate client/provider signals → no duplicate reward
- Out-of-order signals → deterministic aggregate
- One active session concurrency
- Versioned 30 request / 25 success; 30→100 without business-logic rewrite
- Historical rule version retained on old sessions
- Founder/tier cannot exceed provider hard limit
- AdsGram BLOCKED → production monetary impossible
- Adapter cannot direct-write ledger
- Reward idempotency; unknown provider refused; health blocks new sessions
- No unsafe failover; client-tampered quote amount refused

**Known Phase 10 debt (unchanged, not hidden):** 21 failures in
`phase10-canary-signing-recovery.test.ts` remain historical technical debt.

---

## G. Build / health

- `packages/ads` and `packages/rewards` TypeScript build: PASS
- `pnpm verify:boundaries`: PASS (ads unlocked; ads-must-not-import-ledger enforced)

---

## H. CI evidence

Local Phase 11 gate: `pnpm test:phase11` → 29 passed. Full-repo green is **not** claimed
(Phase 10 21-test debt remains).

---

## I. Known deviations

1. Phase 2 schema used reverse FK `ad_sessions.reward_quote_id`. Corrected in 0030 to
   Spec V1.3 `reward_quotes.ad_session_id` as authority; legacy column kept as mirror.
2. TEST 16 monetary posting uses test-only `HARNESS_CERT` provider (never production-seeded);
   AdsGram remains BLOCKED (TEST 14).
3. Miniapp AdsGram bridge is foundation-only and not mounted as Earn UI (Phase 12).

---

## J. Open blockers / technical debt

1. AdsGram clarification gate OPEN (authenticity, correlation, retry, delivery window,
   provider-side request limit, moderation/compliance).
2. Phase 10 canary signing recovery: 21 documented failures (out of Phase 11 scope).
3. Production AdsGram block/unit IDs remain Owner-configured placeholders in seed.

---

## K. Security / financial invariants

- No client callback as financial truth
- No `Reward URL → UPDATE balance`
- No provider adapter ledger writes
- No hardcoded 25/30 in provider-independent algorithms
- No Founder/Premium/tier bypass of provider hard limits
- No reward on failed / no-fill / skipped / click-only
- No production debug fake-completion endpoint
- AdsGram production monetary **BLOCKED** unless clarification gate independently satisfied
  (it was **not** satisfied in this phase)

---

## L. Rollback / recovery

- Forward-only migration 0030; rollback = restore prior deploy + do not apply 0030 on new DBs
- Disable AdsGram provider status / set health UNAVAILABLE/SUSPENDED to stop NEW sessions
- Historical sessions and quotes remain reconstructable via rule versions + `ad_session_id`

---

## M. Exact accepted commit SHA

`85fc49190c186743498512861cc62f708debd056`

---

## N. Gate PASS/FAIL

| Gate | Result |
| ---- | ------ |
| Provider framework implemented | **PASS** |
| AdsGram adapter implemented | **PASS** |
| Limits versioned; 30→100 without code change | **PASS** |
| One-active-session enforced | **PASS** |
| Independent signal model | **PASS** |
| Client-only / no-fill / failed → no reward | **PASS** |
| Duplicate reward impossible | **PASS** |
| Provider direct ledger write impossible | **PASS** |
| AdsGram production monetary BLOCKED | **PASS** |
| Clarification gate (production money approval) | **FAIL** (expected; remains OPEN) |
| Provider certification harness | **PASS** (29 tests) |
| Phase 10 still CLOSED | **PASS** |
| Phase 12 not started | **PASS** |
| **PHASE11_GATE** | **PASS** |

---

## O. Archive verification

Section O does **not** embed the outer review-package SHA-256.
Authoritative outer hash is only in external `PACKAGE_SHA256.txt` beside the final
review-package ZIP.

After packaging, verify:

1. Canonical source ZIP extracts; prohibited-path scan PASS.
2. Final review-package ZIP extracts; `SHA256SUMS.txt` verifies; nested source validates.
3. External `PACKAGE_SHA256.txt` matches the outer ZIP digest.
4. Phase 10 archive hashes remain unchanged (no Phase 10 reopen).

---

## Explicit non-claims

- AdsGram is **not** APPROVED for production monetary rewards
- Phase 11 completion ≠ AdsGram production-money approval
- No Phase 12 Mini App Earn / Founder experience
- No Phase 10 reopen, payout unlock, or campaign mutation
- No claim that the full repository test suite is green
