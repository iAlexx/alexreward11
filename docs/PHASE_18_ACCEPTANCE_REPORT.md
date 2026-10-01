# Phase 18 Acceptance Report - Observability / DR / Business Health

**Status:** **PASS**

**Phase slug:** `PHASE_18_OBSERVABILITY_DR`
**Master specification:** Version 1.3
**Canonical accepted source commit:** `654a7097456d7d18ad6e6a7072793ee6d353ca33`
**Branch:** `phase18-observability-dr`

**PHASE18_GATE:** **PASS**
**PHASE18_STATUS:** **ACCEPTED / PACKAGING IN PROGRESS** (updated to CLOSED / PASS after archive seal)

**PAYOUT_RESUME_ALLOWED:** **false**
**AUTO_UNPAUSE:** **false**
**AUTO_RESEND:** **false**
**STAGING PAYOUT_DISPATCH_PAUSE:** **true** (UNCHANGED; archive does **not** authorize resume)
**Mainnet:** **NOT ACTIVATED**
**Production monetary:** **NOT ENABLED**
**AdsGram production monetary:** **BLOCKED**
**Phase 19:** **NOT STARTED**

Archive acceptance does **not** authorize payout resume.

---

## A. Phase identification / status

Complete Master Specification V1.3 Phase 18 — Observability / Disaster Recovery / Business Health.

Owner / independent review accepted Phase 18 implementation. This report packages acceptance
documentation and the `PHASE_18_OBSERVABILITY_DR` archive only.

**PHASE18_GATE = PASS** with financial freeze retained:
`PAYOUT_RESUME_ALLOWED=false`, `AUTO_UNPAUSE=false`, `AUTO_RESEND=false`, STAGING
`PAYOUT_DISPATCH_PAUSE=true`.

---

## B. Accepted scope

Accepted capabilities on canonical source `654a7097456d7d18ad6e6a7072793ee6d353ca33`:

1. Typed read-only system/business health model (`packages/ops-health`)
2. Admin System Health surface (`SystemPage` + `GET /v1/admin/system`)
3. Required 12 health components represented
4. Missing authoritative signals fail closed as `UNKNOWN` / `SIGNAL_NOT_CONFIGURED`
5. Provider health/limit monitoring
6. Provider settlement/reconciliation monitoring
7. Reward budget exposure monitoring
8. Founder bonus budget exposure monitoring
9. Review Queue backlog monitoring
10. Outbox lag and reconciliation monitoring
11. Authoritative payout pause observation
12. Railway-managed PostgreSQL PITR enabled
13. Successful isolated sibling restore
14. Restore validator read-only enforcement
15. Source/restored representative count exact comparison
16. Privacy-safe all-user history verification
17. Temporal visibility reconciliation
18. Chain reconciliation with legitimate empty scope
19. Incident response playbooks (`docs/INCIDENT_RESPONSE.md`)
20. Owner operations runbook (`docs/OPERATIONS_RUNBOOK.md`)
21. Signer rotation / Hot Wallet retirement documentation
22. Strict RFC3339 restore evidence binding
23. Archive/restore procedures (`docs/PHASE_ARCHIVE.md`, `docs/DISASTER_RECOVERY.md`)

Out of scope / non-delivery: Phase 19; payout resume; Mainnet; production monetary; AdsGram
production monetary; live signer rotation; sibling cleanup; Railway mutation during archive.

---

## C. Files / modules changed (accepted source)

Representative modules on canonical commit `654a709` (full tree via `git archive` of that SHA).
Major Phase 18 surfaces:

**Ops health**

- `packages/ops-health/**` — typed evaluate/metrics/pure health model
- `apps/api/src/admin/system.controller.ts` — Admin system health read API
- `apps/admin/src/components/pages/SystemPage.tsx` — Admin System Health UI
- `apps/api/test/phase18-ops-health.test.ts`
- `apps/admin/test/phase18-system-health.test.ts`

