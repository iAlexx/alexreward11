# PHASE 21 — STEP 4A.1 — Production Owner Bootstrap Corrections

**Status:** SOURCE / TEST / READ-ONLY DISCOVERY ONLY  
**Date:** 2026-10-02  
**Parent:** Step4A `4d45757`  
**Step4:** `PAUSED_OWNER_AUTHORITY_REQUIRED`

## Findings addressed

| ID | Fix |
| --- | --- |
| P21-S4A1-001 | Explicit production lifecycle: `start/submit/abort/completeProductionOwnerBootstrap*` |
| P21-S4A1-002 | `AuthenticatedProductionBootstrapTrust` WeakSet brand; caller `trustClass` refused |
| P21-S4A1-003 | Session query uses `idle_expires_at` AND `absolute_expires_at`; query failure → `EXISTING_ADMIN_SECURITY_STATE_UNKNOWN` |
| P21-S4A1-004 | Full auth material inspection (PASSWORD/TOTP/WEBAUTHN/recovery/sessions/action tokens) |
| P21-S4A1-005 | `validateProductionCeremonyBundleStructurally` vs `authenticateProductionCeremonyFromOwnerTty`; `AllowsEnrollment` never succeeds unauthenticated |
| P21-S4A1-006 | `ProductionCeremonyBundleV1` root-binds intended admin; Channel B authenticates bundle digest |
| P21-S4A1-007 | Layer C/D = live Owner TTY offline digest; same-host Channel B file documentary only |
| P21-S4A1-008 | `WITNESS_MODEL=HUMAN_ATTESTED`; crypto identity proven=NO |
| P21-S4A1-009 | Keygen requires `--phase21-production-owner-bootstrap` + interactive TTY |
| P21-S4A1-010 | Schema migration preflight (0024/0025/0026/0028) read-only |
| P21-S4A1-011–013 | Production TX recheck under lock; grant/trust consistency; production TLS assert on bound trust |
| P21-S4A1-016 | Readiness derived, not hardcoded ceremony-ready |

## Readiness (honest)

```text
PRODUCTION_OWNER_BOOTSTRAP_SOURCE_READY=YES (capabilities present)
PRODUCTION_OWNER_BOOTSTRAP_TRUST_RESOURCES_READY=NO
PRODUCTION_OWNER_BOOTSTRAP_ENDPOINT_TRUST_READY=NO
READY_FOR_PRODUCTION_OWNER_BOOTSTRAP_CEREMONY=NO
```

## Not executed

Real Owner key, seal, grant, binding, seat claim, credential mutation, Railway changes, Hot Wallet, Step4 APPLY.

## Railway endpoint reality (read-only)

Variable inventory on Postgres service shows `DATABASE_URL` / `PGHOST=postgres.railway.internal` only.
`DATABASE_PUBLIC_URL` is absent.

`	ext
RAILWAY_POSTGRES_PUBLIC_ENDPOINT_CURRENTLY_AVAILABLE=NO
DISCOVERY_ONLY_NOT_TRUST_AUTHORITY=YES (connect tunnel must not be ceremony trust)
`

Deep live credential/session counts against ops DB were not re-probed without a trust-satisfying endpoint (TCP Proxy not enabled).

## Validation evidence

| Suite | Result |
| --- | --- |
| owner-production-bootstrap | PASS (12) |
| M1 security gate | PASS (223) |
| M0 single-owner | PASS (30) |
| Phase21 tests | PASS |
| Boundaries / migrations / secrets | PASS |
| Security audit | PASS (0 critical / 0 high) |
| Auth typecheck/build | PASS |
