# Operations runbook

## Phase 1 foundation

Use `pnpm dev:stack` to start the local foundation and `pnpm smoke` to verify it. Inspect services
with `docker compose -f infra/docker/compose.yaml --env-file .env --profile apps ps`. Stop without
data deletion using `pnpm dev:stack:down`. Production financial operations beyond the signer
custody notes below remain phase-gated.

## Signer custody (Phase 9 / v1.3) — self-hosted encrypted

Authority: Master Spec v1.3. Production target: `apps/signer` + `FALLBACK_ENCRYPTED`.
**No signer-custody migration required.** AWS operational helpers are removed; there is no AWS
dependency on the production signing path.

### Keygen (offline / controlled host)

1. On a trusted machine, generate seed + encrypt bundle via `@alex-rewards/signing`
   (`generateHotWalletSeed`, `encryptKeyBundle`, `writeKeyBundleFile`).
2. Confirm derived Wallet V5 R1 address and `publicKeyFingerprint` for TESTNET (`-3`).
3. Install ciphertext at `SIGNER_KEY_BUNDLE_PATH` on the signer host only (restrictive file mode).
4. Create **two offline encrypted backups** of the same bundle file; store separately from the live host.
5. Destroy plaintext seed from memory/disk; never place passphrase in env files.

### Unlock

1. Ensure `SIGNER_KEY_MODE=self_hosted_encrypted` and bundle path are set.
2. Start signer (boots **LOCKED**).
3. From loopback only: `POST /v1/local-unlock` with `{ "passphrase": "..." }`.
4. Confirm health/readiness reports `custodyState=UNLOCKED` and `signingReady=true`.
5. Relock with `POST /v1/local-relock` when signing window ends; restart always returns to LOCKED.

### Backup / restore drill

