# Phase 21 Step 3B ? Ceremony Tooling Hardening

**Status:** SOURCE / TEST / READINESS implemented ? **not operationally executed**
**Scope:** ceremony tooling only
**Forbidden:** deploy, real keys, operational DB mutation, funding, payout

## Defects / hardening IDs

| ID | Summary |
| --- | --- |
| P21-S3B-001 | Remove `forceApply`; APPLY only via production ceremony env gates + DB identity |
| P21-S3B-002 | Atomic PRODUCTION flag baseline (txn + advisory lock + versions + audit) |
| P21-S3B-003 | Atomic Mainnet registry one-pass (zero ? complete in one APPLY) |
| P21-S3B-004 | Concrete Mainnet Toncenter/TonAPI read-only adapters (no `sendBoc`) |
| P21-S3B-005 | Concrete Toncenter Mainnet fee provider (`LIVE_READ_ONLY` / `UNAVAILABLE`) |
| Hot wallet | Gated registration tooling; Owner-supplied addresses only |

## APPLY gates (all required)

1. `DEPLOYMENT_ENV=production` (staging refuses APPLY)
2. `PHASE21_OPERATIONAL_CEREMONY_ENABLED=true`
3. Tool-specific `*_APPLY=1`
4. `PHASE21_CEREMONY_REQUIRED_DATABASE_NAME` matches `current_database()`
5. CLI APPLY commands also require explicit `--apply` argv

PLAN commands are read-only and do not require apply gates.

## CLI / scripts

```
phase21:production-flags:plan
phase21:production-flags:apply
phase21:mainnet-registry:plan
phase21:mainnet-registry:apply
phase21:verify-mainnet-external
phase21:estimate-mainnet-fee
phase21:hot-wallet:plan
phase21:hot-wallet:register
```

## Readiness observations (Step 3B)

- `forceApplyRemoved`
- `productionFlagBaselineAtomic`
- `mainnetRegistryOnePassAtomic`
- `concreteExternalAdaptersReady`
- `concreteFeeAdapterReady`
- `hotWalletRegistrationToolReady`

`READY_FOR_OWNER_PROVISIONING_CEREMONY` requires these PASS.
`READY_FOR_LIVE_PAYOUT` remains **always false**.

## Explicit non-execution

Step 3B does **not** authorize:

1. Enabling ceremony gates against operational Postgres
2. Applying flag baseline / registry / hot wallet to ops DB
3. Live Mainnet funding or payout
4. Moving `production-runtime`

See also: `PHASE_21_PROVISIONING_CEREMONY_PREFLIGHT.md`, `PHASE_21_MAINNET_REGISTRY_BOOTSTRAP.md`.
