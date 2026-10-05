# Phase 15 Acceptance Report — Referral V1 + Membership Entitlement

**Status:** **PASS**

**Phase slug:** `PHASE_15_REFERRAL_MEMBERSHIP`  
**Master specification:** Version 1.3 (§79 Referral V1; §80 Referral Activation; §81 Referral Reward; §82 Referral Fraud; §172 Phase 15)  
**Canonical accepted source commit:** `fe3ac03b056d4a81d06f964109bb305c7cf7149a`  
**Branch:** `phase15-referral-membership`

**AdsGram production monetary status:** **BLOCKED**  
**Auto payout:** **NOT ENABLED**  
**Mainnet:** **NOT ACTIVATED**  
**Phase 16 Mission engine:** **NOT STARTED**  
**Production Referral money active:** **NO**

---

## A. Phase objective

Complete Master Specification V1.3 §172 Phase 15 — Referral V1 + Membership Entitlement:

- Deliver a Level-1-only Referral system with one-time, signed Telegram `start_param`
  attribution into a PENDING edge.
- Provide versioned/configurable activation (account-age + AVAILABLE AD evidence + OPEN
  CRITICAL Fraud hard gate) with an operational activation runtime batch.
- Resolve Membership `REFERRAL_RATE_BOOST` as an **effective replacement** rate (not additive).
- Issue a separate platform-funded Referral reward (integer FLOOR), under
  `MAX_REFERRAL_BONUS_DAILY` when configured, starting PENDING, with maturity runtime and
  originating-reward reversal cascade.
- Ship Telegram-safe server code generation and public `?start=ref_<code>` share transport,
  plus a Bot `/start` → `?startapp=ref_<code>` Mini App launch bridge (transport only).
- Expose Friends server-authoritative Referral surface and Admin read-only Referral audit
  evidence.
- Keep production Referral policy unseeded and fail-closed until Owner-approved configuration.

Gate conditions (must hold):

- No client / Bot financial or referrer authority.
- Signed Mini App `initData` remains attribution authority.
- No hardcoded 5% / 700 bps production rates; no production policy seeds.
- Historical ledger immutable; reversal uses linked compensating transactions.

---

## B. Exact scope delivered

1. **Referral rule version authority** — `referral_rule_versions` with activation age/ad
   thresholds and base rate; ACTIVE resolution fail-closed when unconfigured.
2. **Referral rule referenced immutability** — semantic freeze + FOR SHARE first-reference;
   terminal edge provenance freeze (0045).
3. **Telegram signed referral attribution** — HMAC-validated `start_param=ref_<code>` via
   `validateTelegramInitData()` on first authenticated login.
4. **One-time PENDING attribution** — immutable `referral_edges` PENDING; no self-referral;
   concurrent same/different code serialization.
5. **Terminal Referral edge provenance** — ACTIVE/REJECTED activation/rejection fields frozen.
6. **Versioned activation age/ad requirements** — engine evaluates configured thresholds;
   tests cover the Spec V1 default behavioral profile (86,400s + 5 AVAILABLE ads).
7. **OPEN CRITICAL Fraud activation block** — users row `FOR UPDATE` serializes against
   concurrent `fraud_flags` INSERT; Founder cannot bypass CRITICAL.
8. **Periodic activation runtime** — `processPendingReferralActivationBatch` wired into worker.
9. **Immutable `referral_eligible` reward provenance** — source AD must be referral-eligible.
10. **Membership `REFERRAL_RATE_BOOST`** — entitlement resolution with pinned provenance.
11. **EFFECTIVE_REPLACEMENT semantics** — membership profile replaces base rate (not additive).
12. **Referral budget/exposure** — `MAX_REFERRAL_BONUS_DAILY` when ACTIVE; missing budget fail-closed.
13. **Referral reward issuance** — durable `referral_reward_decisions` + platform expense posting.
14. **Integer FLOOR arithmetic** — no floating-point Referral amount.
15. **Referral Pending/maturity** — initial PENDING; `processDueReferralMaturityBatch`.
16. **Originating reward reversal cascade** — public `reverseRewardEvent` always cascades;
   no exported `skipReferralCascade`.
