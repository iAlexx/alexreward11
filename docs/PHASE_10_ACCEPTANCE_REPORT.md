# Phase 10 Acceptance Report — TON Testnet Payout

**Status:** **PASS / CLOSED**

**Phase slug:** `PHASE_10_TON_TESTNET_PAYOUT`  
**Master specification:** Version 1.3 (requirements not expressly changed by 1.3 remain in force from 1.2)  
**Accepted commit:** _(filled at packaging — see Section M)_  
**Campaign ID:** `2fdf9a3b-dee5-46e6-a2a4-4a0a10236093`  
**Closed at (UTC):** `2026-09-25T04:11:55.237Z`  
**Owner review approved at (UTC):** `2026-09-25T03:37:02.256Z`  
**Acceptance cutoff (UTC):** `2026-09-25T03:27:18.790Z`

Phase 11 has **not** started at packaging time.

---

## A. Phase objective

Deliver and accept the TON Testnet USDT controlled payout foundation: real-chain payout
pipeline with fail-closed safety, 100 controlled CONFIRMED payouts, six REAL failure
scenarios, provider-backed chain-history proof, Owner review, final evidence archive,
and authoritative Phase 10 closure — without Mainnet, without ops DB mutation, and
without resuming payouts after close.

## B. Exact scope delivered

1. Isolated Testnet payout environment (`alex_rewards_isolated_payout_test` @ `:55440`,
   signer `:3015`, worker `:3014`).
2. Hot-wallet / Jetton USDT Z funding, seqno admission, dual providers (TonAPI + TonCenter).
3. Controlled campaign: **100/100** CONFIRMED payouts; ordinal **101 absent**.
4. Six REAL scenarios: TEP74 dual provider, provider disagree, RPC timeout/unknown,
   signer locked, hot-wallet balance, pause/resume — all PASS.
5. B1 (provider-backed chain history), B2 (schema-v2 live readiness), B3 (canary binding)
   resolved.
6. Technical acceptance:
   `PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED`.
7. Owner review approved; final evidence archive created and verified.
8. Separate closure eligibility gate + `closePhase10({ executeMutation: true })`
   → campaign `COMPLETED`, `phase10Closed=true`.

## C. Files / modules changed (accepted source)

Representative modules (full tree in accepted commit / source ZIP):

- `packages/withdrawals` — payout pipeline, acceptance gate, chain-history, live probes,
  campaign ops CLI, **closure gate** (`phase10-closure-gate.ts`), canary/batch runners,
  DNP hold, failed-pre reuse, USDT Z canary, provider roles.
- `packages/ton` — providers, wallet seqno admission, v5R1 signed external helpers.
- `packages/ledger` — Phase 10 testnet provision, hot-wallet funding, asset catalogue.
- `packages/config` — Phase 10 provision DB-name guards (aalex/USDT).
- `packages/auth` — isolated Telegram first-Owner bootstrap path used for Testnet.
- `apps/worker` — real/fake chain wiring, failed-pre retry outbox batch, payout activity result.
- `migrations/0029_hot_wallet_jetton_asset.sql`
- `docs/DECISIONS.md`, `WITHDRAWALS.md`, `LEDGER.md`, `OPERATIONS_RUNBOOK.md`,
  `OWNER_ADMIN_AUTH.md`, this report.

## D. Database migrations

- Prior Phase 10 foundation migrations (already on isolated DB).
- `migrations/0029_hot_wallet_jetton_asset.sql` — hot-wallet Jetton asset support.

No production/ops DB (`alex_rewards` @ `:55432`) mutations under this acceptance.

## E. Commands executed (representative)

```text
pnpm --filter @alex-rewards/withdrawals build
pnpm --filter @alex-rewards/withdrawals exec vitest run test/phase10-closure-gate.test.ts
node ALExRewards/.../config/_phase10-closure-eligibility-probe.mjs   # read-only
node ALExRewards/.../config/_phase10-execute-final-closure.mjs       # Owner-authorized close
pnpm archive:phase -- --phase 10 --slug TON_TESTNET_PAYOUT --commit <accepted> --report docs/PHASE_10_ACCEPTANCE_REPORT.md ...
```

Isolated ops used `phase10-ops` readiness/preflight/campaign/chain-history-readonly-validate
and controlled batch/canary windows under explicit Owner windows (pause restored after).

## F. Unit / integration / E2E / failure / security evidence

| Evidence | Result |
| -------- | ------ |
| Technical acceptance evaluator | `PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED` (confirmedCount=100) |
| Closure gate unit tests | **23/23 PASS** (`phase10-closure-gate.test.ts`) |
| Acceptance contract roles/cutoff tests | PASS |
| Six REAL scenarios | ALL PASS |
| Campaign | **100/100 COMPLETED** |
| Chain history | expected 100 / matched 100 / unexpected 0; provider-backed; independence proven |
| Closure eligibility (fresh, pre-close) | eligible=true, mayMarkPhase10Closed=true, blockers=[] |
| `closePhase10({ executeMutation: true })` | outcome `CLOSED`; idempotent second call `ALREADY_CLOSED` |
| `phase10-canary-signing-recovery.test.ts` | **21 known failures** — Owner-accepted, unrelated to authoritative acceptance path |

**FULL_REPOSITORY_TEST_SUITE_GREEN:** **NO** (do not claim otherwise).

## G. Build / health results