1. Copy live ciphertext bundle to offline media (backup #1 and #2).
2. Practice restore onto a non-production signer host: place file, unlock, verify fingerprint/address match, relock.
3. Document Owner custody of passphrase material separately from backups.

### Rotation / Hot Wallet replacement

1. Pause payout dispatch.
2. Generate new seed + new encrypted bundle + dual offline backups.
3. Update audited Hot Wallet rows / `SIGNER_EXPECTED_SIGNER_REFERENCE`.
4. Deploy new bundle; unlock; verify identity; destroy old unlock capability and obsolete backups under Owner procedure.

### Compromise response (summary)

Pause dispatch → relock / revoke host+backup access → rotate Hot Wallet / bundle → reconcile →
Owner approval before resume. Future HSM/Vault may plug in via `SignPort` / `LockableSignPort`
without giving signing rights to API/bot/worker.

## Phase 10 Testnet payout foundation (broadcast outside signer)

- `apps/signer` signs only and may return `externalMessageBocBase64`; it must not call TON RPC.
- Worker / withdrawals persist signed BOC evidence **before** `sendBoc`, classify ambiguous RPC
  outcomes, and never blind-resend after `broadcast_submitted_at` or ambiguity.
- Keep `WITHDRAWAL_REAL_CHAIN_ENABLED=false` until Owner sets `TON_TESTNET_JETTON_MASTER` and
  Testnet provider URLs. Fake chain remains for Phase 7 local tests.
- Forbidden: Mainnet, AWS KMS, plaintext Hot Wallet keys in env.
- Status: `docs/PHASE_10_ACCEPTANCE_REPORT.md` — **PHASE 10 CODE COMPLETE — LIVE VALIDATION READY (NOT CLOSED)**; isolated Owner auth **VERIFIED** (do not re-enroll).

## Phase 10 Testnet Available provisioning (internal Owner CLI)

**Testnet only. Host-access Owner-operated tool. Default OFF. Not a production balance editor.**

Used only to provision a deliberately small withdrawable Available balance to ONE
configured allowlisted controlled Testnet user for Phase 10 payout validation.

Allowlisted assets when the gate is enabled: **USDT** (legacy fixture master) or **aalex**
(exact isolated Jetton master + 9 decimals). aalex additionally requires
`PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME` matching `current_database()` and refuses
operational `alex_rewards` / `:55432`. Absolute aalex provision ceiling: 10 aalex.

Config (safe placeholders only; never commit real user IDs):

- `PHASE10_TESTNET_AVAILABLE_PROVISION_ENABLED=false`
- `PHASE10_TESTNET_PROVISION_ALLOWED_USER_ID=` (UUID when enabling)
- `PHASE10_TESTNET_PROVISION_MAX_ATOMIC=1000000` (isolated aalex prep: `1000000000`)
- `PHASE10_TESTNET_PROVISION_OWNER_ADMIN_USER_ID=` (ACTIVE Owner admin UUID when enabling)
- `PHASE10_TESTNET_PROVISION_REQUIRED_DATABASE_NAME=` (required for aalex)
- `WITHDRAWAL_ASSET_SYMBOL=USDT` or `aalex`

CLI (after `pnpm --filter @alex-rewards/ledger build`):

```text
pnpm --filter @alex-rewards/ledger run phase10:provision-available -- \
  --operation-id 00000000-0000-4000-8000-000000000001 \
  --user-id 00000000-0000-4000-8000-000000000002 \
  --amount-atomic 100000 \
  --reason "phase10-controlled-testnet-provision"

pnpm --filter @alex-rewards/ledger run phase10:reverse-available -- \
  --operation-id 00000000-0000-4000-8000-000000000003 \
  --original-ledger-tx 00000000-0000-4000-8000-000000000004 \
  --reason "phase10-controlled-testnet-provision-reverse"
```

Preserve the exact `--operation-id` UUID for safe retries. Reversal goes through the guarded
ledger reversal API only.

See `docs/TON_SIGNER.md` and `docs/DISASTER_RECOVERY.md`.

## Phase 10 operational tooling (read-only / dry-run)

Status: **tooling available — no live Testnet yet.** Do not unlock signer, enable real
chain, start worker payout dispatch, fund users, or mutate live `alex_rewards` until
Owner external resources and an explicit controlled live gate are approved.

CLI (after `pnpm --filter @alex-rewards/withdrawals build`):

```text
pnpm --filter @alex-rewards/withdrawals run phase10:readiness
pnpm --filter @alex-rewards/withdrawals run phase10:preflight
pnpm --filter @alex-rewards/withdrawals run phase10:restore-reconcile
pnpm --filter @alex-rewards/withdrawals run phase10:hot-wallet-monitor
pnpm --filter @alex-rewards/withdrawals run phase10:campaign-plan
```

Optional: `--user-id <uuid>` on readiness/preflight; `--mode real` on campaign-plan
(refused unless every explicit gate object field is true — env is never flipped).

### Readiness / preflight

- `runPhase10Readiness` — PASS/WARN/BLOCKED items + machine-readable summary (no secrets).
- Distinguishes **intentionally_safe_off** (real chain still disabled / resources not set)
  from **misconfigured** (real enabled but incomplete).
- `runPhase10Preflight` aggregates readiness + restore scan →
  `READY_FOR_CONTROLLED_LIVE_TESTNET` or `BLOCKED`.

### Restore → pause → reconcile

After any database restore:

1. Ensure `PAYOUT_DISPATCH_PAUSE` remains enabled (do not unpause from tooling).
2. Run `phase10:restore-reconcile` (read-only). Categories include approved-without-workflow,
   submitted/UNKNOWN needing chain observation, confirmed-without-settlement, pending outbox
   recovery, competing attempt lineage, synthetic UNKNOWN isolation.
3. **Never auto-resend.** **Never unpause** from this scanner.
4. Resume only after Owner review of findings + mandatory reconciliation.

### Phase 18 isolated restore drill

Railway-managed PITR is **ENABLED**. Step 2B isolated sibling restore drill is **PASS**
(restore target `2026-10-01T03:48:46.745Z`). See `docs/DISASTER_RECOVERY.md` and
`docs/PHASE_18_OBSERVABILITY_DR_PLAN.md`.

Use Railway **managed** PITR / pgBackRest only — do not hand-edit Postgres WAL archive config.
Isolation is **host/service based** (`PHASE18_RESTORE_EXPECTED_HOST` ≠ `PHASE18_SOURCE_DATABASE_HOST`).

Fail-closed CLI (binds only to `PHASE18_RESTORE_DATABASE_URL`; never `DATABASE_URL`):

```text
pnpm phase18:restore-drill
```

FULL_STEP2B additionally requires source-count capture path, Temporal address/namespace,
`PHASE18_RESTORE_TARGET_AT` (strict RFC3339), and `PHASE18_RESTORE_VERIFY_ALL_USERS` or verify user ids.
Validator is read-only: `autoUnpause: false`, `autoResend: false`, `PAYOUT_RESUME_ALLOWED=false`.
STAGING `PAYOUT_DISPATCH_PAUSE` must remain **true** during Phase 18 closure.

### Campaign dry-run

`phase10:campaign-plan` (default `dry-run`) emits the intended scenario matrix from
`PHASE10_FAILURE_SCENARIO_CATALOGUE` (`LOCAL_DETERMINISTIC` vs `REQUIRES_REAL_TESTNET`).
It creates **no** withdrawals and does not flip env. Real mode is refused unless every
gate in the explicit gates object is `true`.


## Phase 18 Owner Operations Procedures

Semantic markers: PHASE18_OWNER_OPERATIONS_PROCEDURES, AUTO_UNPAUSE_FALSE, AUTO_RESEND_FALSE, PAYOUT_PAUSE_PROCEDURE.

Current STAGING state during Phase 18 closure: `PAYOUT_DISPATCH_PAUSE=true`. Do not change it in Step 3.
`AUTO_UNPAUSE=false`. `AUTO_RESEND=false`. Resume is never automatic.

### 1. Fund Hot Wallet

- Preconditions: payouts paused if Hot Wallet identity is changing; Testnet/Mainnet policy already Owner-set.
- Authoritative system: MANUAL OWNER PROCEDURE — external chain transfer into Hot Wallet; verification via `pnpm --filter @alex-rewards/withdrawals run phase10:hot-wallet-monitor` and Admin Hot Wallet public views.
- Safe sequence: transfer on-chain → wait confirmations → run hot-wallet-monitor → record coverage evidence.
- Verification: monitor PASS / coverage observed; never edit a DB balance field as funding.
- Rollback/containment: pause payouts if unexpected outgoing detected.
- Forbidden: mutating ledger/Hot Wallet rows to invent coverage; storing keys in repo/env.
- Audit: transfer tx evidence + monitor report digests (no plaintext keys).

### 2. Verify coverage

- Preconditions: Hot Wallet identity known; RPC providers configured for the intended network.
- Authoritative system: `phase10:hot-wallet-monitor`; Admin System Health `HOT_WALLET_CHAIN_SYNC` / `HOT_WALLET_COVERAGE` (UNKNOWN if signal absent).
- Safe sequence: run monitor read-only → interpret coverage vs pending payout exposure.
- Verification: monitor exit + Admin alert/component states.
- Forbidden: inventing OK when signal is UNKNOWN.
- Audit: monitor output filenames / digests.

### 3. Approve withdrawal

Semantic markers: WITHDRAWALS_PAGE_READ_ONLY, WITHDRAWAL_APPROVE_ROUTE, DIRECT_SQL_FORBIDDEN.

- Preconditions: Owner/authorized Admin authenticated; payout pause policy understood; withdrawal in expected approvable state/version.
- Authoritative system: **MANUAL OWNER / AUTHORIZED ADMIN API PROCEDURE**.
  - `WithdrawalsPage` is currently a **read-only** review/list surface (queue/status only). It does **not** expose approve/hold/reject HighImpactCeremony controls.
  - Mutation authority is `POST /v1/admin/withdrawals/:id/approve` in `apps/api` (`WithdrawalsAdminController`), requiring AdminSessionGuard, CSRF enforcement, `gateHighImpactMutation`, consumed confirmation, expected state/version semantics, idempotency key, then authoritative `decideWithdrawal`.
- Safe sequence: review list/detail read-only → complete high-impact confirmation ceremony binding the exact decision payload → call the approve Admin API route → confirm state becomes APPROVED and Outbox/workflow identity is created by domain (no direct Temporal call from Admin).
- Verification: withdrawal state transition visible via Admin list/detail reads; domain result returned by API.
- Forbidden: direct SQL status edits (`DIRECT_SQL_FORBIDDEN`); inventing a WithdrawalsPage mutation UI claim; embedding credentials/tokens in runbook examples.
- Audit: Admin confirmation + `WITHDRAWAL_DECIDE_APPROVE` audit/outbox evidence.

### 4. Hold suspicious withdrawal

Semantic markers: WITHDRAWAL_HOLD_ROUTE, WITHDRAWAL_REVIEW_CASE_PROJECTION.

- Preconditions: suspicion signal (fraud, reconcile danger, unexpected chain); expected state/version known.
- Authoritative system: **MANUAL OWNER / AUTHORIZED ADMIN API PROCEDURE**.
  - `WithdrawalsPage` remains **read-only**.
  - Hold mutation authority is `POST /v1/admin/withdrawals/:id/hold` (same CSRF / high-impact / confirmation / idempotency / `decideWithdrawal` contract as approve).
- Safe sequence: pause payouts if systemic blast radius is unclear → hold via Admin API ceremony → confirm state HELD.
- Review Queue note: Admin API hold/`decideWithdrawal` does **not** itself open a Review Queue case. `WITHDRAWAL_REVIEW` cases are an operational projection; when present, verify/reuse the existing case. Case ensure/open for withdrawals is not exposed as a current Admin UI/API “ensure withdrawal review” action on this path (Telegram Control Center approval-card issuance may ensure a case elsewhere — that is not the Admin hold route). Do not invent a case-creation step from this runbook. Review Queue is not financial source of truth.
- Verification: withdrawal cannot dispatch while HELD; pause flag true if freeze required.
- Forbidden: deleting withdrawal rows; blind resend; direct SQL; claiming Hold opens Review Queue unless using a separate authoritative path that actually does.
- Audit: hold reason + decision digests; existing WITHDRAWAL_REVIEW case id only when already present.

### 5. Review fraud flag

- Preconditions: Owner/authorized Admin; user id available internally only.
- Authoritative system: Admin Fraud page (`FraudPage`) + Review Queue ensure-open ceremony.
- Safe sequence: load fraud evidence → open/reuse FRAUD_REVIEW case → do not safe-clear without Owner policy.
- Verification: case visible; no fraud package import from Admin UI.
- Forbidden: clearing fraud as payout unlock shortcut.
- Audit: fraud.ensure_review action records.

### 6. Pause / resume payouts

- Preconditions: Owner Admin; high-impact reauth available.
- Authoritative system: Admin Feature Flags page (`FeatureFlagsPage`) mutating `PAYOUT_DISPATCH_PAUSE` via ceremony — never direct `UPDATE feature_flags`.
- Pause sequence: open Feature Flags → select PAYOUT_DISPATCH_PAUSE → complete high-impact ceremony → set enabled=true → confirm Admin overview warning.
- Resume sequence MUST require: successful restore/reconciliation gate where relevant; zero unresolved financial ambiguity; Owner review; authoritative high-impact flag change to enabled=false; post-change health confirmation on Admin System + withdrawals readiness.
- Verification: ops-health `PAYOUT_DISPATCH_PAUSE` observation; worker respects pause.
- Forbidden: auto-unpause; SQL flag flips; resume while FULL restore gate failed.
- Audit: feature_flags.mutate ceremony records. Markers: PAYOUT_PAUSE_PROCEDURE, NO_AUTO_UNPAUSE.

### 7. Change reward rule

Semantic markers: POLICY_CENTER_PAGE_READ_ONLY, REWARD_RULES_CREATE_VERSION_ROUTE, REWARD_RULES_NEW_VERSION_ONLY.

- Preconditions: Owner/authorized Admin authenticated; high-impact reauth/confirmation available.
- Authoritative system: **MANUAL OWNER / AUTHORIZED ADMIN API PROCEDURE**.
  - `PolicyCenterPage` is currently a **read-only** policy overview (lists typed families/versions). It does **not** contain structured mutation forms.
  - Generic `POST /v1/admin/policy/change` does **not** apply `REWARD_RULES` (returns `applied=false` / use dedicated typed endpoint).
  - Executable mutation authority is `POST /v1/admin/reward-rules` (`RewardEngineAdminController`): AdminSessionGuard, CSRF, `gateHighImpactMutation`, consumed confirmation, then creates a **new** reward rule version via `createRewardRuleVersion` — never edits historical reward rule rows in place.
- Safe sequence: review read-only Policy Center / reward-rules list → complete high-impact confirmation → POST new reward-rule version → optionally activate per command fields → verify issuance uses the new version going forward.
- Verification: new version visible via `GET /v1/admin/reward-rules` / Policy Center overview; no historical row rewrite.
- Forbidden: rewriting historical reward rule rows; editing reward ledger history; claiming PolicyCenterPage forms perform the mutation; direct SQL.
- Audit: new rule version id + confirmation ceremony records.

### 8. Respond to AdsGram outage

- Preconditions: provider health degraded/unavailable.
- Authoritative system: Admin System Health `ADS_PROVIDER` / `PROVIDER_HEALTH`; AdsGram console (MANUAL OWNER PROCEDURE for vendor console).
- Safe sequence: confirm alert → disable monetary campaigns if active → pause payouts if reward/payout ambiguity → wait vendor recovery → settlement review.
- Verification: provider health recovers; settlement alert not DISPUTED.
- Forbidden: overriding provider hard limits; enabling AdsGram monetary as workaround during Phase 18 freeze.
- Audit: health snapshots + Owner decision note.

### 9. Restore backup

- Preconditions: Owner approval; payouts paused; Railway-managed PITR enabled.
- Authoritative system: Railway managed PITR restore to **isolated sibling** first; validate with `pnpm phase18:restore-drill` FULL_STEP2B.
- Safe sequence: capture source counts → restore sibling → bind validator to sibling host → require `PHASE18_RESTORE_TARGET_AT` match → Temporal + chain scope reconcile → keep apps on source → Owner review before any cutover (cutover is separate Owner decision; not Step 3).
- Verification: `fullRestoreGatePass=true` still leaves `PAYOUT_RESUME_ALLOWED=false` until Owner resume ceremony.
- Forbidden: DIY WAL; restoring over source; unpause from validator; deleting sibling during Step 3.
- Audit: evidence filenames under untracked `phase18-runtime-evidence/`.

### 10. Rotate Bot token

- Preconditions: Owner; bot service access.
- Authoritative system: MANUAL OWNER PROCEDURE — Telegram BotFather + Railway bot service secret update (no secret values in git).
- Safe sequence: pause user-critical flows if needed → issue new token → update Railway secret → restart bot → revoke old token → verify bot health.
- Verification: Admin `TELEGRAM_BOT` / bot health endpoint.
- Forbidden: committing token to repo; pasting token into docs.
- Audit: rotation timestamp + operator identity only.

### 11. Rotate signer

- Preconditions: `PAYOUT_DISPATCH_PAUSE=true`; controlled host available.
- Authoritative system: `docs/TON_SIGNER.md` + signer local unlock APIs; `apps/signer` only.
- Safe sequence: pause payouts → generate new seed/bundle on controlled host → dual encrypted offline backups → verify fingerprint/address → audited Hot Wallet identity transition → deploy bundle → unlock briefly → relock → retire old unlock capability.
- Verification: signer readiness + Hot Wallet reference match; reconcile old/new wallet state.
- Forbidden: plaintext key/passphrase in repo/env; API/worker importing KMS/signing clients.
- Audit: fingerprint + ceremony notes. Live rotation is Owner-scheduled (docs only in Step 3).

### 12. Retire Hot Wallet

- Preconditions: payouts paused; replacement wallet ready or payouts remaining stopped.
- Authoritative system: audited Hot Wallet config transition + chain observation (`phase10:hot-wallet-monitor`).
- Safe sequence: pause → move identity to new wallet under rotation procedure → reconcile residual balances/outgoing → revoke old signing capability → confirm no unexpected old-wallet outgoing.
- Verification: monitor shows expected wallet only; reconcile PASS.
- Forbidden: leaving old signer unlockable; inventing DB balances.
- Audit: old/new identity digests.

### 13. Handle reconciliation issue

- Preconditions: reconcile danger/warn; pause recommended.
- Authoritative system: `phase10:restore-reconcile`, Phase 18 restore-drill sections, Admin System Health reconciliation alerts.
- Safe sequence: pause payouts → run read-only reconcile → classify categories → preserve evidence → Owner decides remediation (never auto-resend).
- Verification: dangerousCount=0 or Owner-accepted residual with freeze retained.
- Forbidden: blind resend; ledger history edits; auto-unpause.
- Audit: reconcile report digests. Marker: NO_BLIND_RESEND.

## Phase 21 Mainnet readiness tooling (read-only / Step 1)

```bash
pnpm phase21:readiness
pnpm phase21:preflight
```

- Read-only JSON reports; exit 0 even when overall `BLOCKED` (tooling success)
- Default `PHASE21_MAINNET_ENABLED` unset/false
- Does not unlock signer, enable real chain, fund wallets, or mutate DB/Railway
- Expected Step 1: `BLOCKED` / `BLOCKED_FOR_EXTERNAL_RESOURCES`
- Never treat output as `READY_FOR_LIVE_PAYOUT` authorization

Ceremony / hosting notes: `docs/PHASE_21_SIGNER_HOT_WALLET_CEREMONY.md`.
Plan: `docs/PHASE_21_MAINNET_MICRO_LAUNCH_PLAN.md`.


## Phase 21 Step 2

No operational Mainnet changes. Verify: pnpm phase21:readiness, pnpm phase21:preflight. Optional live external probes: set PHASE21_EXTERNAL_PROBE_LIVE=1 only during Owner verification ceremony.

## Phase 21 Step 3

```bash
pnpm phase21:readiness
pnpm phase21:preflight
```

- Expect overall readiness BLOCKED; preflight may be `READY_FOR_OWNER_PROVISIONING_CEREMONY` or `MAINNET_SOURCE_READY`
- Never treat output as live-payout authorization (`readyForLivePayout=false`)
- Signer host decision: `DEDICATED_CONTROLLED_HOST` (not provisioned)
- Controlled Available provision CLI must remain disabled; do not mutate operational DB
- Canonical runtime remains `b9dd700`; Phase21 not deployed
- Ceremony / GRAM naming / provisioning docs under `docs/PHASE_21_*`

## Phase 21 Step 3A

Do not run operational ceremony, PRODUCTION flag baseline apply, or Mainnet registry apply from Step 3A engineering.
Preflight READY_FOR_OWNER_PROVISIONING_CEREMONY requires Step 3A source corrections PASS; live payout remains blocked.

## Phase 21 Step 3B operator ceremony commands (source-ready; do not execute yet)

Read-only: pnpm phase21:readiness, pnpm phase21:preflight, pnpm phase21:production-flags:plan, pnpm phase21:mainnet-registry:plan, pnpm phase21:verify-mainnet-external, pnpm phase21:estimate-mainnet-fee, pnpm phase21:hot-wallet:plan.

Mutation (later Owner ceremony only; gated): pnpm phase21:production-flags:apply -- --apply, pnpm phase21:mainnet-registry:apply -- --apply, pnpm phase21:hot-wallet:register -- --apply.

Order: flag baseline -> verify flags -> registry bootstrap -> verify registry -> offline key -> signer host LOCKED -> external verify -> hot wallet register -> STOP (no funding/cutover/enable).

## Phase 21 Step 3C final operational truth gate

Phase 21 Step 3C CLI: production-flags/mainnet-registry live PLAN requires DATABASE_URL; :template commands are SCHEMA_TEMPLATE_NOT_LIVE; estimate-mainnet-fee reports distinct fee/attached/forward fields for 0.19 and 5 USDT cases.

### Phase 21 Step 4A — Production Owner bootstrap (source ready)

Operational Step4 APPLY remains paused until Owner authority exists. Use `pnpm --filter @alex-rewards/auth run owner-production-bootstrap -- readiness` for source readiness. Do not run `enroll-existing --apply` until Owner-authorized production ceremony after trust resources are established. See `docs/OWNER_ADMIN_PRODUCTION_BOOTSTRAP.md`.