17. **Server code-generation policy** — versioned alphabet/length; `node:crypto` `randomInt`;
   `Array.from` symbol-safe selection.
18. **Telegram-safe transport** — alphabet `[A-Za-z0-9_-]`; code length ≤ 60; payload ≤ 64.
19. **Bot public referral transport bridge** — `/start ref_<code>` → Mini App
    `?startapp=ref_<code>` (no attribution / no money).
20. **Friends Referral UI** — server summary counts + `GET /v1/referrals/code` ensure path.
21. **Admin Referral audit evidence** — read-only decisions/rewards with provenance + reversal
    state; no financial mutation endpoints.
22. **Runtime redrive/recovery** — activation / issuance / maturity batches; silent
    post-maturity catch removed; issuance redrive for AVAILABLE AD sources.

Out of scope (explicit non-delivery): Phase 16 Mission Engine; production Referral rule/rate/
budget/code-policy seeds; AdsGram production monetary; Mainnet; auto payout; client-selected
referrer codes; Bot attribution authority.

---

## C. Files / modules changed (accepted source)

Representative modules on canonical commit `fe3ac03` (full tree via `git archive`):

- `packages/referrals/**` — rule authority, attribution, activation, effective rate,
  code policy, telegram-links, activation runtime batch, tests
- `packages/rewards/**` — referral issuance, maturity (no silent catch), reversal cascade,
  issuance/maturity maintenance batches, tests
- `packages/auth/**` — first-login signed `start_param` attribution integration
- `packages/telegram/**` — initData HMAC validation used by attribution path
- `packages/config/**` — typed optional `TELEGRAM_PUBLIC_BOT_USERNAME` (Api + Bot)
- `packages/contracts/**` — Referral / Admin Referral DTOs
- `apps/api/**` — `ReferralsController` summary/code; Admin Referral read model
- `apps/bot/**` — public `/start` Referral transport bridge (Control Center unchanged)
- `apps/worker/**` — Phase 15 maintenance loop (activation → issuance → maturity)
- `apps/miniapp/**` — FriendsScreen + `getReferralCode` (server-authoritative)
- `migrations/0044` … `0050` Phase 15 forward migrations
- `scripts/verify-boundaries.mjs` — Phase 15 package edge rules

---

## D. Database migrations

Verified repository filenames (Phase 15 forward migrations):

| Migration | Purpose / integrity | Seed status |
| --------- | ------------------- | ----------- |
| `0044_phase15_referral_rule_integrity.sql` | `referral_rule_versions`; edge/code/reward-event integrity; `reward_rules.referral_eligible`; FOR SHARE first-reference | **NO production seed** |
| `0045_phase15_referral_reference_hardening.sql` | Terminal edge provenance freeze; orphan rule FK fail-closed; VALIDATE FKs | **NO production seed** |
| `0046_phase15_referral_rate_provenance.sql` | `referral_reward_events` rate_source + membership entitlement provenance | **NO production seed** |
| `0047_phase15_referral_reward_issuance.sql` | `referral_reward_decisions` + exposure reservations | **NO production budget seed** |
| `0048_phase15_referral_code_policy.sql` | `referral_code_policy_versions` + `generation_policy_version` pin | **NO production alphabet/length seed** |
| `0049_phase15_referral_remediation.sql` | Referenced code-policy `effective_to` safe closure; decision rule/membership provenance columns | **NO production seed** |
| `0050_phase15_telegram_referral_transport.sql` | `code_length` ≤ 60; alphabet `[A-Za-z0-9_-]` DB constraints | **NO production seed** |

Only `schema_migrations` inserts appear in these files.  
**NO production Referral rule / base rate / REFERRAL_RATE_BOOST / MAX_REFERRAL_BONUS_DAILY /
code policy is inserted.**

