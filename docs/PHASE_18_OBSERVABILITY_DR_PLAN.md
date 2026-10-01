# Phase 18 — Observability / DR / Business Health Plan

Status: Step 3 operational closure in progress. Step 2B CLOSED / PASS.
Archive slug: `PHASE_18_OBSERVABILITY_DR` — status **CLOSED / PASS** (`PHASE18_ARCHIVE=PASS`; Phase 19 NOT STARTED).
Gate: isolated restore drill PASSED with payout dispatch paused; **no automatic resume**.

Semantic markers: STEP2B_COMPLETED, FULL_TECHNICAL_RESTORE_GATE_PASS, PAYOUT_RESUME_OWNER_GATED, PHASE18_ARCHIVE_PASS, AUTO_UNPAUSE_FALSE, AUTO_RESEND_FALSE.\n\nHistorical Step 3 marker ARCHIVE_PENDING is superseded by Owner acceptance and sealed archive (`PHASE18_ARCHIVE_PASS`). Archive acceptance does not authorize payout resume.

Classification key (Step 3):
- `COMPLETE` — software/ops contract satisfied for Phase 18 source closure
- `OWNER_POLICY_REQUIRED` — Owner numeric/policy decision still required
- `EXTERNAL_INTEGRATION_OPTIONAL` — optional hosted vendor / pager delivery not selected
- `PHASE18_ARCHIVE_PASS` — Phase 18 archive pack sealed and verified

Canonical companions:
- `docs/PHASE_18_REQUIREMENT_CLOSURE_MATRIX.md`
- `docs/PHASE_18_OWNER_POLICY_REGISTER.md`

---

## Verified Step 2B result (no secrets)

| Field | Value |
| --- | --- |
| PITR | ENABLED |
| Managed approach | Railway managed PostgreSQL PITR / pgBackRest |
| Restore drill | PASS |
| Restore type | isolated sibling service |
| Restore target | 2026-10-01T03:48:46.745Z |
| Source/target isolation | PASS |
| Representative count comparison | EXACT_MATCH |
| Selected user histories | 4/4 PASS (privacy-safe SHA-256 userReference) |
| Temporal reconciliation | PASS |
| Chain reconciliation | PASS — NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE |
| Full technical restore gate | PASS (`fullRestoreGatePass=true`) |
| Payout resume | OWNER APPROVAL REQUIRED (`PAYOUT_RESUME_ALLOWED=false`) |
| Auto-unpause | false |
| Auto-resend | false |
| STAGING PAYOUT_DISPATCH_PAUSE | true (must remain during Phase 18 closure) |
| Application cutover | none (apps remain on source Postgres) |

Step 2B runtime evidence recorded under untracked `phase18-runtime-evidence/` (filenames only; not committed), including `source-capture-20261001-034845.json` and Phase 18 restore-drill JSON/Markdown reports.
Independent infrastructure review confirmed Step 2B CLOSED / PASS.

---

## Capability closure (summary)

| # | Area | Status |
| --- | --- | --- |
| 1 | Alerts (`packages/ops-health`) | COMPLETE; thresholds/pager OWNER_POLICY_REQUIRED |
| 2 | Dashboards (Admin System Health) | COMPLETE in-app; hosted Grafana/Datadog EXTERNAL_INTEGRATION_OPTIONAL |
| 3 | PostgreSQL / Redis / Temporal / Bot health components | COMPLETE as System Health identifiers (missing signal → UNKNOWN) |
| 4 | AdsGram / provider health & limits | COMPLETE alerts; near-limit thresholds OWNER_POLICY_REQUIRED |
| 5 | TON RPC primary/secondary components | COMPLETE identifiers; missing signal → UNKNOWN |
| 6 | Signer / Hot Wallet coverage alerts | COMPLETE fail-closed without inventing readiness OK |
| 7 | Outbox lag / reconciliation alerts | COMPLETE; lag threshold OWNER_POLICY_REQUIRED |
| 8 | Reward / Founder budget exposure alerts | COMPLETE; near-exhaustion OWNER_POLICY_REQUIRED |
| 9 | Review Queue backlog alerts | COMPLETE; count/age OWNER_POLICY_REQUIRED |
| 10 | Payout dispatch pause | COMPLETE authority; STAGING remains paused |
| 11 | Backups / PITR | COMPLETE enabled + trusted via isolated drill; RTO/RPO OWNER_POLICY_REQUIRED |
| 12 | Isolated restore drill | COMPLETE Step 2B PASS |
| 13 | Incident runbooks | COMPLETE in `docs/INCIDENT_RESPONSE.md` (SLA OWNER_POLICY_REQUIRED) |
| 14 | Signer rotation / Hot Wallet retirement docs | COMPLETE (docs only; no live rotation in Step 3) |
| 15 | Archive / restore documentation | PHASE18_ARCHIVE_PASS / CLOSED |

See the closure matrix for implementation locations and fail-closed threshold notes.

---

## System Health required components (12)

Must remain represented; missing authoritative signal → `UNKNOWN` / `SIGNAL_NOT_CONFIGURED` (never fabricated OK):

API, POSTGRES, REDIS, TEMPORAL, TELEGRAM_BOT, ADS_PROVIDER, TON_RPC_PRIMARY, TON_RPC_SECONDARY, SIGNER, HOT_WALLET_CHAIN_SYNC, OUTBOX_LAG, RECONCILIATION.

## Business alert classes (required)

OUTBOX_LAG, RECONCILIATION_MISMATCH, PROVIDER_HEALTH, PROVIDER_LIMIT, PROVIDER_SETTLEMENT, REWARD_BUDGET_EXPOSURE, FOUNDER_BONUS_BUDGET_EXPOSURE, REVIEW_QUEUE_BACKLOG, HOT_WALLET_COVERAGE, SIGNER_NOT_READY, PAYOUT_DISPATCH_PAUSE.

No alert evaluator may: post ledger entries, mutate withdrawals, override provider hard limits, override budgets, resolve Review Queue cases, or unpause payouts.

---

## Delivery maps

### Step 1
Typed System Health + alert evaluation (`packages/ops-health`), Admin `GET /v1/admin/system`, read-only System page, metrics export, payout pause observation only.

### Step 2A
Restore-drill DB-only tooling, host isolation, read-only pool, schema/pause/ledger/withdrawal/outbox/counts/user-history contracts.

### Step 2B (completed)
Railway-managed PITR enablement, isolated sibling restore, FULL_STEP2B gate including source-count artifact binding, Temporal visibility reconciliation, chain empty-scope reconciliation, privacy-safe all-user verification.

### Step 3 (this step)
Strict RFC3339 restore timestamp hardening; documentation truth; incident playbooks; Owner operations procedures; Owner policy register; closure matrix; documentation truth tests. **No archive. No pause change. No Railway mutation.**

---

## Explicit non-goals (Step 3)

- No Phase 18 archive ZIP / acceptance pack creation
- No marking Phase 18 CLOSED
- No change to `PAYOUT_DISPATCH_PAUSE` (must remain true on STAGING)
- No auto-unpause / auto-resend
- No ledger / withdrawal / Outbox mutation
- No sibling delete / new PITR restore / PITR disable
- No deploy / Mainnet / production monetary / AdsGram monetary enablement
- No Phase 19 start
- No invented numeric thresholds or hosted monitoring vendors
