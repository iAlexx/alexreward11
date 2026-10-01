# Phase 18 Requirement Closure Matrix

Companion to `docs/PHASE_18_OBSERVABILITY_DR_PLAN.md`.
Statuses allowed: `COMPLETE` | `OWNER_POLICY_REQUIRED` | `EXTERNAL_INTEGRATION_OPTIONAL` | `ARCHIVE_PENDING`.

Semantic markers: PHASE18_CLOSURE_MATRIX, ARCHIVE_PENDING, COMPLETE.

| # | Requirement | Implementation / evidence | Operational authority | Closure status | Owner policy dependency | Missing threshold fails closed |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Alerts | `packages/ops-health` evaluate + Admin System Health | Read-only observations; no financial mutation | COMPLETE | Thresholds / pager destination OWNER_POLICY_REQUIRED | YES |
| 2 | Dashboards | Admin System page (`SystemPage`) + `GET /v1/admin/system` | Owner Admin read | COMPLETE (in-app contract) | Hosted Grafana/Datadog EXTERNAL_INTEGRATION_OPTIONAL | YES (UNKNOWN is not OK) |
| 3 | Backups / PITR | Railway-managed PostgreSQL PITR / pgBackRest | Owner + Railway console | COMPLETE (infra enabled; trusted via drill) | RTO/RPO OWNER_POLICY_REQUIRED | YES |
| 4 | Isolated restore drill | `@alex-rewards/restore-drill` FULL_STEP2B; untracked evidence filenames under `phase18-runtime-evidence/` | Owner-approved runtime; validator read-only | COMPLETE | Resume still Owner-gated | YES |
| 5 | Incident runbooks | `docs/INCIDENT_RESPONSE.md` Phase 18 playbooks A-P | Owner / on-call | COMPLETE (procedures) | Numeric SLA OWNER_POLICY_REQUIRED | N/A (docs) |
| 6 | Payout pause | `feature_flags.PAYOUT_DISPATCH_PAUSE` + Admin Feature Flags ceremony | Owner high-impact ceremony | COMPLETE | Unpause Owner-only | YES |
| 7 | Signer rotation docs | `docs/TON_SIGNER.md`, `docs/OPERATIONS_RUNBOOK.md`, `docs/DISASTER_RECOVERY.md` | Owner + controlled host | COMPLETE (docs) | Live rotation drill separate Owner action | N/A |
| 8 | Provider health/limit alarms | ops-health `PROVIDER_HEALTH` / `PROVIDER_LIMIT` | Read-only | COMPLETE | Near-limit threshold OWNER_POLICY_REQUIRED | YES |
| 9 | Provider settlement/reconciliation alerts | ops-health `PROVIDER_SETTLEMENT` + Phase 10 reconcile | Read-only / Owner review | COMPLETE | Materiality threshold OWNER_POLICY_REQUIRED | YES |
| 10 | Reward/budget exposure alerts | ops-health `REWARD_BUDGET_EXPOSURE` | Read-only | COMPLETE | Near-exhaustion OWNER_POLICY_REQUIRED | YES |
| 11 | Founder bonus budget alerts | ops-health `FOUNDER_BONUS_BUDGET_EXPOSURE` | Read-only | COMPLETE | Near-exhaustion OWNER_POLICY_REQUIRED | YES |
| 12 | Review Queue backlog alerts | ops-health `REVIEW_QUEUE_BACKLOG` | Read-only; no auto-resolve | COMPLETE | Count/age threshold OWNER_POLICY_REQUIRED | YES |
| 13 | Archive / restore documentation | `docs/PHASE_ARCHIVE.md`, `docs/DISASTER_RECOVERY.md` slug `PHASE_18_OBSERVABILITY_DR` | Owner acceptance | ARCHIVE_PENDING | Archive pack after independent review | N/A |

## Step 2B verified technical gate (no secrets)

| Field | Value |
| --- | --- |
| PITR | ENABLED (Railway managed) |
| Restore drill | PASS |
| Restore type | isolated sibling service |
| Restore target | 2026-10-01T03:48:46.745Z |
| Source/target isolation | PASS |
| Representative counts | EXACT_MATCH |
| Selected users | 4/4 PASS (SHA-256 userReference) |
| Temporal | PASS |
| Chain | PASS — NO_CHAIN_BOUND_PAYOUT_STATE_TO_RECONCILE |
| fullRestoreGatePass | true |
| PAYOUT_RESUME_ALLOWED | false |
| AUTO_UNPAUSE | false |
| AUTO_RESEND | false |

Evidence filenames (untracked; not committed): `source-capture-20261001-034845.json`, Phase 18 restore-drill JSON/Markdown under `phase18-runtime-evidence/`.