---

## E. Commands executed (final pre-archive gate)

Isolated DB URLs only (`*_test` / `*_tests` on docker `:55432`). Never operational `alex_rewards`
as financial source for suites.

```text
pnpm validate:migrations          # 50 migrations PASS
pnpm verify:boundaries            # 8 apps, 21 packages PASS
pnpm security:secrets             # PASS
pnpm --filter @alex-rewards/config typecheck|test|build      # 71 PASS
pnpm --filter @alex-rewards/telegram typecheck|test|build    # 13 PASS
pnpm --filter @alex-rewards/auth typecheck|test|build        # 84 PASS | 6 skipped (harness)
pnpm --filter @alex-rewards/referrals typecheck|test|build   # 63 PASS
pnpm --filter @alex-rewards/rewards typecheck|test|build     # 78 PASS
pnpm --filter @alex-rewards/worker typecheck|test|build      # 12 PASS
pnpm --filter @alex-rewards/api typecheck|test|build         # 83 PASS | 4 skipped
pnpm --filter @alex-rewards/bot typecheck|test|build         # 5 PASS
pnpm --filter @alex-rewards/miniapp typecheck|test|build     # 134 PASS
pnpm test:phase3                  # 21 PASS
pnpm test:phase4                  # 43 PASS
pnpm test:phase5                  # 59 PASS
pnpm test:phase7                  # 124 PASS
pnpm test:phase8                  # 52 PASS
pnpm test:phase10                 # signing 5 (+3 skipped) + withdrawals 324 + ton 54 PASS
pnpm test:phase11                 # 45 PASS
pnpm test:phase13                 # auth 11 + ads 3 + api 52 + admin 12 PASS
pnpm test:phase14                 # fraud 230 + api fraud-admin 18 PASS
pnpm test:phase15                 # referrals 63 + auth 7 + rewards 23 PASS
pnpm typecheck                    # PASS
pnpm build                        # PASS

pnpm archive:phase -- --phase 15 --slug REFERRAL_MEMBERSHIP \
  --commit fe3ac03b056d4a81d06f964109bb305c7cf7149a \
  --report docs/PHASE_15_ACCEPTANCE_REPORT.md \
  --roadmap-version 1.3 \
  --next-phase-status "No Phase 16 work has started at packaging time." \
  --stamp 20260929-075558
```

---

## F. Unit / integration / E2E / failure / security test evidence

**ATTRIBUTION**

- Signed `start_param` accepted; tamper / bad HMAC rejected (`packages/auth` Phase 15).
- First-login-only attribution; self-referral blocked; one-time edge; concurrent
  same/different code (`packages/referrals` attribution DB tests).

**ACTIVATION**

- Age below threshold → STILL_PENDING; AVAILABLE AD count; PENDING/REVERSED/non-AD excluded.
- OPEN CRITICAL → REJECTED; Founder cannot bypass CRITICAL.
- Real concurrency: fraud-first (uncommitted flag blocks activation → REJECTED);
  activation-first (fraud INSERT blocks until ACTIVE commit).
- Age-only later activation via `processPendingReferralActivationBatch`.

**RATE**

- Base rule vs MEMBERSHIP_PROFILE replacement; no additive boost; ambiguity fail-closed;
  no hardcoded 500/700 bps in product paths.

**ISSUANCE**

- `referral_eligible` required; no retroactive pre-activation bonus; FLOOR; invitee unchanged;
  platform expense; budget missing/exhausted fail-closed; duplicate retry safe; transient
  issuance redrive without fabricating SKIPPED decisions.

**MATURITY / REVERSAL**

- Referral reward starts PENDING; due maturity batch; origin AVAILABLE check;
  cascade always on public reverse; no public skip; historical ledger immutable;
  linked REWARD_REVERSAL; retry idempotent; negative-balance protection.

