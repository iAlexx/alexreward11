# Phase 1 test plan

The Phase 1 gate runs formatting, lint, strict TypeScript checks, unit tests, builds, architecture
boundary validation, migration-file validation, secret scanning, dependency audit, and a Docker
smoke test. The smoke test validates every application liveness/readiness route and executes the
non-business `foundationProbe` workflow through Temporal.

## Phase 11 — advertising certification gate

```bash
pnpm test:phase11
# PHASE11_DATABASE_URL=... or PHASE11_ADS_TESTS=1 + DATABASE_URL
```

Real PostgreSQL through `resetAndMigrate` (destructive; the database-name guard refuses anything
that is not a `_test` / `_phaseN` database). No mock data, no stubbed ledger.

| Suite                            | Proves                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `phase11-certification.test.ts`  | Owner TEST 1–20 against live schema, sessions, gate and ledger               |
| `phase11-limits-version.test.ts` | REQUEST 30 → 100 through a new approved rule version only; SUCCESS stays 25  |
| `phase11-boundaries.test.ts`     | `packages/ads` source never imports the ledger or posts a ledger transaction |

TEST 14 asserts that AdsGram is refused production money even with complete, correlated evidence.
TEST 16 needs a provider that the gate _accepts_, to prove the gate is provider-neutral rather
than simply always-closed; that provider (`HARNESS_CERT`) exists only in the test harness and is
registered for the duration of the run. It is never seeded by a migration and never ships.

The certification harness itself (`runProviderCertificationCases`) is graded strictly: a skipped
mandatory case is not a pass, and `productionMonetaryApprovalRecommended` stays false unless every
mandatory case passed on evidence (TEST 19).
