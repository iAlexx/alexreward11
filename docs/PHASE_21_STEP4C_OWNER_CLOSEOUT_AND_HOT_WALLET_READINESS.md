# Phase 21 Step 4C — Owner closeout and Hot Wallet readiness (source hardening)

**Date:** 2026-10-03  
**Scope:** Source hardening only. Cursor must not run real APPLY / register / fund. `production-runtime` is not modified.

## Step 4C.1 status

| Fact | Value |
| --- | --- |
| SOURCE_HARDENING_COMPLETE | YES (Step 4C.1 corrections: production verified-pool Owner auth, mandatory confirmations, Hot Wallet APPLY provenance/registry/audit/tx honesty) |
| OWNER_BOOTSTRAP | COMPLETE |
| HOT_WALLET_KEY_GENERATED | YES |
| HOT_WALLET_REGISTERED | NO |
| HOT_WALLET_FUNDED | NO |
| MAINNET_REGISTRY_APPLIED | NO |
| SIGNER_PRODUCTION_HOST_PROVISIONED | NO |
| REAL_PAYOUT | NO |
| READY_FOR_LIVE_PAYOUT | NO |
| PHASE21_STATUS | IN_PROGRESS |

Step 4C.1 does **not** claim Hot Wallet registered/funded, Mainnet registry applied, or live payout readiness.

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

## Authority model (Step 4C / 4C.1)

1. Canonical Owner seat = `admin_owner_authority.seat=1` holder + ACTIVE admin + ACTIVE unrevoked OWNER binding.
2. `PHASE21_CEREMONY_ADMIN_USER_ID` is a **locator only** — env UUID alone cannot authorize APPLY.
3. APPLY requires branded `AuthenticatedPhase21OwnerCeremonyTrust` minted only after Owner TTY password+TOTP via `authenticatePhase21OwnerCeremonyFromOwnerTty({ verifiedPool })`.
4. Production credential verification uses `verifyProductionOwnerPasswordAndTotpOnVerifiedBootstrapPool` on a WeakMap-bound production `verify_full` bootstrap pool. Generic `verifyOwnerAdminPasswordAndTotp` / `assertOwnerAdminAuthDatabaseWritable` remain test-DB-only and continue to refuse operational names.
5. Auth anti-replay may mutate auth tables; that is distinct from Phase21 business mutation.
6. Tool confirmations / Hot Wallet backup attestations are WeakSet-branded objects; forged booleans cannot authorize. Flag / registry / Hot Wallet APPLY **require** branded confirmations (not optional).
7. APPLY uses a ceremony endpoint profile + verified TLS pool (`createPhase21CeremonyVerifiedPool`). `DATABASE_URL` alone is forbidden for APPLY. PLAN may still use `DATABASE_URL` (read-only).
8. APPLY gates require both `PHASE21_CEREMONY_REQUIRED_DATABASE_NAME` and `PHASE21_CEREMONY_REQUIRED_SYSTEM_IDENTIFIER`.
9. Hot Wallet APPLY requires `DUAL_PROVIDER_LIVE` with independent provider kinds + `verifiedAt`; OWNER_SUPPLIED_EVIDENCE refused. Prefer derivation proof FILE for APPLY readiness.
10. Hot Wallet PLAN verifies canonical registry truth (TON_MAINNET; USDT decimals=6 non-native non-null master; GRAM decimals=9 native null identity).
11. Post-register verify is read-only and requires the intended `phase21.hot_wallet.register` audit row.
12. Mutation catch paths track `NOT_STARTED | BEGUN | MUTATION_EXECUTED | COMMIT_CONFIRMED` and never claim rollback unless ROLLBACK succeeded.

## Hot Wallet readiness path (not executed here)

1. Offline identity proof from existing encrypted bundle: `pnpm phase21:hot-wallet:verify-identity` (apps/signer CLI; existing bundle only)
2. Dual-provider derivation proof with preserved `ownerAddress` + `jettonMaster`
3. Owner TTY auth + backup attestation phrase + register confirmation phrase
4. Gated register APPLY + read-only post-register verify
5. Funding / signer unlock / live payout remain later Owner steps

## Operational order (summary)

1. Owner bootstrap COMPLETE (closeout recorded above)
2. Production flag baseline / Mainnet registry APPLY only via verified pool + branded trust (if not already applied offline by Owner)
3. Hot Wallet identity proof + derivation proof
4. Hot Wallet register (still leaves READY_FOR_LIVE_PAYOUT=NO)
5. Funding / live payout enablement remain blocked

Phase 21 is **not** complete after Step 4C.