**Restore drill / DR**

- `packages/restore-drill/**` — isolated restore validator (DB_ONLY_STEP2A / FULL_STEP2B)
- Strict RFC3339 target binding, source-count artifact, Temporal + chain reconciliation
- Fail-closed read-only pool / host isolation / no auto-unpause / no auto-resend

**Operations documentation**

- `docs/PHASE_18_OBSERVABILITY_DR_PLAN.md`
- `docs/PHASE_18_REQUIREMENT_CLOSURE_MATRIX.md`
- `docs/PHASE_18_OWNER_POLICY_REGISTER.md`
- `docs/INCIDENT_RESPONSE.md`
- `docs/OPERATIONS_RUNBOOK.md`
- `docs/DISASTER_RECOVERY.md`
- `docs/TON_SIGNER.md`
- `docs/PHASE_ARCHIVE.md`

Untracked runtime evidence under `phase18-runtime-evidence/` is **not** part of the accepted
source tree and must not enter the archive.

---

## D. Database / infrastructure changes

| Item | Result |
| ---- | ------ |
| New Phase 18 SQL migrations | **NONE** |
| Migration head (unchanged) | `0058_phase17_publication_delivery_snapshot` |
| Migration count | **58** |
| Source Postgres | SUCCESS (apps remain bound) |
| Restore sibling Postgres | SUCCESS / retained temporarily as DR evidence |
| PITR | ENABLED (Railway managed) |
| Phase 18 archive task Railway mutation | **NONE** |
| Application DB cutover | **NONE** |
| Source DB mutation during drill/archive | **NONE** |
| Sibling DB mutation during archive | **NONE** |

---

## E. Commands executed (final pre-archive gate)

Executed against software HEAD matching canonical `654a709` before documentation commit:

```text
pnpm --filter @alex-rewards/restore-drill typecheck|build|test
pnpm --filter @alex-rewards/ops-health typecheck|build|test
pnpm --filter @alex-rewards/api typecheck
pnpm --filter @alex-rewards/admin typecheck
pnpm --filter @alex-rewards/api exec vitest run test/phase18-ops-health.test.ts
pnpm --filter @alex-rewards/admin exec vitest run test/phase18-system-health.test.ts
pnpm validate:migrations
pnpm verify:boundaries
pnpm security:secrets
git diff --check
```

Archive packaging:

```text
pnpm archive:phase -- --phase 18 --slug OBSERVABILITY_DR \
  --commit 654a7097456d7d18ad6e6a7072793ee6d353ca33 \
  --report docs/PHASE_18_ACCEPTANCE_REPORT.md \
  --roadmap-version 1.3 \
  --next-phase-status "No Phase 19 work has started at packaging time." \
  --stamp 20261001-175223
```

No financial live operations re-run. No signer unlock. No TON broadcast. No payout pause change.

---

## F. Test / security evidence

| Suite | Result |
| ----- | ------ |
| restore-drill typecheck / build | **PASS** |
| restore-drill tests | **PASS** 82/82 |
| ops-health typecheck / build | **PASS** |
| ops-health tests | **PASS** 24/24 |
| API typecheck | **PASS** |
| Admin typecheck | **PASS** |
| API `phase18-ops-health` tests | **PASS** 3/3 |
| Admin `phase18-system-health` tests | **PASS** 2/2 |
| `pnpm validate:migrations` | **PASS** (58) |
| `pnpm verify:boundaries` | **PASS** |
| `pnpm security:secrets` | **PASS** |
| `git diff --check` | **PASS** |

DB/env-gated live financial suites were **not** re-executed for this archive closeout (honest skip).

---

## G. Runtime / DR evidence (Step 2B)

Accepted facts from Owner/independent Step 2B review (no secrets / no raw UUIDs / no connection strings):

