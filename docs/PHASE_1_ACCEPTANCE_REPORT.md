# ALEx Rewards Phase 1 Acceptance Report

Status: **implementation complete; acceptance pending one host-dependent runtime gate**  
Date: 2026-09-03  
Source of truth: ALEx Rewards Master Product, Financial, Security & Engineering Specification v1.1

Phase 2 has not started. No ledger, reward issuance, withdrawal, AdsGram monetary, TON payout, or KMS-signing implementation is present.

## A. Exact repository tree

Generated artifacts (`node_modules`, `dist`, `.next`, `.turbo`), the local ignored `.env`, and Git internals are intentionally excluded. This is the exact source tree (177 files, including this report):

```text
alex-rewards/
├── .dockerignore
├── .editorconfig
├── .env.example
├── .github/workflows/ci.yaml
├── .gitignore
├── .node-version
├── .npmrc
├── .nvmrc
├── .prettierignore
├── .prettierrc.json
├── AGENTS.md
├── README.md
├── eslint.config.mjs
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── turbo.json
├── apps/
│   ├── admin/
│   │   ├── next-env.d.ts
│   │   ├── next.config.ts
│   │   ├── package.json
│   │   ├── postcss.config.mjs
│   │   ├── sentry.server.config.ts
│   │   ├── tsconfig.json
│   │   ├── src/instrumentation-client.ts
│   │   ├── src/instrumentation.ts
│   │   ├── src/lib/env.ts
│   │   ├── src/app/globals.css
│   │   ├── src/app/layout.tsx
│   │   ├── src/app/page.tsx
│   │   ├── src/app/api/health/live/route.ts
│   │   ├── src/app/api/health/ready/route.ts
│   │   └── test/health.test.ts
│   ├── api/
│   │   ├── package.json
│   │   ├── tsconfig.build.json
│   │   ├── tsconfig.json
│   │   ├── src/app.module.ts
│   │   ├── src/dependencies.service.ts
│   │   ├── src/health.controller.ts
│   │   ├── src/main.ts
│   │   ├── src/tokens.ts
│   │   └── test/health.test.ts
│   ├── bot/
│   │   ├── package.json
│   │   ├── tsconfig.build.json
│   │   ├── tsconfig.json
│   │   └── src/main.ts
│   ├── miniapp/
│   │   ├── next-env.d.ts
│   │   ├── next.config.ts
│   │   ├── package.json
│   │   ├── postcss.config.mjs
│   │   ├── sentry.server.config.ts
│   │   ├── tsconfig.json
│   │   ├── src/instrumentation-client.ts
│   │   ├── src/instrumentation.ts
│   │   ├── src/lib/env.ts
│   │   ├── src/app/globals.css
│   │   ├── src/app/layout.tsx
│   │   ├── src/app/page.tsx
│   │   ├── src/app/api/health/live/route.ts
│   │   ├── src/app/api/health/ready/route.ts
│   │   └── test/health.test.ts
│   ├── signer/
│   │   ├── package.json
│   │   ├── tsconfig.build.json
│   │   ├── tsconfig.json
│   │   ├── src/main.ts
│   │   ├── src/routes.ts
│   │   └── test/routes.test.ts
│   └── worker/
│       ├── package.json
│       ├── tsconfig.build.json
│       ├── tsconfig.json
│       ├── src/main.ts
│       ├── src/workflows.ts
│       └── test/workflows.test.ts
├── packages/
│   ├── ads/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── auth/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── config/{package.json,src/index.ts,test/config.test.ts,tsconfig.build.json,tsconfig.json}
│   ├── contracts/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── db/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── fraud/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── i18n/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── ledger/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── notifications/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── observability/{package.json,src/index.ts,test/logger.test.ts,tsconfig.build.json,tsconfig.json}
│   ├── referrals/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── rewards/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── support/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── tasks/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── telegram/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── ton/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── ui/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   ├── wallets/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
│   └── withdrawals/{package.json,src/index.ts,tsconfig.build.json,tsconfig.json}
├── docs/
│   ├── ADS_SPEC.md
│   ├── ARCHITECTURE.md
│   ├── DATABASE.md
│   ├── DECISIONS.md
│   ├── DISASTER_RECOVERY.md
│   ├── FAILURE_MATRIX.md
│   ├── FRAUD_SPEC.md
│   ├── INCIDENT_RESPONSE.md
│   ├── LEDGER_SPEC.md
│   ├── LOCAL_DEVELOPMENT.md
│   ├── OPERATIONS_RUNBOOK.md
│   ├── PHASE_1_ACCEPTANCE_REPORT.md
│   ├── PRODUCT_SPEC.md
│   ├── SECURITY.md
│   ├── TEST_PLAN.md
│   ├── TON_PAYOUT_SPEC.md
│   └── WITHDRAWAL_SPEC.md
├── infra/
│   ├── docker/Dockerfile
│   ├── docker/compose.yaml
│   ├── docker/otel-collector.yaml
│   └── terraform/README.md
├── migrations/README.md
└── scripts/
    ├── phase1-smoke.mjs
    ├── scan-secrets.mjs
    ├── validate-migrations.mjs
    └── verify-boundaries.mjs
```

