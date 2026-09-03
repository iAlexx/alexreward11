# Phase 1 test plan

The Phase 1 gate runs formatting, lint, strict TypeScript checks, unit tests, builds, architecture
boundary validation, migration-file validation, secret scanning, dependency audit, and a Docker
smoke test. The smoke test validates every application liveness/readiness route and executes the
non-business `foundationProbe` workflow through Temporal.
