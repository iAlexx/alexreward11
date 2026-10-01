# Phase 18 — Observability / DR / Business Health Plan

Status: Step 2A foundation (restore-drill tooling + runbook; PITR/infra not yet enabled).
Archive slug (later): `PHASE_18_OBSERVABILITY_DR`
Gate (later): isolated restore drill with payout dispatch paused; no automatic resume.

Classification key:
- `ALREADY_COMPLETE` — production-ready capability exists end-to-end
- `PARTIAL` — code/docs exist but thresholds, infra, or drill incomplete
- `MISSING` — not implemented
- `OWNER_POLICY_REQUIRED` — needs Owner numeric/policy decision
- `EXTERNAL_INFRA_REQUIRED` — Railway/Postgres/provider console work outside app code

Do not mark operational infrastructure complete merely because application code exists.

---

## 1. Alerts

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `@alex-rewards/ops-health` alert evaluation; Sentry via `@alex-rewards/observability`; provider health snapshots (`packages/ads/src/health.ts`) |
| Missing | Push/pager routing; Owner-approved thresholds; continuous evaluator daemon; dashboard alert widgets |
| Tests | Unit: missing signal ≠ OK; no ledger/withdrawal mutation; bounded labels |
| DB migration | No (Step 1) |
| Railway/external | Yes for notification channels / metric backends |
| Owner approval | Yes for thresholds & on-call destinations |

## 2. Dashboards

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | Admin System page (read-only); OTEL meter export if `OTEL` enabled |
| Missing | Hosted Grafana/Datadog boards; SLO panels |
| Tests | Admin UI read-only invariants |
| DB migration | No |
| Railway/external | Yes (hosted dashboards) |
| Owner approval | Yes for tool choice |

## 3. PostgreSQL health

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `HealthController` readiness; `DependenciesService.probePostgres`; Admin ops-health `POSTGRES` |
| Missing | Host/disk/replication/lag alarms at infra layer |
| Tests | Probe fail → UNAVAILABLE |
| DB migration | No |
| Railway/external | Yes |
| Owner approval | Infra alert destinations |

## 4. Redis health

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | Readiness probe; Admin ops-health `REDIS` |
| Missing | Infra memory/eviction alarms |
| Tests | Same as probes |
| DB migration | No |
| Railway/external | Yes |
| Owner approval | Infra |

## 5. Temporal health

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | API readiness Temporal probe; worker health; Admin ops-health `TEMPORAL` |
| Missing | Workflow backlog / worker saturation dashboards |
| Tests | Probe mapping |
| DB migration | No |
| Railway/external | Yes |
| Owner approval | Infra |

## 6. Telegram Bot health

| Field | Value |
| --- | --- |
| Status | `MISSING` (app signal) / `EXTERNAL_INFRA_REQUIRED` |
| Existing | Bot process health endpoint only |
| Missing | Authoritative Admin-visible bot heartbeat / webhook lag signal |
| Tests | UNKNOWN when signal absent |
| DB migration | Possibly later heartbeat table |
| Railway/external | Bot hosting / Telegram API |
| Owner approval | Heartbeat SLO |

## 7. AdsGram / provider health

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `provider_health_snapshots` append-only; missing observation → UNAVAILABLE; Admin alerts `PROVIDER_HEALTH` |
| Missing | Continuous poller SLA; production monetary still Owner-gated separately |
| Tests | Degraded status mapping |
| DB migration | No |
| Railway/external | Provider console |
| Owner approval | Monetary enablement separate |

## 8. TON RPC primary / secondary health

| Field | Value |
| --- | --- |
| Status | `MISSING` (Admin signal) / `PARTIAL` (ton package clients) |
| Existing | TON client packages; payout path RPC usage |
| Missing | Periodic primary/secondary health snapshots in Admin model (Step 1 → UNKNOWN) |
| Tests | UNKNOWN without fabricate OK |
| DB migration | Possibly later |
| Railway/external | RPC providers |
| Owner approval | Endpoints already gated; health thresholds |

## 9. Signer health

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | Signer service readiness (`custodyState`, `signingReady`); docs rotation |
| Missing | Cross-service Admin snapshot feed (Step 1 → UNKNOWN / OWNER_POLICY_REQUIRED alert) |
| Tests | SIGNER_NOT_READY observation; no auto-unlock |
| DB migration | No |
| Railway/external | Signer host |
| Owner approval | Unlock ceremony |

## 10. Hot Wallet chain-sync health

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `phase10:hot-wallet-monitor` CLI; Admin hot-wallet public view |
| Missing | Continuous Admin health component feed (Step 1 → UNKNOWN) |
| Tests | HOT_WALLET_COVERAGE OWNER_POLICY_REQUIRED without inventing coverage % |
| DB migration | No |
| Railway/external | Chain indexing |
| Owner approval | Coverage thresholds |

