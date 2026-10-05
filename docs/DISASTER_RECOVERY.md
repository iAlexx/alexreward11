# Disaster recovery

Semantic markers: PITR_ENABLED, ISOLATED_RESTORE_DRILL_PASS, FULL_TECHNICAL_RESTORE_GATE_PASS, PAYOUT_RESUME_OWNER_GATED, NO_AUTO_UNPAUSE, SIBLING_RETAINED.

Phase 1 local data remains disposable development data. Production recovery is governed by the Master Spec and the Phase 18 verified drill below.

## Current verified Railway PostgreSQL state (Phase 18 Step 2B CLOSED / PASS)

- Railway-managed PostgreSQL PITR is **ENABLED** (managed PITR / pgBackRest; do not DIY WAL).
- Backup became trusted through a successful **isolated sibling** restore drill.
- Restore target timestamp: `2026-10-01T03:48:46.745Z`.
- Source host and restored sibling host were distinct (isolation PASS).
- Validator enforced read-only DB (`default_transaction_read_only`).
- Representative source/restored counts: EXACT_MATCH.
- Selected user-history verification: 4/4 PASS (privacy-safe SHA-256 userReference only).
- Temporal reconciliation: PASS.
- Chain reconciliation: PASS via legitimate empty-chain scope (`NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE`).
- Payout remained paused (`PAYOUT_DISPATCH_PAUSE=true`); validator did not unpause.
- Source and sibling remained unmodified by the validator.
- No application DB cutover occurred (apps remain bound to source Postgres).
- `fullRestoreGatePass=true` with `PAYOUT_RESUME_ALLOWED=false`, `AUTO_UNPAUSE=false`, `AUTO_RESEND=false`.

Step 2B runtime evidence recorded under untracked `phase18-runtime-evidence/` (e.g. `source-capture-20261001-034845.json` and restore-drill JSON/Markdown). Do not commit credentials or that evidence tree.

### Retained sibling lifecycle

The restore sibling is temporary DR evidence infrastructure. Do **not** delete it in Step 3.
Cleanup requires a separate reviewed Owner-approved action after evidence/archive requirements no longer need it.

### Railway-supported PITR direction (do not DIY WAL)

Railway provides **managed PostgreSQL PITR** using its supported Postgres PITR workflow / pgBackRest integration.

**Do NOT** manually edit:

- `postgresql.conf`
- `archive_mode` / `archive_command` / `restore_command`
- WAL directories

**Do NOT** build a custom WAL archive mechanism in application code.

### Isolation model (host/service based)

A Railway managed PITR restore creates a **separate sibling PostgreSQL service** while restoring the source database cluster contents. A legitimate isolated restore may therefore preserve the **same database name** as source.

Isolation evidence:

- explicit target host binding (`PHASE18_RESTORE_EXPECTED_HOST`)
- source host identity (`PHASE18_SOURCE_DATABASE_HOST`)
- target host **must differ** from source host
- target endpoint identity must differ from operational `DATABASE_URL` endpoint
- exact `current_database()` binding to `PHASE18_RESTORE_EXPECTED_DATABASE_NAME`
- FULL_STEP2B: `PHASE18_RESTORE_TARGET_AT` strict RFC3339 must equal source-capture timestamp

Template/system names (`postgres`, `template0`, `template1`) remain forbidden.

## Phase 18 restore-drill tooling

Package: `@alex-rewards/restore-drill`

```text
pnpm phase18:restore-drill
```

Modes: `DB_ONLY_STEP2A` (default) or `FULL_STEP2B`.
Never falls back to `DATABASE_URL`. Never auto-unpause / auto-resend.
Strict RFC3339 required for `PHASE18_RESTORE_TARGET_AT` and source-capture timestamps.

See `docs/OPERATIONS_RUNBOOK.md` Phase 18 Owner Operations Procedures (restore backup) and `docs/PHASE_18_OBSERVABILITY_DR_PLAN.md`.

## Hot Wallet / signer recovery (summary)

Pause payouts first. Follow `docs/TON_SIGNER.md` rotation / compromise response.
Dual encrypted offline backups; verify fingerprint/address; audited Hot Wallet identity transition; reconcile old/new wallet state; retire old signing capability; never store plaintext key/passphrase in repo/env; Owner approval before resume.

## Resume rule

Technical restore gate PASS does **not** authorize payout resume.
Resume requires Owner approval, zero unresolved financial ambiguity, and the Admin Feature Flags high-impact ceremony.
`PAYOUT_RESUME_OWNER_GATED`. `NO_AUTO_UNPAUSE`.
