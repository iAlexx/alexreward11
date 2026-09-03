# Local development

## Clean setup

From the repository root:

```powershell
Copy-Item .env.example .env
# Edit .env and replace SIGNER_SERVICE_TOKEN with a unique 32+ character local token.
# If host ports 5432 or 6379 are already occupied, change POSTGRES_HOST_PORT and
# REDIS_HOST_PORT and update the matching localhost ports in DATABASE_URL and REDIS_URL.
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
pnpm verify:local
pnpm dev:stack
pnpm smoke
```

The Compose application profile builds one pinned Node.js image and starts all six applications,
PostgreSQL, Redis, Temporal, Temporal UI, and the OpenTelemetry Collector. The local Bot transport
is deliberately disabled unless a developer supplies a separate non-production Telegram token.

## Configuration rules

`.env` is ignored. Only `.env.example` is tracked. `DEPLOYMENT_ENV=staging` or `production`
activates stricter endpoint, telemetry, and local-token rejection. Do not prefix server secrets
with `NEXT_PUBLIC_`; only public browser configuration is exposed to Next.js.

## Health checks

Each application exposes `/health/live` and `/health/ready`. API readiness verifies PostgreSQL,
Redis, and Temporal. Worker readiness verifies its Temporal worker is running. The smoke script
also executes `foundationProbe` end-to-end through Temporal.

## Common recovery

If an infrastructure service was still starting, wait until `docker compose ... ps` reports it
healthy and rerun `pnpm smoke`. Use `docker compose ... logs <service>` for diagnosis. Do not use
volume deletion as a routine restart mechanism.