| Field | Value |
| ----- | ----- |
| PITR | ENABLED |
| Restore target | `2026-10-01T03:48:46.745Z` |
| Restore type | isolated sibling PostgreSQL service |
| Source/target isolation | PASS |
| Schema | PASS |
| Migration head | `0058_phase17_publication_delivery_snapshot` |
| Migration count | 58 |
| Payout pause | PASS / true |
| Database read-only (validator) | true |
| Ledger invariants | PASS |
| Withdrawal restore reconcile | PASS |
| Outbox | PASS |
| Representative source/restored counts | EXACT MATCH |
| Users verified | 4/4 |
| User references | privacy-safe SHA-256 only |
| Temporal | queried successfully; 0 expected; 0 observed; PASS |
| Chain | `CHAIN_SCOPE_EMPTY=true`; `NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE`; provider query not required; PASS |
| fullRestoreGatePass | true |
| PAYOUT_RESUME_ALLOWED | false |
| AUTO_UNPAUSE | false |
| AUTO_RESEND | false |
| Observed RTO (Step 2B.1) | 192.9 seconds (**observation only**) |
| Observed RPO (Step 2B.1) | 0 seconds (**observation only**) |
| RTO_TARGET | OWNER_POLICY_REQUIRED |
| RPO_TARGET | OWNER_POLICY_REQUIRED |

No SLA compliance claim: Owner RTO/RPO targets are unset.

No source DB mutation. No sibling DB mutation. No app DB cutover. No auto-unpause. No auto-resend.

Restore sibling retained temporarily as DR evidence infrastructure; cleanup is a separate
Owner-approved action after archive review.

---

## H. Remote / infrastructure status

**Do not claim ALL REMOTE CI GREEN.**

| Surface | Status for canonical `654a709` |
| ------- | ------------------------------ |
| Vercel project `alex-rewards-miniapp` | **READY / successful** (relevant LOOTRA Mini App deployment) |
| Vercel project `alex-isolated-ton-proof-testnet` | **FAILED** (`invalid_engines_value`; `npm install` exit 1) |
| Legacy isolated Vercel failure classification | **PRE-EXISTING / OUT-OF-SCOPE LEGACY ISOLATED VERCEL PROJECT STATUS** (repeated failures across earlier / pre-Phase-18 commits; not fixed/deleted/reconfigured in this archive task) |
| Railway source Postgres | SUCCESS |
| Railway retained restore sibling | SUCCESS |
| Phase 18 Step 3 / archive Railway deployment/mutation | NONE |
| Application services DB binding | remained on source Postgres |
| PITR bucket | remained present |
| Manual deploy for archive | NONE |
| Mainnet deployment | NONE |

---

## I. Owner-policy items intentionally unresolved

Non-blocking for Phase 18 source closure; each remains **OWNER_POLICY_REQUIRED** (no invented values):

- RTO target
- RPO target
- Outbox lag warning threshold
- Provider near-limit warning threshold
- Provider settlement variance materiality threshold
- Reward budget near-exhaustion threshold
- Founder bonus budget near-exhaustion threshold
- Review Queue backlog count/age threshold
- Alert/pager destination
- Optional hosted dashboard vendor
- Incident response numeric SLA / on-call assignment

See `docs/PHASE_18_OWNER_POLICY_REGISTER.md`.

---

## J. Open blockers / technical debt

**IMPLEMENTATION BLOCKERS:** NONE for Phase 18 archive acceptance.

**OWNER / OPERATIONS FOLLOW-UPS (do not authorize money):**

- Set OWNER_POLICY_REQUIRED thresholds / pager destination when ready
- Owner-approved payout resume ceremony (separate from archive)
- Restore sibling cleanup after archive review
- Live signer rotation / Hot Wallet retirement drill when Owner schedules
- Optional hosted dashboard vendor selection

---

## K. Security / financial invariant table

