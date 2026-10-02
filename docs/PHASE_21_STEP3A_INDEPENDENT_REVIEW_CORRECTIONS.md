# Phase 21 Step 3A — Independent Review Source Corrections

**Status:** SOURCE_CORRECTIONS implemented (not operationally executed)
**Scope:** SOURCE / TEST / READINESS ONLY
**Forbidden in Step 3A:** deploy, real keys, operational DB mutation, payout

## Defects corrected

| ID | Summary |
| --- | --- |
| P21-S3A-001 | Controlled provision env modes (test vs production operational ceremony) |
| P21-S3A-002 | Honest fee estimator (MOCK / LIVE_READ_ONLY / UNAVAILABLE) |
| P21-S3A-003 | Production env cutover docs + wallet environment matrix tests |
| P21-S3A-004 | External verifier hardening (independence + provenance + fail-closed) |

## Additional Step 3A hardening

- WITHDRAWAL_REQUESTS_PAUSE fail-closed when missing in STAGING/PRODUCTION
- PRODUCTION safety flag baseline tooling (DRY_RUN default)
- Mainnet registry bootstrap tooling (DRY_RUN default)
- Offline Mainnet key CLI collects passphrase before seed generation
- Preflight requires Step 3A source-correction readiness items before READY_FOR_OWNER_PROVISIONING_CEREMONY
- READY_FOR_LIVE_PAYOUT remains always false

## Explicit non-execution

Step 3A does **not** authorize:

1. Enabling PHASE21_OPERATIONAL_CEREMONY_ENABLED against operational Postgres
2. Applying PRODUCTION flag baseline or registry bootstrap to ops DB
3. Live Mainnet RPC / fee estimation against production providers
4. Hot Wallet ceremony with real keys
5. Any payout / broadcast / Available provision on operational ledger

See also: PHASE_21_PRODUCTION_ENVIRONMENT_CUTOVER.md, PHASE_21_MAINNET_REGISTRY_BOOTSTRAP.md,
PHASE_21_PRODUCTION_POLICY_ENVIRONMENT_MAPPING.md.