**TELEGRAM TRANSPORT**

- Alphabet `[A-Za-z0-9_-]`; codeLength 60 accepted / 61+ rejected; `ref_`+60 = 64;
  public `?start=ref_<code>`; Bot `?startapp=ref_<code>`; signed Mini App authority preserved;
  historical unsafe code → deepLink null.

**UI / API**

- Friends server invited/activated counts; code ensure when summary code null;
  honest NOT_CONFIGURED; no hardcoded percentage; Admin read-only audit with decision/
  reward/reversal provenance.

**REFERRAL_LIST_API:** **NOT_IMPLEMENTED** — Friends is satisfied by summary + code surfaces.

---

## G. Build / health results

- Repo `pnpm typecheck` / `pnpm build`: **PASS** (closure gate).
- Service health endpoints unchanged for archive scope; no deployment performed.

---

## H. CI / remote deployment status (observed)

At independent review immediately before archive, for commit
`fe3ac03b056d4a81d06f964109bb305c7cf7149a`:

| Context | Observed state | Link |
| ------- | -------------- | ---- |
| Vercel – `alex-rewards-miniapp` | **SUCCESS** | https://vercel.com/y720183p-2353s-projects/alex-rewards-miniapp/eAKQNGbFMhmHs2hskzi3xwHUmard |
| Vercel – `alex-isolated-ton-proof-testnet` | **FAILURE** | https://vercel.com/y720183p-2353s-projects/alex-isolated-ton-proof-testnet/GHhv7tNucTUdW7LQjZj2EFwDzWSQ |

This report does **not** claim “all remote CI green.” The isolated-ton-proof failure is
historically known and unrelated to Phase 15 Referral.

---

## I. Known deviations

1. **Activation default profile vs production seed.** Master Spec §80 default behavioral
   profile is account age ≥ 24h (86,400 seconds) AND ≥ 5 valid rewarded ads AND no Critical
   Fraud. The engine is versioned/configurable and tests cover that profile. Phase 15 does
   **NOT** seed an ACTIVE production `referral_rule_versions` row. Runtime remains fail-closed
   until Owner-approved configuration is installed. Those values are **not** claimed as live
   production configuration.
2. **5% placeholder.** Spec placeholder rate is **not** hardcoded and **not** production-seeded.
3. **Telegram transport config.** Public share/bridge requires typed
   `TELEGRAM_PUBLIC_BOT_USERNAME` (no source default) and Telegram-side Main Mini App
   configuration for `?startapp=`. External Main Mini App config:
   **REQUIRED_NOT_VERIFIED**.
4. **REFERRAL_LIST_API:** **NOT_IMPLEMENTED**. Not a Phase 15 blocker: Friends uses
   server summary + code ensure.
5. **No deployment** occurred during Phase 15 closure.

---

## J. Open blockers / technical debt

**IMPLEMENTATION BLOCKERS:** **NONE**

**LAUNCH CONFIGURATION REQUIRED** (Owner / ops — do not invent in source):

- ACTIVE production referral rule (including approved age/ad thresholds)
- Owner-approved effective base Referral rate
- ACTIVE Telegram-safe code policy
- `MAX_REFERRAL_BONUS_DAILY` production limit
- optional/approved `REFERRAL_RATE_BOOST` entitlement values
- `TELEGRAM_PUBLIC_BOT_USERNAME`
- Telegram Main Mini App external configuration

Also recorded (unchanged platform posture):

- AdsGram production monetary remains **BLOCKED**
- Mainnet **NOT ACTIVATED**; Auto payout **NO**

These items do **not** authorize production Referral money.

---

## K. Security / financial invariant checks

