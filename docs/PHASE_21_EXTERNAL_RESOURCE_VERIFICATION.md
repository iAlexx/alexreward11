# Phase 21 - External Resource Verification (Read-Only)

Helpers in packages/withdrawals/src/phase21-external-probes.ts.

## Static validation

- Jetton master parse + forbidden placeholder rejection
- Provider independence (kind+url not identical)

## Optional live probes

HTTP reachability only when PHASE21_EXTERNAL_PROBE_LIVE=1. No sendBoc. Unit tests mock by default.
