# Phase 21 Step 4C — Owner closeout and Hot Wallet readiness (source hardening)

**Date:** 2026-10-03  
**Scope:** Source hardening only. Cursor must not run real APPLY / register / fund. `production-runtime` is not modified.

## Step 4C.1 / 4C.2 / 4C.3 status

| Fact | Value |
| --- | --- |
| SOURCE_HARDENING_COMPLETE | YES (4C.1 + 4C.2 + 4C.3: production verified-pool Owner auth, no public test-pool backdoor, mandatory confirmations, live two-provider Mainnet registry verification trust, registry post-apply verify, Hot Wallet APPLY provenance/registry/audit/tx honesty) |
| OWNER_BOOTSTRAP | COMPLETE |
| HOT_WALLET_KEY_GENERATED | YES |
| HOT_WALLET_REGISTERED | NO |
| HOT_WALLET_FUNDED | NO |
| HOT_WALLET_OFFLINE_BACKUPS_READY | NO |
| MAINNET_REGISTRY_APPLIED | NO |
| SIGNER_PRODUCTION_HOST_PROVISIONED | NO |
| REAL_PAYOUT | NO |
| READY_FOR_LIVE_PAYOUT | NO |
| PHASE21_STATUS | IN_PROGRESS |

Steps 4C.1 / 4C.2 / 4C.3 do **not** claim Hot Wallet registered/funded, Mainnet registry applied, or live payout readiness.

## Canonical Owner closeout (sanitized)

| Fact | Value |
| --- | --- |
| PRODUCTION_OWNER_BOOTSTRAP | COMPLETE |
| OWNER_ADMIN_USER_ID | `a11a11a1-0000-4000-8000-000000000011` |
| OWNER_GRANT_ID | `e075fc33-ee46-4848-ac84-53c509adc96f` |
| OWNER_ATTEMPT_ID | `ccd4b016-6dd8-43a8-a536-ee341d2fad7e` |

Secrets, passphrases, TOTP seeds, and local encrypted bundle paths are never recorded here.

## Hot Wallet public identity (generated; not registered/funded)

| Fact | Value |
| --- | --- |
| Friendly | `EQD4NWgFbqCOIGQL9k0SDIP8onQH9cj_MxDcBr3N7DYLy8Lf` |
| Raw | `0:f83568056ea08e20640bf64d120c83fca27407f5c8ff3310dc06bdcdec360bcb` |
| Fingerprint SHA-256 | `e3e47c32acaed8912c4515618987d66d2c0ddc6d65c46cf16e293c7598e64093` |
| Encrypted bundle SHA-256 | `A0CD6CD1B871EA7664A4F66BB56CCB3794DA551C5D0E920ECDA2E188061E5C43` |
| REGISTERED | NO |
| FUNDED | NO |
| READY_FOR_LIVE_PAYOUT | NO |

## Authority model (Step 4C / 4C.1 / 4C.2 / 4C.3)

1. Canonical Owner seat = `admin_owner_authority.seat=1` holder + ACTIVE admin + ACTIVE unrevoked OWNER binding.
2. `PHASE21_CEREMONY_ADMIN_USER_ID` is a **locator only** — env UUID alone cannot authorize APPLY.
3. APPLY requires branded `AuthenticatedPhase21OwnerCeremonyTrust` minted only after Owner TTY password+TOTP via `authenticatePhase21OwnerCeremonyFromOwnerTty({ verifiedPool })`.
4. Production credential verification uses `verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool` on a WeakMap-bound production `verify_full` bootstrap pool. Generic `verifyOwnerAdminPasswordAndTotp` / `assertOwnerAdminAuthDatabaseWritable` remain test-DB-only and continue to refuse operational names.
5. Verified-pool test registration is **not** exported from `@alex-rewards/auth` package root; test-only module requires `NODE_ENV=test` + dual disposable gates + approved isolated DB names.
6. Auth anti-replay may mutate auth tables; that is distinct from Phase21 business mutation.
7. Tool confirmations / Hot Wallet backup attestations are WeakSet-branded objects; forged booleans cannot authorize. Flag / registry / Hot Wallet APPLY **require** branded confirmations (not optional).
8. Mainnet registry APPLY requires branded `AuthenticatedPhase21MainnetRegistryVerification` minted only after live two-provider PASS (`PHASE21_EXTERNAL_PROBE_LIVE=1`). Mock/skipped/incomplete/forged objects refuse. Exact master must bind through verification → PLAN → APPLY → DB.
9. APPLY uses a ceremony endpoint profile + verified TLS pool (`createPhase21CeremonyVerifiedPool`). `DATABASE_URL` alone is forbidden for APPLY. PLAN may still use `DATABASE_URL` (read-only).
10. APPLY gates require both `PHASE21_CEREMONY_REQUIRED_DATABASE_NAME` and `PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER`.
11. Hot Wallet APPLY requires `DUAL_PROVIDER_LIVE` with independent provider kinds + `verifiedAt`; OWNER_SUPPLIED_EVIDENCE refused. Prefer derivation proof FILE for APPLY readiness.
12. Hot Wallet PLAN verifies canonical registry truth (TON_MAINNET; USDT decimals=6 non-native non-null master; GRAM decimals=9 native null identity).
13. Post-registry and post-register verifies are read-only and require the intended audit rows.
14. Mutation catch paths track `NOT_STARTED | BEGUN | MUTATION_EXECUTED | COMMIT_CONFIRMED` and never claim rollback unless ROLLBACK succeeded.

## Hot Wallet readiness path (not executed here)

1. Offline identity proof from existing encrypted bundle: `pnpm phase21:hot-wallet:verify-identity` (apps/signer CLI; existing bundle only)
2. Dual-provider derivation proof with preserved `ownerAddress` + `jettonMaster`
3. Owner TTY auth + backup attestation phrase + register confirmation phrase
4. Gated register APPLY + read-only post-register verify
5. Funding / signer unlock / live payout remain later Owner steps

## Operational order (summary)

1. Owner bootstrap COMPLETE (closeout recorded above)
2. Hot Wallet offline backups later
3. Live two-provider Mainnet verification → branded Mainnet verification trust
4. Root-bound operational DB → Owner password+TOTP → fresh registry PLAN → exact confirmation → registry APPLY → read-only registry verify
5. Hot Wallet identity + derivation proofs → PLAN → separate Owner authorization → register → post-register verify
6. Signer provisioning / funding / live payout remain later separate Owner authorizations (`READY_FOR_LIVE_PAYOUT=NO`)

Phase 21 is **not** complete after Step 4C.


## Step 4C.3 note

Closed trust-mint forgery gap: public raw-result mint removed; registry APPLY uses package-private live verify+mint with concrete HTTP adapters + hardcoded freshness (<=120s). Diagnostic verify-mainnet-external JSON is not APPLY authority.