## B. Exact dependency and runtime versions

Runtime/toolchain:

- Node.js `24.18.0`; pnpm `11.25.0`; TypeScript `6.0.3`; Turbo `2.10.12`.
- Docker base: `node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
- PostgreSQL `18.6@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280`.
- Redis `8.8.2@sha256:37227fff5638322f4ebea25d6d0dc3ee50848604e82b81426f11507b3ec7d2cc`.
- Temporal auto-setup `1.29.7@sha256:f14912b699cf73015ad5c4fc18d522d4b014db90e794039214dfb7c022c2644f`.
- Temporal UI `2.53.3@sha256:eef301146e60fad34b47adaecfae4149016e34b2d44ba94fca5fd8e5441f182a`.
- OpenTelemetry Collector contrib `0.159.0@sha256:1f2c54a30e713fac6b3ae77a1ec84010c2007e29ced8ec666214fc2f6739c1cc`.

Application/library pins:

```text
@eslint/js=10.0.1
@fastify/static=10.1.3
@nestjs/common=12.0.1
@nestjs/core=12.0.1
@nestjs/platform-fastify=12.0.1
@nestjs/swagger=12.0.1
@opentelemetry/api=1.9.1
@opentelemetry/auto-instrumentations-node=0.80.0
@opentelemetry/exporter-metrics-otlp-http=0.222.0
@opentelemetry/exporter-trace-otlp-http=0.222.0
@opentelemetry/sdk-metrics=2.11.0
@opentelemetry/sdk-node=0.222.0
@sentry/nextjs=10.73.0
@sentry/node=10.73.0
@tailwindcss/postcss=4.3.3
@tanstack/react-query=5.102.8
@temporalio/client=1.23.0
@temporalio/worker=1.23.0
@temporalio/workflow=1.23.0
@types/node=24.13.3
@types/pg=8.23.1
@types/react=19.2.18
@types/react-dom=19.2.5
cross-env=10.1.0
dependency-cruiser=18.2.0
dotenv-cli=11.0.0
eslint=10.9.1
fastify=5.12.1
grammy=1.46.0
ioredis=6.0.0
kysely=0.29.5
next=16.3.4
next-intl=4.14.2
pg=8.23.0
pino=10.3.1
prettier=3.9.6
react=19.2.8
react-dom=19.2.8
reflect-metadata=0.2.2
rxjs=7.8.2
tailwindcss=4.3.3
tsx=4.23.13
turbo=2.10.12
typescript=6.0.3
typescript-eslint=8.69.0
vitest=4.1.11
zod=4.5.4
```

Every manifest uses exact external versions; internal dependencies use `workspace:*`; the shared lockfile pins the complete transitive graph.

## C. Files and modules created

Section A is the complete file manifest. The six deployable boundaries are Mini App, Admin, API, Bot, Worker, and Signer. The 19 shared boundaries are auth, db, ledger, contracts, ads, rewards, wallets, withdrawals, ton, fraud, referrals, tasks, notifications, telegram, support, config, observability, i18n, and ui. Phase 2 business packages deliberately export only typed boundary metadata; they contain no placeholder business or financial behavior.

## D. Architecture decisions

- ESM-only, strict TypeScript, pnpm workspaces, and Turbo orchestration.
- NestJS/Fastify API; Fastify process shells for Bot, Worker health surface, and Signer; Next.js App Router for Mini App and Admin.
- Signer is an isolated deployable and dependency boundary. Phase 1 rejects KMS-related environment variables and exposes no signing route (`POST /sign` is `404`).
- API readiness checks PostgreSQL, Redis, and Temporal independently; liveness never depends on external services.
- Worker includes only a deterministic, non-business Temporal foundation workflow.
- No Phase 2 SQL exists. The migration validator is initialized and prohibits a mutable `users.balance` column.
- Docker images and GitHub Actions are immutable-pinned; containers run as non-root user `10001` with dropped capabilities, `no-new-privileges`, read-only filesystems, and temporary writable mounts.
- Frontend configuration has an explicit public-only allowlist. Server secrets are neither read nor bundled by frontend source.
- Next.js uses the supported `next start` output because the Phase 1 image contains the workspace rather than a pruned standalone artifact.

## E. Install, build, test, and run commands

```text
pnpm install --frozen-lockfile
pnpm verify:local
pnpm peers check
pnpm security:audit
docker compose -f infra/docker/compose.yaml --env-file .env --profile apps config --quiet
pnpm dev:infra
pnpm dev:stack
pnpm smoke
pnpm dev:stack:down
```

The first five commands were executed successfully. The last four require a running Docker engine; on this host the engine is currently unavailable.

## F. Tests and checks executed

- Formatting: passed.
- Lint: 29/29 tasks passed.
- Strict TypeScript checking: 29/29 tasks passed.
- Phase 1 tests: 12/12 assertions passed (configuration 5, observability 2, API 1, Worker 1, Signer 1, Mini App 1, Admin 1).
- Builds: 25/25 application/package builds passed, including both optimized Next.js builds.
- Workspace boundary check: passed (6 apps, 19 packages).
- Migration framework validation: passed with exactly 0 Phase 1 SQL migrations.
- Secret-pattern scan: passed.
- Dependency peer check: passed.
- High/critical dependency audit: no known vulnerabilities.
- Docker Compose model/configuration validation: passed.
- Live host boots: Mini App, Admin, API, Bot, and Signer passed. Worker boot is blocked until Temporal is available.
- Live endpoints: Mini App, Admin, Bot, and Signer liveness/readiness returned `200`; API liveness and Swagger returned `200`; API readiness correctly returned `503` with PostgreSQL, Redis, and Temporal individually unavailable.
- Signer negative check: `POST /sign` returned `404`.
- Graceful shutdown: Bot and Signer emitted start/complete shutdown events on `SIGINT`; shutdown coordinator race/idempotency behavior passed automated tests.
- Full Docker smoke: not executed because Docker Desktop's engine is not running.

## G. CI summary

GitHub Actions contains two least-privilege jobs. `quality` installs from the frozen lockfile, runs format/lint/typecheck/tests/builds/boundary/migration/secret checks, and performs a dependency audit. `docker-smoke` builds the pinned stack, waits for health, exercises the Phase 1 smoke suite, captures logs on failure, and removes CI volumes. Actions are pinned to commit SHAs. The workflow is locally/configurationally reviewed, but no GitHub remote run exists yet, so “CI is green” cannot honestly be asserted.

## H. Docker/local environment

Compose defines PostgreSQL, Redis, Temporal, Temporal UI, the OTel Collector, and all six apps. Service health checks, dependency ordering, isolated internal networks, named volumes, non-root application execution, read-only filesystems, and secret-free build context are configured. `.env` is ignored; `.env.example` contains local-only values.

The local Docker Desktop 4.80.0 / Engine 29.6.1 backend repeatedly exits while handling Windows AF_UNIX runtime sockets. `EnableDockerAI` was disabled, and two stale runtime directories were moved to recoverable timestamped backup names; no images, containers, volumes, or project data were deleted. The client currently hangs waiting for the unavailable engine.

## I. Health/readiness results

| Boundary | Liveness | Readiness | Result                                               |
| -------- | -------: | --------: | ---------------------------------------------------- |
| Mini App |      200 |       200 | Passed on host                                       |
| Admin    |      200 |       200 | Passed on host                                       |
| API      |      200 |       503 | Correct degradation; dependencies unavailable        |
| Bot      |      200 |       200 | Passed with transport intentionally disabled locally |
| Signer   |      200 |       200 | Passed; signing disabled                             |
| Worker   |  Not run |   Not run | Requires Temporal/Docker                             |

The full-stack gate requires all rows to pass readiness together and remains pending.

## J. Observability

The shared observability package initializes structured Pino logging, OpenTelemetry Node SDK auto-instrumentation, OTLP trace and metric exporters, Sentry Node integration, secret/header/token redaction, and an idempotent coordinated shutdown registry. Next.js has server and client Sentry/instrumentation entry points. The local OTel Collector is configured for OTLP HTTP/gRPC ingestion and debug export without credentials.

## K. Security and configuration safeguards

- Zod validation fails fast for missing, malformed, or unsafe environment values.
- Staging/production reject loopback dependency URLs and require OTel/Sentry configuration.
- Bot token is required only when polling is enabled; disabled mode is restricted to local development.
- Signer service token is length constrained; known sample values are rejected outside local development.
- Phase 1 explicitly rejects `SIGNER_KMS_KEY_ARN` and `AWS_KMS_KEY_ID` and has no AWS KMS dependency.
- Boundary validation prevents KMS imports outside Signer and prevents private environment reads in frontend source.
- Logs redact authorization, cookies, tokens, passwords, DSNs, and database/Redis URLs.
- Docker build context excludes `.env`; production secrets are absent from source and images.
- Package lifecycle scripts are allowlisted; Sentry CLI and telemetry-style Scarf scripts are denied.
- Migration validation prohibits `users.balance` and enforces the future migration file/transaction convention.

## L. Deviations from v1.1

None. Phase 2 financial and product behavior was intentionally not implemented. The inability to run the full local stack is a host-runtime failure, not an architectural deviation.

## M. Unresolved issues and technical debt

1. Repair or restart Docker Desktop/Windows, then run `pnpm dev:stack` followed by `pnpm smoke`.
2. Confirm PostgreSQL, Redis, Temporal, Worker, and all application readiness checks pass together.
3. Push the repository to GitHub and obtain a successful `quality` and `docker-smoke` run.

No source-level critical TODO, FIXME, placeholder security implementation, known high/critical dependency vulnerability, or Phase 2 shortcut remains.

## N. Acceptance conclusion

**Not every Phase 1 acceptance criterion has passed yet.** The implementation, static gates, package builds, configuration safeguards, and five independent service boots pass. The full Docker dependency stack, Worker runtime, end-to-end smoke suite, clean-clone Docker startup, and remote GitHub CI gates remain unverified because the local Docker engine is unavailable and no GitHub remote run exists.

Phase 1 must remain open, and Phase 2 must not begin, until those runtime gates pass.
