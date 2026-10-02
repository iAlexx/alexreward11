# Phase 21 — Production Environment Cutover Plan

**Status:** DOCUMENTED ONLY — DO NOT EXECUTE in Step 3A
**Railway env name != DEPLOYMENT_ENV**

## Current posture

- The operational app Railway environment name must not be confused with DEPLOYMENT_ENV.
- Current operational app uses **STAGING semantics** for network acceptance and feature-flag scoping.
- packages/wallets/src/network.ts environmentAllowed() remains:
  - STAGING accepts TESTNET only (rejects MAINNET)
  - PRODUCTION accepts MAINNET only (rejects TESTNET)
- This cutover document does **not** weaken that matrix.

## Future cutover target

Set application DEPLOYMENT_ENV=production only when Owner authorizes the production policy
environment cutover (Owner §22 sequence). Railway project/service names may stay unchanged.

## Fail-closed PRODUCTION flag baseline BEFORE cutover

Before flipping DEPLOYMENT_ENV to production, ensure PRODUCTION-scoped kill switches exist and
match the Phase 21 baseline (pause flags enabled=true; PUBLIC_PAYOUT_LOGS_ENABLED=false).
Tooling: phase21-production-flag-baseline (DRY_RUN default; apply gated).

## Safe sequence (Owner §22) — do not execute here

1. Confirm source/preflight READY_FOR_OWNER_PROVISIONING_CEREMONY with Step 3A corrections PASS
2. Apply PRODUCTION flag baseline (ceremony-gated) — all pause flags true
3. Bootstrap Mainnet registry rows if missing (ceremony-gated; Owner-supplied Jetton master)
4. Offline Hot Wallet ceremony + signer host provisioning (separate Owner step)
5. Only then change DEPLOYMENT_ENV to production under Owner authorization
6. Keep PHASE21_MAINNET_ENABLED / real-chain / payout pauses fail-closed until later Owner steps

## Explicit non-goals for this document

- No Railway deploy
- No DEPLOYMENT_ENV flip in Step 3A
- No production-runtime branch move

## Step 3B tooling readiness

Ceremony APPLY is atomic and forceApply-free. See docs/PHASE_21_STEP3B_CEREMONY_TOOLING_HARDENING.md.
Do not execute APPLY against operational Postgres in Step 3B.