- `@alex-rewards/withdrawals` build (`tsc -p tsconfig.build.json`): PASS for accepted
  closure/archive tooling.
- Isolated signer `:3015` health/ready at close: custody **LOCKED**, signingReady=false.
- Isolated worker remains fail-closed with REAL=false, FAKE=false after close.

## H. CI run IDs / links

Local/isolated Owner-authorized acceptance. No separate public CI run ID is claimed as
the sole acceptance authority for this package. Historical CI on earlier Phase 10 PRs
exists on the branch history but is not substituted for the live isolated gate results
above.

## I. Known deviations

1. Technical acceptance evaluator still hard-codes `mayMarkPhase10Closed=false`; closure
   uses the **separate** `evaluatePhase10ClosureEligibility` / `closePhase10` stage
   (documented in `docs/DECISIONS.md`).
2. Final evidence archive (2026-09-25T03:44:34Z) is preserved separately from this
   dual source/review packaging; evidence package SHA-256
   `b3f269e050e855a3b860a060c7e5b8195cac98d3af3ec93c8782abfd51610354`.
3. Campaign file hash changed only as authorized COMPLETED control-metadata transition;
   Final Archive ZIP contents remain the pre-close sealed evidence snapshot.
4. Pre-existing typecheck noise may remain in unrelated test files (e.g. success-batch
   runner fixture literals); not treated as Phase 10 acceptance blockers.

## J. Open blockers / technical debt

- None blocking Phase 10 close.
- Known 21 canary-signing-recovery failures remain open technical debt (non-blocking for
  this acceptance by Owner acknowledgment).
- Optional forward work (not Phase 10 close blockers): sealed dual-archive packaging
  (this report), any later Phase 11 AdsGram/provider framework (explicitly **not** started).

## K. Security / financial invariant checks

| Check | At close / packaging |
| ----- | -------------------- |
| Available | 5000000 |
| Reserved | 0 |
| Hot ledger | 6000000 |
| TonAPI JW | 6000000 |
| TonCenter JW | 6000000 |
| Fee revenue | 1000000 |
| Unresolved withdrawals | 0 |
| Active payout leases | 0 |
| Duplicate economic payouts | 0 |
| Payout #101 | absent |
| `PAYOUT_DISPATCH_PAUSE` | true |
| Signer custody | LOCKED |
| REAL / FAKE chain | false / false |
| Closure economic mutation | none |
| Chain mutation during close | none |

## L. Rollback / recovery notes

- Phase 10 is **CLOSED**. Do not re-open by clearing `phase10Closed` or reverting campaign
  to `AWAITING_OWNER_APPROVAL` without new Owner authorization.
- Safety must remain pause=true, signer LOCKED, REAL=false, FAKE=false unless separately
  authorized.
- Evidence archive under
  `phase-archives/PHASE_10_TON_TESTNET_PAYOUT/evidence-archive-preserved-20260925-034434/`
  must not be mutated.
- Closure audit:
  `ALExRewards/isolated-payout-testnet/config/evidence/acceptance/phase10-closure-audit.json`
  (outside git; referenced by hash/metadata in Owner records).

## M. Exact accepted commit SHA

Filled by archive helper into `MANIFEST.md` from `--commit`. Packaging uses the dedicated
Phase 10 accepted commit created for this dual-archive workflow (see MANIFEST).

## N. Final PASS/FAIL for every gate

| Gate | Result |
| ---- | ------ |
| Technical acceptance | **PASS** (`PASS_EVIDENCE_PRESENT_OWNER_REVIEW_REQUIRED`) |
| Owner review | **PASS** (approved) |
| Final evidence archive | **PASS** (valid; preserved) |
| Campaign 100/100 | **PASS** |
| Six REAL scenarios | **PASS** |
| B1 / B2 / B3 | **PASS** |
| Closure eligibility | **PASS** (fresh pre-close) |
| Closure mutation | **PASS** (`CLOSED`) |
| Post-close safety | **PASS** |
| Economic immutability at close | **PASS** |
| Known 21-test documentation | **PASS** (acknowledged; suite not green) |
| Phase 10 closed | **PASS** |
| Phase 11 not started | **PASS** |

## O. Archive verification

Section O does **not** embed the outer review-package SHA-256 (self-reference forbidden).
Authoritative outer hash is only in external `PACKAGE_SHA256.txt` beside the final
review-package ZIP.

After packaging, verify:

1. Canonical source ZIP extracts; prohibited-path scan PASS.
2. Final review-package ZIP extracts; `SHA256SUMS.txt` verifies; nested source validates.
3. External `PACKAGE_SHA256.txt` matches the outer ZIP digest.
4. Preserved evidence archive SHA-256 unchanged:
   `b3f269e050e855a3b860a060c7e5b8195cac98d3af3ec93c8782abfd51610354`.

---

## Known 21-test condition (mandatory)

**File:** `packages/withdrawals/test/phase10-canary-signing-recovery.test.ts`  
**Failing tests:** 21  
**Classification:** unrelated to the authoritative Phase 10 acceptance path  
**Owner:** informed and accepted  
**FULL_REPOSITORY_TEST_SUITE_GREEN:** **NO**  
Tests were not marked PASS, deleted, or result-altered to hide failures.

---

## Explicit non-claims

- No Mainnet
- No ops financial mutation
- No payout #101
- No Phase 11 AdsGram / Provider Framework implementation in this package
- No claim that the full repository test suite is green
