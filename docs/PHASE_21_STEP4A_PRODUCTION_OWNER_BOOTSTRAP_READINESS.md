# PHASE 21 — STEP 4A — Production First-Owner Trust Bootstrap Readiness

**Status:** SOURCE / TEST / READINESS ONLY  
**Date:** 2026-10-02  
**Branch:** `phase21-mainnet-micro-launch`  
**Step4:** `PAUSED_OWNER_AUTHORITY_REQUIRED`

## Why

Step4 correctly refused operational APPLY because operational DB `railway` has:

- 1 ACTIVE `admin_users` row (locator UUID only)
- `OWNER` role ACTIVE
- 0 `admin_role_bindings`
- vacant `admin_owner_authority` seat 1

No effective Owner exists. Ad-hoc SQL binding is forbidden.

## What Step4A delivered

Parallel **production** Owner-bootstrap path (does not weaken isolated tooling):

| Item | Value |
| --- | --- |
| Trust class | `production_sealed_v1` |
| Isolated CLI | `owner-bootstrap-ceremony` remains `ephemeral_isolated_test_only` |
| Production CLI | `owner-production-bootstrap` |
| Enrollment mode | `CLAIM_EXISTING_ADMIN` (no second admin INSERT) |
| Hot Wallet key reuse | FORBIDDEN |
| Real Owner key generated in Step4A | NO |
| Operational mutation in Step4A | NO |

## Required production trust resources (still missing for ceremony)

- Owner-operated offline Ed25519 bootstrap public key
- Owner-approved CA PEM + `tls_server_name`
- Production endpoint profile with **required** `expected_system_identifier`
- Independent human witness (not Cursor/system/Railway)
- Channel B Owner-typed offline digest
- Layer C/D provenance authentication (still unimplemented by design)

Therefore:

```text
PRODUCTION_OWNER_BOOTSTRAP_SOURCE_READY=YES
PRODUCTION_OWNER_BOOTSTRAP_TRUST_RESOURCES_READY=NO
READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO
```

## Hot Wallet (unchanged / separate)

Public Hot Wallet identity remains registered only after Owner authority exists (Step4 still paused). Bundle outside repo. Not used for Owner bootstrap.

## Commands (future ceremony — not executed here)

```text
pnpm --filter @alex-rewards/auth run owner-production-bootstrap -- readiness
pnpm --filter @alex-rewards/auth run owner-production-bootstrap -- generate-keypair ...
pnpm --filter @alex-rewards/auth run owner-production-bootstrap -- enroll-existing --apply
```

`enroll-existing` requires multi-gate APPLY and is refused by Step4A source policy even when gates are set.

See also: `docs/OWNER_ADMIN_PRODUCTION_BOOTSTRAP.md`

## Validation evidence (Step4A)

| Suite | Result |
| --- | --- |
| owner-production-bootstrap | PASS (12) |
| owner-bootstrap (incl. production) | PASS |
| M1 security gate | PASS (223) |
| M0 single-owner | PASS (30) |
| Phase21 tests | PASS |
| Boundaries | PASS |
| Migrations | PASS |
| Secret scan | PASS |
| Security audit | PASS (0 critical / 0 high; 4 moderate / 1 low pre-existing) |
| Auth typecheck/build | PASS |
| Workspace typecheck | PASS |
| Workspace build | ADMIN_NEXT_ENV_BLOCKED (pre-existing `NEXT_PUBLIC_API_BASE_URL`; auth packages built) |

Operational DB mutation: NO. Real Owner ceremony: NOT RUN.