## 11. Outbox lag

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `outbox_events`; ops-health reads pending + oldest age; OTEL gauges |
| Missing | Owner lag threshold; pager |
| Tests | Pending → THRESHOLD_NOT_CONFIGURED (not invented severity) |
| DB migration | No |
| Railway/external | Alert routing |
| Owner approval | **Yes — lag seconds / backlog count** |

## 12. Reconciliation health

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | Authoritative persisted `reconciliation_runs` / `reconciliation_items` / `reconciliation_issues` (migration 0010); ops-health reads unresolved `reconciliation_issues`; `phase10-restore-reconcile` CLI scanner; Review Queue `RECONCILIATION_ISSUE` is operational projection only |
| Missing | Continuous pager; automated post-restore gate UI; Owner resume ceremony automation |
| Tests | CRITICAL OPEN cannot be hidden by zero review cases; WARNING degrades; RESOLVED/DISMISSED ignored |
| DB migration | No |
| Railway/external | Restore drill host |
| Owner approval | Resume ceremony |

## 13. Provider hard / contract / platform-limit state

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `provider_limit_rules`; actual proven request count = `ad_daily_counters.provider_requests`; SUCCESS = `ad_daily_counters.successful_rewards`; conservative runtime REQUEST admission cap (authorize.ts) = same-day `ad_sessions` count per user/provider (AdsGram exact provider-request proof remains unresolved); ops-health observes both REQUEST signals without conflating them |
| Missing | Owner near-exhaustion %; HOUR / ROLLING_24H utilization wiring; country/risk-scoped aggregate policy; AdsGram authoritative request-proof path |
| Tests | Exact runtime request-cap exhaustion via `ad_sessions`; exact actual `provider_requests` exhaustion; SUCCESS exhaustion; below-limit ≠ invented near threshold; expired/future rules ignored |
| DB migration | No |
| Railway/external | No |
| Owner approval | **Yes — near-exhaustion thresholds** |

## 14. Provider settlement / reconciliation

| Field | Value |
| --- | --- |
| Status | `PARTIAL` (tables exist; alert coverage incomplete) / `OWNER_POLICY_REQUIRED` (variance magnitude) |
| Existing | `provider_settlement_periods`, `provider_settlement_items`, `provider_reporting_imports` (migration 0009); ops-health precedence: DISPUTED → FAILED/PARTIAL imports (even with zero periods) → unresolved non-zero variance → SIGNAL_NOT_CONFIGURED |
| Missing | Owner variance materiality threshold; continuous settlement feed automation |
| Tests | DISPUTED → DANGER; failed import with zero periods → REPORTING_IMPORT_DEGRADED (not SIGNAL_NOT_CONFIGURED); empty periods+imports → SIGNAL_NOT_CONFIGURED |
| DB migration | No |
| Railway/external | Provider settlement feeds |
| Owner approval | Variance magnitude / dispute policy |

## 15. Reward budget / exposure

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `reward_budget_periods`; Admin exposure/economics; exact exhaustion observable |
| Missing | Near-exhaustion % Owner policy; continuous alert routing |
| Tests | Cannot override budgets; exhausted vs THRESHOLD_NOT_CONFIGURED |
| DB migration | No |
| Railway/external | Alert routing |
| Owner approval | **Yes — near %** |

## 16. Founder bonus budget

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `membership_bonus_budget_periods` |
| Missing | Near-% threshold; Founder-specific dashboards |
| Tests | Same as reward budget |
| DB migration | No |
| Railway/external | Alert routing |
| Owner approval | **Yes — near %** |

## 17. Review Queue backlog

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `review_cases` + `listReviewQueue`; ops-health counts live states only |
| Missing | Backlog age/count thresholds; SLA paging |
| Tests | Reads `review_cases` only; cannot resolve domain state |
| DB migration | No |
| Railway/external | Alert routing |
| Owner approval | **Yes — backlog thresholds** |

## 18. Payout dispatch pause

| Field | Value |
| --- | --- |
| Status | `ALREADY_COMPLETE` (authority) / `PARTIAL` (observability wiring in Step 1) |
| Existing | Authoritative `feature_flags.PAYOUT_DISPATCH_PAUSE`; withdrawals `isPayoutDispatchPaused`; Admin Feature Flags ceremony; ops-health read-only snapshot |
| Missing | Nothing for authority; Step 1 adds read models/metrics only |
| Tests | Monitoring cannot bypass; `autoUnpause: false`; no second flag |
| DB migration | No |
| Railway/external | No |
| Owner approval | Unpause remains high-impact ceremony only |

## 19. Backups / PITR

| Field | Value |
| --- | --- |
| Status | `EXTERNAL_INFRA_REQUIRED` / `OWNER_POLICY_REQUIRED` |
| Existing | Docs + Step 2A restore-drill validator; Railway managed PITR direction documented |
| Missing | Enable Railway-managed PITR / pgBackRest; retention; verified recovery point (Step 2B) |
| Tests | App unit tests refuse operational DB / `DATABASE_URL` fallback; no DIY WAL config in repo |
| DB migration | No |
| Railway/external | **Yes — managed PITR only; do not edit `postgresql.conf` / archive_command** |
| Owner approval | Retention / RPO / RTO targets; Step 2B enablement |
| Verified staging state (Step 2A) | Volume present; **PITR disabled**; no isolated restore env yet |