| Invariant | Result |
| --------- | ------ |
| CLIENT_REFERRER_AUTHORITY | **NONE** |
| CLIENT_REFERRAL_CODE_AUTHORITY | **NONE** |
| CLIENT_EDGE_STATE_AUTHORITY | **NONE** |
| CLIENT_ACTIVATION_RESULT_AUTHORITY | **NONE** |
| CLIENT_VALID_AD_COUNT_AUTHORITY | **NONE** |
| CLIENT_ACCOUNT_AGE_AUTHORITY | **NONE** |
| BOT_ATTRIBUTION_AUTHORITY | **NONE** |
| BOT_FINANCIAL_AUTHORITY | **NONE** |
| SIGNED_TELEGRAM_INITDATA_REQUIRED | **YES** |
| SELF_REFERRAL | **BLOCKED** |
| ATTRIBUTION_SWAP | **BLOCKED** |
| ONE_TIME_ATTRIBUTION | **YES** |
| LEVEL_1_ONLY | **YES** |
| FOUNDER_CRITICAL_FRAUD_BYPASS | **NO** |
| FOUNDER_DUPLICATE_BONUS_BYPASS | **NO** |
| MEMBERSHIP_SECURITY_BYPASS | **NO** |
| REFERRAL_RATE_SEMANTICS | **EFFECTIVE_REPLACEMENT** |
| ADDITIVE_MEMBERSHIP_RATE | **NO** |
| FIVE_PERCENT_HARDCODED | **NO** |
| INVITEE_REWARD_REDUCED | **NO** |
| REFERRAL_EXPENSE | **PLATFORM_FUNDED** |
| REFERRAL_ARITHMETIC | **INTEGER_FLOOR** |
| SOURCE_REFERRAL_ELIGIBLE_REQUIRED | **YES** |
| PRE_ACTIVATION_RETROACTIVE_REWARD | **NO** |
| REFERRAL_REWARD_INITIAL_STATE | **PENDING** |
| MAX_REFERRAL_BONUS_DAILY_ENFORCED | **YES_WHEN_CONFIGURED** |
| MISSING_BUDGET_BEHAVIOR | **FAIL_CLOSED** |
| HISTORICAL_LEDGER_MUTATION | **NO** |
| REVERSAL_NEW_LINKED_TRANSACTION | **YES** |
| PUBLIC_REVERSAL_CASCADE_BYPASS | **NO** |
| HIDDEN_NEGATIVE_BALANCE | **NO** |
| REFERRAL_RUNTIME_REDRIVE | **YES** |
| MAINNET_ACTIVATED | **NO** |
| AUTO_PAYOUT | **NO** |
| ADSGRAM_PRODUCTION_MONETARY | **BLOCKED** |
| PRODUCTION_REFERRAL_RULE_SEEDED | **NO** |
| PRODUCTION_REFERRAL_CODE_POLICY_SEEDED | **NO** |
| PRODUCTION_BASE_REFERRAL_RATE_SEEDED | **NO** |
| PRODUCTION_REFERRAL_RATE_BOOST_SEEDED | **NO** |
| PRODUCTION_MAX_REFERRAL_BONUS_DAILY_SEEDED | **NO** |
| TELEGRAM_PUBLIC_BOT_USERNAME_DEFAULT | **NONE** |
| TELEGRAM_MAIN_MINI_APP_EXTERNAL_CONFIG | **REQUIRED_NOT_VERIFIED** |
| PRODUCTION_REFERRAL_MONEY_ACTIVE | **NO** |
| TELEGRAM_START_ALLOWED_ALPHABET | **[A-Za-z0-9_-]** |
| MAX_GENERATED_REFERRAL_CODE_LENGTH | **60** |
| PUBLIC_REFERRAL_LINK | **?start=ref_\<code\>** |
| BOT_MINIAPP_BRIDGE | **?startapp=ref_\<code\>** |

---

## L. Rollback / recovery

