# Phase 21 - Provisioning Ceremony Preflight

**Status:** Step 3 checklist (read-only). **Not executed.**
**READY_FOR_LIVE_PAYOUT:** NO

## Purpose

Owner-facing preflight before any later provisioning ceremony. Completing this checklist does **not** authorize live payout.

## Preconditions (source)

- [ ] Readiness matrix reviewed (`PHASE_21_READINESS_MATRIX.md`)
- [ ] `pnpm phase21:readiness` overall BLOCKED (expected until external resources exist)
- [ ] `pnpm phase21:preflight` may show `READY_FOR_OWNER_PROVISIONING_CEREMONY` or `MAINNET_SOURCE_READY`
- [ ] `readyForLivePayout` is **false**
- [ ] Signer hosting locked: `DEDICATED_CONTROLLED_HOST`
- [ ] Forward GRAM = 1 nanogram Owner-approved; attached lifecycle **ESTIMATED**
- [ ] Controlled Available tooling documented; **not executed**
- [ ] AdsGram gaps remain OPEN
- [ ] Canonical runtime still `b9dd700`; Phase21 not deployed

## External / operational (ceremony inputs - later)

- [ ] Mainnet USDT Jetton master identity
- [ ] Independent primary + secondary TON Mainnet providers
- [ ] Dedicated controlled host for signer
- [ ] Offline Mainnet key ceremony (generate/encrypt/backup) - see ceremony doc
- [ ] Hot Wallet register + fund (5-10 USDT + GRAM gas)
- [ ] Controlled Available provision (if Owner-authorized) within 10_000_000 atomic ceiling
- [ ] Explicit later Owner gate for `PHASE21_MAINNET_ENABLED` / real chain / unpause

## Forbidden in Step 3

- Live Mainnet payout
- Passphrase in env
- SPIKE transfer policy on Mainnet
- Renaming `TON_MAINNET` -> `GRAM_MAINNET`
- Mutating operational DB for provision


## Step 3A source corrections gate

READY_FOR_OWNER_PROVISIONING_CEREMONY additionally requires PASS on:

- CONTROLLED_PROVISION_OPERATIONAL_MODE
- LIVE_FEE_ESTIMATOR_HONEST
- PRODUCTION_ENV_CUTOVER_PLAN
- EXTERNAL_VERIFIER_HARDENED
- WITHDRAWAL_REQUEST_PAUSE_FAIL_CLOSED
- PRODUCTION_FLAG_BASELINE_TOOL
- MAINNET_REGISTRY_BOOTSTRAP

READY_FOR_LIVE_PAYOUT remains always false. See PHASE_21_STEP3A_INDEPENDENT_REVIEW_CORRECTIONS.md.

## Step 3B tooling hardening (source)

- [ ] forceApply removed from flag baseline + registry bootstrap
- [ ] Atomic PRODUCTION flag baseline APPLY (versions + audit)
- [ ] Atomic Mainnet registry one-pass APPLY
- [ ] Concrete Mainnet external adapters + fee adapter
- [ ] Hot Wallet registration tooling (Owner inputs required)
- [ ] pnpm phase21:preflight may show READY_FOR_OWNER_PROVISIONING_CEREMONY when Step 3B observations PASS
- [ ] readyForLivePayout remains false

Canonical detail: PHASE_21_STEP3B_CEREMONY_TOOLING_HARDENING.md

## Phase 21 Step 3C final operational truth gate

Step 3C truth gate is required before READY_FOR_OWNER_PROVISIONING_CEREMONY. Live PLAN requires DATABASE_URL; APPLY requires ACTIVE OWNER admin. See PHASE_21_STEP3C_FINAL_OPERATIONAL_TRUTH_GATE.md.

## Step 4A — Owner authority prerequisite (2026-10-02)

Step4 APPLY remains `PAUSED_OWNER_AUTHORITY_REQUIRED`. Production first-Owner bootstrap source path (`production_sealed_v1` / `CLAIM_EXISTING_ADMIN`) is implemented; operational ceremony blocked until trust resources exist. See `docs/PHASE_21_STEP4A_PRODUCTION_OWNER_BOOTSTRAP_READINESS.md`.

## Step 4A.1

Owner authority still required. Production bootstrap source corrected; endpoint trust not established (no public Railway Postgres URL). See `docs/PHASE_21_STEP4A1_PRODUCTION_OWNER_BOOTSTRAP_CORRECTIONS.md`.