## 20. Restore drill

| Field | Value |
| --- | --- |
| Status | `PARTIAL` (Step 2A tooling) / `MISSING` (executed drill evidence) |
| Existing | `@alex-rewards/restore-drill` + `pnpm phase18:restore-drill`; reuses `checkLedgerInvariants` + `runPhase10RestoreReconcileScan`; fail-closed `PHASE18_RESTORE_*` gates; pause verify-only; RTO/RPO observations |
| Missing | Successful isolated restore + Temporal + live chain evidence (Step 2B) |
| Tests | Guard refusal; pause FAIL; CRITICAL/DANGER ⇒ FAIL; Step 2A resume always false; no SQL mutation / sendBoc |
| DB migration | No |
| Railway/external | Isolated restore environment (Step 2B) |
| Owner approval | Drill window + resume ceremony |

## 21. Archive / restore procedures

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | `docs/PHASE_ARCHIVE.md`, `docs/DISASTER_RECOVERY.md`, `docs/OPERATIONS_RUNBOOK.md` |
| Missing | Phase 18-specific archive pack (deferred); production restore checklist sign-off |
| Tests | Archive helper tests exist for prior phases |
| DB migration | No |
| Railway/external | Backup media |
| Owner approval | Archive acceptance later |

## 22. Signer rotation

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | Documented in `OPERATIONS_RUNBOOK.md` / `TON_SIGNER.md` / `DISASTER_RECOVERY.md` |
| Missing | Live rotation drill evidence; Admin checklist surface |
| Tests | Docs presence; no key material in repo |
| DB migration | No |
| Railway/external | Offline backup custody |
| Owner approval | Rotation ceremony |

## 23. Incident runbooks

| Field | Value |
| --- | --- |
| Status | `PARTIAL` |
| Existing | Operations runbook sections (pause, restore, compromise) |
| Missing | Consolidated Phase 18 incident playbooks (pager, severity matrix) |
| Tests | Doc inventory |
| DB migration | No |
| Railway/external | On-call tooling |
| Owner approval | Severity / ownership matrix |

---

## Step 1 delivery map

| Deliverable | Module |
| --- | --- |
| Typed System Health | `packages/ops-health` |
| Alert evaluation | `packages/ops-health/src/evaluate.ts` |
| Admin API | `GET /v1/admin/system` (+ `/system/health`) |
| Admin UI | `SystemPage` read-only |
| Metrics | `recordOpsHealthMetrics` via observability meter |
| Payout pause | Read `feature_flags.PAYOUT_DISPATCH_PAUSE` only |

## Step 2A delivery map (this step)

| Deliverable | Module |
| --- | --- |
| Isolated target guard | `packages/restore-drill/src/target-guard.ts` |
| Restore-drill orchestrator | `packages/restore-drill/src/run-restore-drill.ts` |
| CLI | `pnpm phase18:restore-drill` |
| Schema / pause / outbox / counts | `packages/restore-drill/src/*.ts` |
| Ledger reuse | `checkLedgerInvariants` |
| Withdrawal restore reuse | `runPhase10RestoreReconcileScan` (`autoResend`/`autoUnpause` false) |
| Report contract | `phase18-restore-drill-v1` JSON + Markdown |
| Docs | `DISASTER_RECOVERY.md`, `OPERATIONS_RUNBOOK.md`, this plan |

### Step 2B planned sequence (NOT started)

1. Verify payout dispatch pause on source staging
2. Enable/configure Railway-managed PITR
3. Establish backup recovery point
4. Create isolated restore target
5. Restore to isolated target
6. Record restore start/availability timestamps
7. Bind restore validator ONLY to isolated DB
8. Verify schema
9. Verify pause flag
10. Run ledger invariants
11. Run withdrawal/attempt/outbox DB reconciliation
12. Compare representative source/restored counts
13. Verify selected test-user histories if Owner provides IDs
14. Perform read-only Temporal workflow reconciliation
15. Perform required read-only Testnet chain reconciliation
16. Record RTO/RPO observations
17. Prove ambiguity ⇒ payout resume blocked
18. No resume until Owner review

## Explicit non-goals (Step 1)

- No restore drill execution
- No backup credential commits
- No invented production thresholds
- No auto-unpause
- No ledger / withdrawal financial mutations from alerts
- No Mainnet / AdsGram monetary / auto payout enablement

## Explicit non-goals (Step 2A)

- No Railway PITR enablement
- No isolated restore environment/service creation
- No restore execution
- No migrations against staging
- No pause/unpause staging payouts
- No Temporal query / workflow start/replay
- No live TON RPC / sendBoc / signer calls
- No `PAYOUT_RESUME_ALLOWED=true` (DB-only mode forces false)
- No DIY WAL archive configuration