- Migrations 0044–0050 are forward schema history; do not rewrite historical migrations.
- Runtime processors (activation / issuance / maturity) are idempotent and retriable.
- Referral decisions are durable; reward ledger transactions are immutable.
- Reversal uses compensating linked `REWARD_REVERSAL` transactions (no historical mutation).
- PENDING activation/reward states can be safely redriven by worker batches.
- Absent production policies fail closed (no invented rates/budgets/codes).
- Worker restart does not depend on in-memory financial truth.
- Environments that must not run Phase 15 leave 0044–0050 unapplied; stop using commits after
  Phase 14 tip on this branch for those environments.

---

## M. Exact accepted commit SHA

**CANONICAL_ACCEPTED_SOURCE_COMMIT:**

`fe3ac03b056d4a81d06f964109bb305c7cf7149a`

**Branch:** `phase15-referral-membership`

A later documentation-only commit may record this acceptance report; it is **not** the
canonical Phase 15 software source. Archive packaging always targets the canonical SHA above.

---

## N. Gate PASS/FAIL

| Gate | Result |
| ---- | ------ |
| validate:migrations (50) | **PASS** |
| verify:boundaries | **PASS** |
| security:secrets | **PASS** |
| config typecheck/test/build | **PASS** |
| telegram typecheck/test/build | **PASS** |
| auth typecheck/test/build | **PASS** |
| referrals typecheck/test/build | **PASS** |
| rewards typecheck/test/build | **PASS** |
| worker typecheck/test/build | **PASS** |
| api typecheck/test/build | **PASS** |
| bot typecheck/test/build | **PASS** |
| miniapp typecheck/test/build | **PASS** |
| test:phase3 | **PASS** |
| test:phase4 | **PASS** |
| test:phase5 | **PASS** |
| test:phase7 | **PASS** |
| test:phase8 | **PASS** |
| test:phase10 | **PASS** |
| test:phase11 | **PASS** |
| test:phase13 | **PASS** |
| test:phase14 | **PASS** |
| test:phase15 | **PASS** |
| typecheck (repo) | **PASS** |
| build (repo) | **PASS** |
| Telegram transport | **PASS** |
| Fraud concurrency (fraud-first + activation-first) | **PASS** |
| Referral activation | **PASS** |
| Referral economics (replacement rate / FLOOR / invitee unchanged) | **PASS** |
| Referral budget fail-closed | **PASS** |
| Referral maturity | **PASS** |
| Referral reversal cascade | **PASS** |
| Membership effective rate | **PASS** |
| Friends authority | **PASS** |
| Admin audit (read-only) | **PASS** |
| No production policy seeds | **PASS** |
| Phase 16 not started | **PASS** |
| **PHASE15_GATE** | **PASS** |

Required DB suites were executed against isolated databases; none were silently skipped to
force a green result.

---

## O. Archive verification

Archive helper version: **2.1.0**  
Fixed packaging stamp: **20260929-075558**  
Exact accepted source commit: `fe3ac03b056d4a81d06f964109bb305c7cf7149a`

| Artifact | Result |
| -------- | ------ |
| Canonical source ZIP | `ALEx_Rewards_PHASE_15_REFERRAL_MEMBERSHIP_20260929-075558_fe3ac03.zip` |
| Canonical source ZIP path | `phase-archives/PHASE_15_REFERRAL_MEMBERSHIP/ALEx_Rewards_PHASE_15_REFERRAL_MEMBERSHIP_20260929-075558_fe3ac03.zip` |
| Canonical source ZIP SHA256 | `1240e963ccf8d9ad6424cb9ec9333df1f2f9268d93a23c1877b5c377b28ed585` |
| Final review-package filename | `PHASE_15_REFERRAL_MEMBERSHIP_PACKAGE_20260929-075558_fe3ac03.zip` |
| Source extraction | **PASS** |
| Outer package extraction | **PASS** |
| Prohibited-path scan (source + outer) | **PASS** |
| Nested source validation | **PASS** |
| Forward-slash ZIP entry names | **PASS** (4 entries under `PHASE_15_REFERRAL_MEMBERSHIP/`) |

Final review-package SHA256 is recorded externally in `PACKAGE_SHA256.txt` beside the package.