| Invariant | Value |
| --------- | ----- |
| PHASE18_GATE | PASS |
| PAYOUT_RESUME_ALLOWED | false |
| AUTO_UNPAUSE | false |
| AUTO_RESEND | false |
| PAYOUT_DISPATCH_PAUSE_STAGING | true (UNCHANGED) |
| ARCHIVE_AUTHORIZES_RESUME | NO |
| RESTORE_VALIDATOR_READ_ONLY | YES |
| SOURCE_DB_MUTATION_BY_DRILL | NO |
| SIBLING_DB_MUTATION_BY_ARCHIVE | NO |
| APP_DB_CUTOVER | NO |
| MAINNET_ACTIVATED | NO |
| PRODUCTION_MONETARY_ENABLED | NO |
| ADSGRAM_PRODUCTION_MONETARY | BLOCKED |
| PHASE19_STARTED | NO |
| MISSING_HEALTH_SIGNAL | UNKNOWN / SIGNAL_NOT_CONFIGURED (fail closed) |
| REVIEW_QUEUE_FINANCIAL_AUTHORITY | NO (operational projection only) |
| SIGNER_ISOLATION | YES |
| RUNTIME_EVIDENCE_IN_GIT | NO |

---

## L. Rollback / recovery notes

- Canonical software rollback target for Phase 18 product/ops behavior is `654a709` (not later docs-only commits).
- Restore-drill remains fail-closed and read-only; never unpauses or resends.
- Ops-health remains observation-only; no financial mutation authority.
- If sibling restore evidence is no longer needed, Owner may schedule cleanup separately — do not delete during archive packaging.
- Resume payouts only via Owner high-impact Feature Flags ceremony after reconciliation gates; never from archive acceptance.

---

## M. Exact canonical accepted source SHA

**CANONICAL_ACCEPTED_SOURCE_COMMIT:**

`654a7097456d7d18ad6e6a7072793ee6d353ca33`

**Branch:** `phase18-observability-dr`

Documentation-only closeout commits after that SHA (acceptance report / archive-record) are
**NOT** the canonical software source. Archive packaging always targets the canonical SHA above
via `git archive`.

---

## N. Gate PASS/FAIL

| Gate | Result |
| ---- | ------ |
| restore-drill typecheck / build / test | **PASS** |
| ops-health typecheck / build / test | **PASS** |
| API typecheck + phase18 tests | **PASS** |
| Admin typecheck + phase18 tests | **PASS** |
| validate:migrations | **PASS** |
| verify:boundaries | **PASS** |
| security:secrets | **PASS** |
| git diff --check | **PASS** |
| Isolated restore fullRestoreGatePass | **PASS** |
| PAYOUT_RESUME_ALLOWED | **false** (required) |
| Mainnet active | **NO** (required) |
| Production monetary enabled | **NO** (required) |
| AdsGram production monetary | **BLOCKED** (required) |
| Phase 19 started | **NO** (required) |
| Relevant Vercel miniapp (`alex-rewards-miniapp`) | **READY** |
| Legacy isolated Vercel | **FAILED / OUT-OF-SCOPE** (not green) |
| **PHASE18_GATE** | **PASS** |

---

## O. Archive verification

Archive helper version: **2.1.0**
Fixed packaging stamp: **20261001-175223**
Exact accepted source commit: `654a7097456d7d18ad6e6a7072793ee6d353ca33`

| Artifact | Result |
| -------- | ------ |
| Canonical source ZIP | *(filled after packaging)* |
| Canonical source ZIP SHA256 | *(filled after packaging)* |
| Final review-package filename | *(filled after packaging)* |
| Source extraction | pending packaging |
| Outer package extraction | pending packaging |
| Prohibited-path scan (source + outer) | pending packaging |
| Nested source validation | pending packaging |
| Forward-slash ZIP entry names | pending packaging |
| SHA256SUMS verification | pending packaging |

Final review-package SHA256 is recorded externally in `PACKAGE_SHA256.txt` beside the package.
Section O does **not** embed the outer package SHA256.
